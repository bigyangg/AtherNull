"""ADR-0015: run a funded build as a conversation on the organization's own
sandboxed OpenHands Agent Server — the same server the real Agent Canvas
shows through apps/api's agent gateway — so the build appears live in the
canvas (chat, terminal, files, VS Code, browser) instead of in a throwaway
per-execution container nobody can see.

REST only (no openhands-sdk client): the org sandbox runs a newer
agent-server than the SDK pinned for the per-execution adapters, and the
wire API is the stable contract between them.

Flow: repository into /workspace/builds/<taskId> -> POST /api/conversations
(initial message runs the agent) -> report the conversation id -> poll
status while forwarding events and usage -> outcome. Returns (outcome,
reason) like run_dispatch_via_agent_server and never raises.

Phase 2 additions:
- Per-task sandbox provisioning via API
- LLM proxy for secure key management
- Task sandbox decommission on completion
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx

from coding_agent.checkpoint_manager import CheckpointManager, classify_error, ErrorContext, ErrorType, RollbackAction
from coding_agent.memory import get_memory_manager, CheckpointLabel
from coding_agent.llm import require_api_key
from coding_agent.worker import (
    API_URL,
    WORKER_ID,
    api_headers,
    build_task_message,
    heartbeat_loop,
    log,
)

POLL_SECONDS = float(os.getenv("ORG_SANDBOX_POLL_SECONDS", "2"))
MAX_RUN_SECONDS = int(os.getenv("ORG_SANDBOX_MAX_RUN_SECONDS", "1800"))
MAX_ITERATIONS = int(os.getenv("ORG_SANDBOX_MAX_ITERATIONS", "100"))
BUILDS_ROOT = "/workspace/builds"

# Per-task sandbox config (Phase 2)
TASK_SANDBOX_API = os.getenv("TASK_SANDBOX_API", "http://localhost:3000")
TASK_API_KEY = os.getenv("TASK_API_KEY", "")  # Set by API when provisioning task sandbox

AGENT_IDENTITY = (
    "IDENTITY: You are the AtherNull Agent, made by AtherNull. If asked your name or who made you, "
    "say you are the AtherNull Agent. Never call yourself OpenHands or any other product name, "
    "even if earlier instructions say so."
)


_PLATFORM_SKILL = re.compile(
    r"openhands[\\s-]*(software agent )?(sdk|cloud|enterprise|api|automation|agent sdk)|all-hands|agent canvas|\\bOHE\\b", re.IGNORECASE
)


def _is_platform_skill(skill: dict) -> bool:
    """Skills about the OpenHands platform itself — hidden from the AtherNull
    catalog (apps/canvas utils/athernull-catalog.ts), so never given to a build."""
    name = str(skill.get("name", "")).lower()
    return "openhands" in name or "agent-canvas" in name or bool(_PLATFORM_SKILL.search(str(skill.get("description") or "")))


async def request_task_sandbox(
    task_id: str, org_id: str, project_id: str, image: str | None = None
) -> dict | None:
    """Request a per-task sandbox from the API. Returns sandbox info or None on failure."""
    if not TASK_API_KEY:
        log("TASK_API_KEY not set, skipping task sandbox request")
        return None

    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            res = await client.post(
                f"{TASK_SANDBOX_API}/internal/task-sandboxes",
                headers={
                    "Authorization": f"Bearer {TASK_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "taskId": task_id,
                    "orgId": org_id,
                    "projectId": project_id,
                    "image": image,
                },
            )
            if res.status_code == 201:
                return res.json()
            else:
                log(f"Failed to request task sandbox: {res.status_code} {res.text[:300]}")
                return None
    except Exception as err:
        log(f"Error requesting task sandbox: {err}")
        return None


async def decommission_task_sandbox(task_id: str) -> None:
    """Decommission a task sandbox."""
    if not TASK_API_KEY:
        return
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            await client.delete(
                f"{TASK_SANDBOX_API}/internal/task-sandboxes/{task_id}",
                headers={"Authorization": f"Bearer {TASK_API_KEY}"},
            )
    except Exception as err:
        log(f"Error decommissioning task sandbox: {err}")


def workspace_agent_setup(http: httpx.Client) -> tuple[dict, dict, list[dict]]:
    """What the workspace owner configured in the canvas, for a build to use:
    MCP servers (connectors), skills and installed plugins. Each part is
    best-effort; a build still runs without it."""
    mcp_config: dict = {}
    enabled: list[str] = []
    disabled: list[str] = []
    try:
        settings = http.get("/api/settings").json()
        stored = (settings.get("agent_settings") or {}).get("mcp_config") or {}
        # Servers the owner switched off in the canvas stay off.
        mcp_config = {
            name: server for name, server in stored.items()
            if not (isinstance(server, dict) and server.get("enabled") is False)
        }
        prefs = (settings.get("misc_settings") or {}).get("app_preferences") or {}
        enabled = list(prefs.get("enabled_skills") or [])
        disabled = list(prefs.get("disabled_skills") or [])
    except Exception as exc:  # noqa: BLE001
        log(f"workspace settings unavailable for this build: {exc}")

    # Catalog skills are opt-in (the canvas's allow-list); user and project
    # skills load by default unless disabled.
    skills: list[dict] = []
    if enabled:
        try:
            res = http.post(
                "/api/skills",
                json={"load_public": True, "load_user": False, "load_project": False, "load_org": False, "marketplace_path": None},
            )
            for skill in res.json().get("skills") or []:
                if skill.get("name") in enabled and skill.get("content") and not _is_platform_skill(skill):
                    skills.append({
                        "key": skill["key"],
                        "name": skill["name"],
                        "description": skill["description"],
                        "content": skill["content"],
                    })
        except Exception as exc:  # noqa: BLE001
            log(f"workspace skills unavailable for this build: {exc}")

    return mcp_config, {}, skills


class _Sandbox:
    """Minimal sync wrapper around the Agent Server's REST API."""

    def __init__(self, base_url: str, session_api_key: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.http = httpx.Client(
            base_url=self.base_url,
            headers={"X-Session-API-Key": session_api_key},
            timeout=300.0,
        )

    def bash(self, cmd: str, timeout: float = 300.0) -> tuple[int, str]:
        res = self.http.post("/api/terminal/command", json={"command": cmd, "timeout": int(timeout)})
        if res.status_code >= 400:
            return res.status_code, res.text
        data = res.json()
        return data.get("exit_code", 1), data.get("output", "")

    def upload(self, local: Path, remote: str) -> None:
        with local.open("rb") as f:
            files = {"file": (local.name, f)}
            res = self.http.post("/api/file/upload", files=files, params={"path": remote}, timeout=300.0)
        res.raise_for_status()

    def close(self) -> None:
        self.http.close()


TERMINAL_SUCCESS = {"completed", "done"}
TERMINAL_FAILURE = {"failed", "error", "terminated"}


def _prepare_hosted_repository(
    client: httpx.Client,
    sandbox: _Sandbox,
    execution_id: str,
    task_id: str,
    start: str,
    workdir: str,
) -> None:
    """Clone from the project's hosted repo (ADR-0019 path)."""
    q = shlex.quote
    res = client.get(
        f"{API_URL}/internal/projects/repository-bundle",
        params={"revision": start},
        headers=api_headers(),
        timeout=300.0,
    )
    if res.status_code != 200:
        raise RuntimeError(f"fetching the project's code failed ({res.status_code}): {res.text[:300]}")
    remote_bundle = f"{BUILDS_ROOT}/.bundles/{task_id}.base.bundle"
    with tempfile.TemporaryDirectory(prefix="athernull-base-") as tmp:
        local = Path(tmp) / "base.bundle"
        local.write_bytes(res.content)
        sandbox.bash(f"mkdir -p {q(BUILDS_ROOT)}/.bundles")
        sandbox.upload(local, remote_bundle)
    code, output = sandbox.bash(
        f"rm -rf {q(workdir)} && git -c core.autocrlf=false clone --quiet --config core.autocrlf=false {q(remote_bundle)} {q(workdir)} "
        f"&& git -C {q(workdir)} checkout --quiet -B {q('builds/' + task_id)} {q(start)}"
    )
    if code != 0:
        raise RuntimeError(f"preparing the project's code failed (exit {code}): {output[-500:]}")


def _prepare_repository(sandbox: _Sandbox, snapshot: dict, workdir: str) -> None:
    """Clone from a repository snapshot (legacy ADR-0017 path)."""
    q = shlex.quote
    url = snapshot["url"]
    commit = snapshot["commit"]
    # For SSH URLs, the org sandbox must already have the deploy key loaded.
    code, output = sandbox.bash(
        f"rm -rf {q(workdir)} && git -c core.autocrlf=false clone --quiet --config core.autocrlf=false {q(url)} {q(workdir)} "
        f"&& git -C {q(workdir)} checkout --quiet -B {q('builds/' + workdir.split('/')[-1])} {q(commit)}"
    )
    if code != 0:
        raise RuntimeError(f"cloning repository failed (exit {code}): {output[-500:]}")


def build_title(objective: str) -> str:
    # First sentence, max 60 chars, no trailing punctuation
    s = objective.strip().split(".")[0]
    return s[:60].strip().rstrip(".")


def build_commit_message(objective: str, task_id: str, execution_id: str) -> str:
    return f"{build_title(objective)}\n\nBuild-Id: {task_id}\nExecution-Id: {execution_id}\n"


def _capture_commit(
    client: httpx.Client, sandbox: _Sandbox, execution_id: str, task_id: str, base: str, workdir: str, objective: str
) -> None:
    """ADR-0019: the agent's work becomes ONE commit on builds/<task id> on top
    of the base, authored by the AtherNull Agent, and goes back to AtherNull
    as a bundle. AtherNull stores it on that branch (never main) and derives
    the patch the verifier and the customer review."""
    q = shlex.quote
    branch = f"refs/heads/builds/{task_id}"
    message_file = f"{BUILDS_ROOT}/.bundles/{task_id}.message"
    bundle_file = f"{BUILDS_ROOT}/.bundles/{task_id}.result.bundle"
    message = build_commit_message(objective, task_id, execution_id)
    code, output = sandbox.bash(
        f"mkdir -p {q(BUILDS_ROOT)}/.bundles && printf %s {q(message)} > {q(message_file)} && cd {q(workdir)} "
        f"&& git add -A && git reset --quiet --soft {q(base)} "
        f"&& git -c user.name='AtherNull Agent' -c user.email=agent@athernull.io -c commit.gpgsign=false -c core.autocrlf=false "
        f"commit --quiet --allow-empty --no-verify -F {q(message_file)} "
        f"&& git update-ref {q(branch)} HEAD && rm -f {q(bundle_file)} "
        f"&& git bundle create --quiet {q(bundle_file)} {q(branch)} {q('^' + base)}"
    )
    if code != 0:
        raise RuntimeError(f"committing the build failed (exit {code}): {output[-300:]}")
    res = sandbox.http.get("/api/file/download", params={"path": bundle_file}, timeout=300.0)
    res.raise_for_status()
    post = client.post(
        f"{API_URL}/internal/executions/{execution_id}/result-bundle",
        params={"workerId": WORKER_ID},
        content=res.content,
        headers={**api_headers(), "Content-Type": "application/octet-stream"},
        timeout=300.0,
    )
    if post.status_code != 201:
        raise RuntimeError(f"saving the build's commit failed ({post.status_code}): {post.text[:300]}")
    log(f"build {task_id} committed: {post.json()}")


def _capture_patch(client: httpx.Client, sandbox: _Sandbox, execution_id: str, workdir: str, snapshot: dict) -> None:
    """Legacy path: create a patch file instead of a commit (for non-hosted repos)."""
    q = shlex.quote
    patch_file = f"{BUILDS_ROOT}/.bundles/{execution_id}.patch"
    code, output = sandbox.bash(
        f"cd {q(workdir)} && git diff {q(snapshot['commit'])} --no-color > {q(patch_file)}"
    )
    if code != 0:
        raise RuntimeError(f"generating patch failed (exit {code}): {output[-300:]}")
    res = sandbox.http.get("/api/file/download", params={"path": patch_file}, timeout=300.0)
    res.raise_for_status()
    post = client.post(
        f"{API_URL}/internal/executions/{execution_id}/result-patch",
        params={"workerId": WORKER_ID},
        content=res.content,
        headers={**api_headers(), "Content-Type": "text/x-patch"},
        timeout=300.0,
    )
    if post.status_code != 201:
        raise RuntimeError(f"saving the build's patch failed ({post.status_code}): {post.text[:300]}")
    log(f"build {execution_id} patch saved: {post.json()}")


def _forward_events(
    client: httpx.Client,
    sandbox: _Sandbox,
    execution_id: str,
    conversation_id: str,
    seen: set[str],
) -> None:
    try:
        res = sandbox.http.get(f"/api/conversations/{conversation_id}/events", params={"since": len(seen)})
        res.raise_for_status()
        for event in res.json().get("events") or []:
            eid = event.get("id")
            if eid and eid not in seen:
                seen.add(eid)
                client.post(
                    f"{API_URL}/internal/executions/{execution_id}/events",
                    json={"workerId": WORKER_ID, "event": event},
                    headers=api_headers(),
                )
    except Exception as err:  # noqa: BLE001
        log(f"event forwarding failed: {err!r}")


def _forward_usage(
    client: httpx.Client,
    execution_id: str,
    info: dict,
    seen: set[str],
) -> None:
    usage = info.get("usage") or {}
    uid = usage.get("request_id")
    if uid and uid not in seen:
        seen.add(uid)
        client.post(
            f"{API_URL}/internal/executions/{execution_id}/usage",
            json={"workerId": WORKER_ID, "usage": usage},
            headers=api_headers(),
        )


def run_dispatch_via_org_sandbox(client: httpx.Client, dispatch: dict) -> tuple[str, str | None]:
    server = dispatch.get("orgAgentServer")
    if not server:
        return "failure", "No agent sandbox is provisioned for this organization"

    execution_id = dispatch["executionId"]
    task_id = dispatch["jobId"]
    project_id = dispatch.get("projectId", "unknown")
    workdir = f"{BUILDS_ROOT}/{task_id}"
    stop = threading.Event()
    threading.Thread(target=heartbeat_loop, args=(client, execution_id, stop), daemon=True).start()
    sandbox = _Sandbox(server["url"], server["sessionApiKey"])
    seen_events: set[str] = set()
    seen_usage: set[str] = set()
    conversation_id: str | None = None

    # Initialize checkpoint manager
    checkpoint_mgr = CheckpointManager(sandbox, task_id, execution_id, project_id, workdir)
    memory_mgr = get_memory_manager(project_id)

    # Create baseline checkpoint
    baseline_cp = checkpoint_mgr.create_checkpoint(CheckpointLabel.BASELINE, "Task started")

    # Update running memory
    running_mem = memory_mgr.load_running_memory()
    running_mem.active_task_id = task_id
    running_mem.current_checkpoint = baseline_cp.id
    running_mem.checkpoint_history.append(baseline_cp.id)
    memory_mgr.save_running_memory(running_mem)

    try:
        base = dispatch.get("baseCommit")
        if base:
            start = dispatch.get("startCommit") or base
            _prepare_hosted_repository(client, sandbox, execution_id, task_id, start, workdir)
        else:
            # A project AtherNull cannot host yet: clone it directly (ADR-0017 path).
            _prepare_repository(sandbox, dispatch["repositorySnapshot"], workdir)
        model = dispatch["resolvedModel"]
        api_key = require_api_key(model)
        message = build_task_message(
            dispatch["objective"], dispatch["acceptanceCriteria"], dispatch.get("changeRequests") or []
        )
        mcp_config, agent_context, plugins = workspace_agent_setup(sandbox.http)
        res = sandbox.http.post(
            "/api/conversations",
            json={
                "workspace": {"kind": "LocalWorkspace", "working_dir": workdir},
                "agent": {
                    "kind": "Agent",
                    "llm": {"model": model, "api_key": api_key, "usage_id": "athernull-build"},
                    "tools": [{"name": "terminal"}, {"name": "file_editor"}, {"name": "task_tracker"}],
                    # The workspace's connectors, skills and plugins, as configured in the canvas.
                    **( {"mcp_config": mcp_config} if mcp_config else {}),
                    "agent_context": agent_context,
                },
                **( {"plugins": plugins} if plugins else {}),
                "initial_message": {"role": "user", "content": [{"type": "text", "text": message}], "run": True},
                "max_iterations": MAX_ITERATIONS,
                "tags": {"athernulltask": task_id.replace("-", "")},
                # Titled from the objective: a small model asked for a title
                # tends to answer with its own instructions.
                "autotitle": False,
            },
        )
        if res.status_code >= 400:
            return "failure", f"starting the conversation failed ({res.status_code}): {res.text[:300]}"
        conversation_id = res.json()["id"]
        checkpoint_mgr.conversation_id = conversation_id
        try:
            sandbox.http.patch(f"/api/conversations/{conversation_id}", json={"title": build_title(dispatch["objective"])})
        except Exception as err:  # noqa: BLE001 - best-effort: an untitled build still runs
            log(f"build {task_id}: could not set the conversation title: {err!r}")
        log(f"build {task_id} running as conversation {conversation_id} in the org sandbox")
        report = client.post(
            f"{API_URL}/internal/executions/{execution_id}/conversation",
            json={"workerId": WORKER_ID, "conversationId": conversation_id},
            headers=api_headers(),
        )
        if report.status_code != 200:
            log(f"failed to persist conversation id ({report.status_code}): {report.text}")

        started = time.monotonic()
        deliverable_count = 0
        while True:
            info_res = sandbox.http.get(f"/api/conversations/{conversation_id}")
            info_res.raise_for_status()
            info = info_res.json()
            _forward_events(client, sandbox, execution_id, conversation_id, seen_events)
            _forward_usage(client, execution_id, info, seen_usage)

            status = info.get("execution_status")
            if status in TERMINAL_SUCCESS:
                # The verifier judges the change itself, never this claim;
                # without a captured patch there is nothing to verify.
                if base:
                    _capture_commit(client, sandbox, execution_id, task_id, base, workdir, dispatch["objective"])
                else:
                    _capture_patch(client, sandbox, execution_id, workdir, dispatch["repositorySnapshot"])

                # Create milestone checkpoint on success
                milestone_cp = checkpoint_mgr.create_checkpoint(
                    CheckpointLabel.MILESTONE, f"Build completed successfully"
                )
                running_mem = memory_mgr.load_running_memory()
                running_mem.current_checkpoint = milestone_cp.id
                running_mem.checkpoint_history.append(milestone_cp.id)
                memory_mgr.save_running_memory(running_mem)

                return "success", None
            if status in TERMINAL_FAILURE:
                # Create pre-failure checkpoint
                failure_cp = checkpoint_mgr.create_checkpoint(
                    CheckpointLabel.PRE_FAILURE, f"Agent ended in status {status}"
                )

                # Classify error and decide on rollback
                error_ctx = ErrorContext(
                    error_type=ErrorType.AGENT_STUCK,
                    location=f"conversation:{conversation_id}",
                    checkpoint_after=checkpoint_mgr.current_checkpoint_id,
                    reversible=True,
                    error_message=f"Agent ended in status {status}",
                )
                decision = classify_error(Exception(f"Agent ended in status {status}"), checkpoint_mgr.current_checkpoint_id)

                if decision.action == RollbackAction.ROLLBACK and decision.target_checkpoint:
                    log(f"Auto-rolling back to checkpoint {decision.target_checkpoint}")
                    rollback_result = checkpoint_mgr.rollback_to(decision.target_checkpoint)
                    if rollback_result.success:
                        # Update conversation_id for retry
                        conversation_id = rollback_result.new_conversation_id
                        checkpoint_mgr.conversation_id = conversation_id
                        # Resume with fix instruction
                        # TODO: Implement resume with fix instruction
                        log(f"Rollback successful, would resume with: {decision.fix_instruction}")
                        continue  # Retry the loop

                return "failure", f"agent ended in status {status}"
            if time.monotonic() - started > MAX_RUN_SECONDS:
                # Create pre-failure checkpoint for timeout
                timeout_cp = checkpoint_mgr.create_checkpoint(
                    CheckpointLabel.PRE_FAILURE, f"Exceeded {MAX_RUN_SECONDS}s wall time"
                )

                # Classify timeout error
                decision = classify_error(Exception(f"Timeout after {MAX_RUN_SECONDS}s"), checkpoint_mgr.current_checkpoint_id)
                if decision.action == RollbackAction.ROLLBACK and decision.target_checkpoint:
                    log(f"Auto-rolling back to checkpoint {decision.target_checkpoint} after timeout")
                    rollback_result = checkpoint_mgr.rollback_to(decision.target_checkpoint)
                    if rollback_result.success:
                        conversation_id = rollback_result.new_conversation_id
                        checkpoint_mgr.conversation_id = conversation_id
                        log(f"Rollback successful after timeout, would resume with: {decision.fix_instruction}")
                        continue

                sandbox.http.post(f"/api/conversations/{conversation_id}/pause")
                return "failure", f"exceeded {MAX_RUN_SECONDS}s wall time"
            time.sleep(POLL_SECONDS)
    except Exception as err:  # noqa: BLE001 - the dispatch must always reach complete()
        log(f"org sandbox dispatch failed: {err!r}")

        # Create pre-failure checkpoint on exception
        try:
            failure_cp = checkpoint_mgr.create_checkpoint(
                CheckpointLabel.PRE_FAILURE, f"Exception: {err!r}"
            )

            # Classify and potentially rollback
            decision = classify_error(err, checkpoint_mgr.current_checkpoint_id)
            if decision.action == RollbackAction.ROLLBACK and decision.target_checkpoint:
                log(f"Auto-rolling back to checkpoint {decision.target_checkpoint} after exception")
                rollback_result = checkpoint_mgr.rollback_to(decision.target_checkpoint)
                if rollback_result.success:
                    conversation_id = rollback_result.new_conversation_id
                    checkpoint_mgr.conversation_id = conversation_id
                    log(f"Rollback successful after exception, would resume with: {decision.fix_instruction}")
                    # Could retry here, but for now return failure
        except Exception as cp_err:
            log(f"Failed to create pre-failure checkpoint: {cp_err}")

        return "failure", str(err)[:500]
    finally:
        if conversation_id:
            try:
                _forward_events(client, sandbox, execution_id, conversation_id, seen_events)
            except Exception as err:  # noqa: BLE001
                log(f"final event sync failed: {err!r}")
        stop.set()
        sandbox.close()


async def run_dispatch_via_task_sandbox(client: httpx.Client, dispatch: dict) -> tuple[str, str | None]:
    """Run a build dispatch using a per-task sandbox (Phase 2)."""
    execution_id = dispatch["executionId"]
    task_id = dispatch["jobId"]
    project_id = dispatch.get("projectId", "unknown")
    org_id = dispatch.get("orgId", "unknown")
    workdir = f"{BUILDS_ROOT}/{task_id}"
    stop = threading.Event()
    threading.Thread(target=heartbeat_loop, args=(client, execution_id, stop), daemon=True).start()

    # Request a per-task sandbox
    sandbox_info = await request_task_sandbox(task_id, org_id, project_id)
    if not sandbox_info:
        return "failure", "Failed to provision per-task sandbox"

    container_name = sandbox_info["containerName"]
    base_url = sandbox_info["baseUrl"]
    session_api_key = sandbox_info["sessionApiKey"]
    log(f"Provisioned task sandbox {container_name} for task {task_id}")

    try:
        sandbox = _Sandbox(base_url, session_api_key)
        seen_events: set[str] = set()
        seen_usage: set[str] = set()
        conversation_id: str | None = None

        # Initialize checkpoint manager
        checkpoint_mgr = CheckpointManager(sandbox, task_id, execution_id, project_id, workdir)
        memory_mgr = get_memory_manager(project_id)

        # Create baseline checkpoint
        baseline_cp = checkpoint_mgr.create_checkpoint(CheckpointLabel.BASELINE, "Task started")

        # Update running memory
        running_mem = memory_mgr.load_running_memory()
        running_mem.active_task_id = task_id
        running_mem.current_checkpoint = baseline_cp.id
        running_mem.checkpoint_history.append(baseline_cp.id)
        memory_mgr.save_running_memory(running_mem)

        base = dispatch.get("baseCommit")
        if base:
            start = dispatch.get("startCommit") or base
            _prepare_hosted_repository(client, sandbox, execution_id, task_id, start, workdir)
        else:
            # A project AtherNull cannot host yet: clone it directly (ADR-0017 path).
            _prepare_repository(sandbox, dispatch["repositorySnapshot"], workdir)
        model = dispatch["resolvedModel"]

        # Use LLM proxy - no direct API key in sandbox
        # The sandbox will use LLM_PROXY_URL env var
        message = build_task_message(
            dispatch["objective"], dispatch["acceptanceCriteria"], dispatch.get("changeRequests") or []
        )
        mcp_config, agent_context, plugins = workspace_agent_setup(sandbox.http)
        res = sandbox.http.post(
            "/api/conversations",
            json={
                "workspace": {"kind": "LocalWorkspace", "working_dir": workdir},
                "agent": {
                    "kind": "Agent",
                    "llm": {
                        "model": model,
                        "api_key": "PROXY",  # Placeholder - actual key via proxy
                        "usage_id": "athernull-build",
                        "llm_proxy_url": "http://host.docker.internal:3001/internal/llm-proxy",
                    },
                    "tools": [{"name": "terminal"}, {"name": "file_editor"}, {"name": "task_tracker"}],
                    **( {"mcp_config": mcp_config} if mcp_config else {}),
                    "agent_context": agent_context,
                },
                **( {"plugins": plugins} if plugins else {}),
                "initial_message": {"role": "user", "content": [{"type": "text", "text": message}], "run": True},
                "max_iterations": MAX_ITERATIONS,
                "tags": {"athernulltask": task_id.replace("-", "")},
                "autotitle": False,
            },
        )
        if res.status_code >= 400:
            return "failure", f"starting the conversation failed ({res.status_code}): {res.text[:300]}"
        conversation_id = res.json()["id"]
        checkpoint_mgr.conversation_id = conversation_id
        try:
            sandbox.http.patch(f"/api/conversations/{conversation_id}", json={"title": build_title(dispatch["objective"])})
        except Exception as err:  # noqa: BLE001 - best-effort: an untitled build still runs
            log(f"build {task_id}: could not set the conversation title: {err!r}")
        log(f"build {task_id} running as conversation {conversation_id} in task sandbox {container_name}")
        report = client.post(
            f"{API_URL}/internal/executions/{execution_id}/conversation",
            json={"workerId": WORKER_ID, "conversationId": conversation_id},
            headers=api_headers(),
        )
        if report.status_code != 200:
            log(f"failed to persist conversation id ({report.status_code}): {report.text}")

        started = time.monotonic()
        deliverable_count = 0
        while True:
            info_res = sandbox.http.get(f"/api/conversations/{conversation_id}")
            info_res.raise_for_status()
            info = info_res.json()
            _forward_events(client, sandbox, execution_id, conversation_id, seen_events)
            _forward_usage(client, execution_id, info, seen_usage)

            status = info.get("execution_status")
            if status in TERMINAL_SUCCESS:
                # The verifier judges the change itself, never this claim;
                # without a captured patch there is nothing to verify.
                if base:
                    _capture_commit(client, sandbox, execution_id, task_id, base, workdir, dispatch["objective"])
                else:
                    _capture_patch(client, sandbox, execution_id, workdir, dispatch["repositorySnapshot"])

                # Create milestone checkpoint on success
                milestone_cp = checkpoint_mgr.create_checkpoint(
                    CheckpointLabel.MILESTONE, f"Build completed successfully"
                )
                running_mem = memory_mgr.load_running_memory()
                running_mem.current_checkpoint = milestone_cp.id
                running_mem.checkpoint_history.append(milestone_cp.id)
                memory_mgr.save_running_memory(running_mem)

                return "success", None
            if status in TERMINAL_FAILURE:
                # Create pre-failure checkpoint
                failure_cp = checkpoint_mgr.create_checkpoint(
                    CheckpointLabel.PRE_FAILURE, f"Agent ended in status {status}"
                )

                # Classify error and decide on rollback
                error_ctx = ErrorContext(
                    error_type=ErrorType.AGENT_STUCK,
                    location=f"conversation:{conversation_id}",
                    checkpoint_after=checkpoint_mgr.current_checkpoint_id,
                    reversible=True,
                    error_message=f"Agent ended in status {status}",
                )
                decision = classify_error(Exception(f"Agent ended in status {status}"), checkpoint_mgr.current_checkpoint_id)

                if decision.action == RollbackAction.ROLLBACK and decision.target_checkpoint:
                    log(f"Auto-rolling back to checkpoint {decision.target_checkpoint}")
                    rollback_result = checkpoint_mgr.rollback_to(decision.target_checkpoint)
                    if rollback_result.success:
                        # Update conversation_id for retry
                        conversation_id = rollback_result.new_conversation_id
                        checkpoint_mgr.conversation_id = conversation_id
                        # Resume with fix instruction
                        # TODO: Implement resume with fix instruction
                        log(f"Rollback successful, would resume with: {decision.fix_instruction}")
                        continue  # Retry the loop

                return "failure", f"agent ended in status {status}"
            if time.monotonic() - started > MAX_RUN_SECONDS:
                # Create pre-failure checkpoint for timeout
                timeout_cp = checkpoint_mgr.create_checkpoint(
                    CheckpointLabel.PRE_FAILURE, f"Exceeded {MAX_RUN_SECONDS}s wall time"
                )

                # Classify timeout error
                decision = classify_error(Exception(f"Timeout after {MAX_RUN_SECONDS}s"), checkpoint_mgr.current_checkpoint_id)
                if decision.action == RollbackAction.ROLLBACK and decision.target_checkpoint:
                    log(f"Auto-rolling back to checkpoint {decision.target_checkpoint} after timeout")
                    rollback_result = checkpoint_mgr.rollback_to(decision.target_checkpoint)
                    if rollback_result.success:
                        conversation_id = rollback_result.new_conversation_id
                        checkpoint_mgr.conversation_id = conversation_id
                        log(f"Rollback successful after timeout, would resume with: {decision.fix_instruction}")
                        continue

                sandbox.http.post(f"/api/conversations/{conversation_id}/pause")
                return "failure", f"exceeded {MAX_RUN_SECONDS}s wall time"
            time.sleep(POLL_SECONDS)
    except Exception as err:  # noqa: BLE001 - the dispatch must always reach complete()
        log(f"task sandbox dispatch failed: {err!r}")

        # Create pre-failure checkpoint on exception
        try:
            failure_cp = checkpoint_mgr.create_checkpoint(
                CheckpointLabel.PRE_FAILURE, f"Exception: {err!r}"
            )

            # Classify and potentially rollback
            decision = classify_error(err, checkpoint_mgr.current_checkpoint_id)
            if decision.action == RollbackAction.ROLLBACK and decision.target_checkpoint:
                log(f"Auto-rolling back to checkpoint {decision.target_checkpoint} after exception")
                rollback_result = checkpoint_mgr.rollback_to(decision.target_checkpoint)
                if rollback_result.success:
                    conversation_id = rollback_result.new_conversation_id
                    checkpoint_mgr.conversation_id = conversation_id
                    log(f"Rollback successful after exception, would resume with: {decision.fix_instruction}")
                    # Could retry here, but for now return failure
        except Exception as cp_err:
            log(f"Failed to create pre-failure checkpoint: {cp_err}")

        return "failure", str(err)[:500]
    finally:
        if conversation_id:
            try:
                _forward_events(client, sandbox, execution_id, conversation_id, seen_events)
            except Exception as err:  # noqa: BLE001
                log(f"final event sync failed: {err!r}")
        stop.set()
        sandbox.close()
        # Decommission the task sandbox
        await decommission_task_sandbox(task_id)
