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

AGENT_IDENTITY = (
    "IDENTITY: You are the AtherNull Agent, made by AtherNull. If asked your name or who made you, "
    "say you are the AtherNull Agent. Never call yourself OpenHands or any other product name, "
    "even if earlier instructions say so."
)


_PLATFORM_SKILL = re.compile(
    r"openhands[\s-]*(software agent )?(sdk|cloud|enterprise|api|automation|agent sdk)|all-hands|agent canvas|\bOHE\b", re.I
)


def _is_platform_skill(skill: dict) -> bool:
    """Skills about the OpenHands platform itself — hidden from the AtherNull
    catalog (apps/canvas utils/athernull-catalog.ts), so never given to a build."""
    name = str(skill.get("name", "")).lower()
    return "openhands" in name or "agent-canvas" in name or bool(_PLATFORM_SKILL.search(str(skill.get("description") or "")))


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
                        key: skill[key]
                        for key in ("name", "content", "source", "description", "is_agentskills_format", "disable_model_invocation")
                        if skill.get(key) is not None
                    })
        except Exception as exc:  # noqa: BLE001
            log(f"catalog skills unavailable for this build: {exc}")
    agent_context = {
        "system_message_suffix": AGENT_IDENTITY,
        "skills": skills,
        "load_public_skills": False,
        "load_user_skills": True,
        "load_project_skills": True,
        "disabled_skills": disabled,
    }

    plugins: list[dict] = []
    try:
        for plugin in http.get("/api/plugins/installed").json().get("plugins") or []:
            if plugin.get("enabled", True) and plugin.get("source"):
                source = {"source": plugin["source"]}
                if plugin.get("resolved_ref"):
                    source["ref"] = plugin["resolved_ref"]
                plugins.append(source)
    except Exception as exc:  # noqa: BLE001
        log(f"installed plugins unavailable for this build: {exc}")
    return mcp_config, agent_context, plugins


def build_title(objective: str) -> str:
    """A build conversation's title: the first line of its objective, shortened."""
    line = next((" ".join(l.split()) for l in objective.splitlines() if l.strip()), "")
    if not line:
        return "Build"
    return line if len(line) <= 60 else line[:59].rstrip() + "…"


TERMINAL_SUCCESS = {"finished"}
TERMINAL_FAILURE = {"error", "stuck"}


def _is_remote(source: str) -> bool:
    return source.startswith(("http://", "https://", "git://", "ssh://")) or "@" in source.split(":", 1)[0]


class _Sandbox:
    def __init__(self, url: str, key: str) -> None:
        self.http = httpx.Client(base_url=url.rstrip("/"), headers={"X-Session-API-Key": key}, timeout=60.0)

    def bash(self, command: str, timeout: int = 300) -> tuple[int | None, str]:
        res = self.http.post(
            "/api/bash/execute_bash_command",
            json={"command": command, "cwd": "/workspace", "timeout": timeout},
            timeout=timeout + 30,
        )
        res.raise_for_status()
        body = res.json()
        return body.get("exit_code"), f"{body.get('stdout') or ''}{body.get('stderr') or ''}"

    def upload(self, local: Path, remote_path: str) -> None:
        with local.open("rb") as fh:
            res = self.http.post("/api/file/upload", params={"path": remote_path}, files={"file": (local.name, fh)}, timeout=300)
        res.raise_for_status()

    def close(self) -> None:
        self.http.close()


def _prepare_repository(sandbox: _Sandbox, snapshot: str, workdir: str) -> None:
    source, _, revision = snapshot.rpartition("@")
    if not source:
        raise ValueError(f"Malformed repositorySnapshot: {snapshot!r}")
    q = shlex.quote
    if _is_remote(source):
        clone = f"git clone --quiet {q(source)} {q(workdir)}"
    else:
        # A repository only the worker host can reach: ship it in as a git
        # bundle (all refs, so the approved revision is present).
        with tempfile.TemporaryDirectory(prefix="athernull-bundle-") as tmp:
            bundle = Path(tmp) / "repo.bundle"
            subprocess.run(["git", "-C", source, "bundle", "create", str(bundle), "--all"], check=True, capture_output=True)
            remote_bundle = f"{BUILDS_ROOT}/.bundles/{Path(workdir).name}.bundle"
            sandbox.bash(f"mkdir -p {q(BUILDS_ROOT)}/.bundles")
            sandbox.upload(bundle, remote_bundle)
        clone = f"git clone --quiet {q(remote_bundle)} {q(workdir)}"
    code, output = sandbox.bash(
        f"mkdir -p {q(BUILDS_ROOT)} && rm -rf {q(workdir)} && {clone} && git -C {q(workdir)} checkout --quiet {q(revision)}"
    )
    if code != 0:
        raise RuntimeError(f"preparing repository failed (exit {code}): {output[-500:]}")


def _forward_events(client: httpx.Client, sandbox: _Sandbox, execution_id: str, conversation_id: str, seen: set[str]) -> None:
    page_id: str | None = None
    while True:
        params: dict = {"limit": 100, "sort_order": "TIMESTAMP"}
        if page_id:
            params["page_id"] = page_id
        res = sandbox.http.get(f"/api/conversations/{conversation_id}/events/search", params=params)
        res.raise_for_status()
        page = res.json()
        fresh = [e for e in page.get("items", []) if e.get("id") not in seen]
        if fresh:
            records = [
                {"id": e["id"], "kind": e.get("kind", "Unknown"), "occurredAt": e.get("timestamp"), "payload": e}
                for e in fresh
            ]
            post = client.post(
                f"{API_URL}/internal/executions/{execution_id}/events",
                json={"workerId": WORKER_ID, "events": records},
                headers=api_headers(),
                timeout=15.0,
            )
            if post.status_code != 204:
                log(f"event forward failed ({post.status_code}): {post.text}")
                return
            seen.update(e["id"] for e in fresh)
        page_id = page.get("next_page_id")
        if not page_id:
            return


def _split_model(full: str) -> tuple[str, str]:
    provider, _, model = full.partition("/")
    return (provider, model) if model else ("unknown", full)


def _forward_usage(client: httpx.Client, execution_id: str, info: dict, seen: set[str]) -> None:
    stats = info.get("stats") or {}
    rows: list[dict] = []
    observed_at = datetime.now(UTC).isoformat()
    for metrics in (stats.get("usage_to_metrics") or {}).values():
        for usage in metrics.get("token_usages") or []:
            response_id = usage.get("response_id")
            if not response_id or response_id in seen:
                continue
            provider, model = _split_model(usage.get("model") or "")
            rows.append(
                {
                    "providerRequestId": response_id,
                    "provider": provider,
                    "model": model,
                    "inputTokens": usage.get("prompt_tokens") or 0,
                    "outputTokens": usage.get("completion_tokens") or 0,
                    "cacheReadTokens": usage.get("cache_read_tokens") or 0,
                    "cacheWriteTokens": usage.get("cache_write_tokens") or 0,
                    "reasoningTokens": usage.get("reasoning_tokens") or 0,
                    "observedAt": observed_at,
                }
            )
    if not rows:
        return
    res = client.post(
        f"{API_URL}/internal/executions/{execution_id}/usage",
        json={"workerId": WORKER_ID, "usageEvents": rows},
        headers=api_headers(),
        timeout=10.0,
    )
    if res.status_code == 204:
        seen.update(r["providerRequestId"] for r in rows)
    else:
        log(f"usage forward failed ({res.status_code}): {res.text}")


def _capture_patch(client: httpx.Client, sandbox: _Sandbox, execution_id: str, workdir: str, snapshot: str) -> None:
    """Captures the agent's change (ADR-0017) as a git diff of the working
    tree against the approved revision, and hands it to apps/api for the
    independent verifier. Untracked files are included; .gitignore applies."""
    revision = snapshot.rpartition("@")[2]
    q = shlex.quote
    patch_path = f"{BUILDS_ROOT}/.patches/{execution_id}.patch"
    code, output = sandbox.bash(
        f"mkdir -p {q(BUILDS_ROOT)}/.patches && cd {q(workdir)} && git add -A && "
        f"git -c core.quotepath=off diff --cached --binary {q(revision)} > {q(patch_path)}"
    )
    if code != 0:
        raise RuntimeError(f"capturing the patch failed (exit {code}): {output[-300:]}")
    res = sandbox.http.get("/api/file/download", params={"path": patch_path})
    res.raise_for_status()
    post = client.post(
        f"{API_URL}/internal/executions/{execution_id}/patch",
        json={"workerId": WORKER_ID, "baseRevision": revision, "patch": res.content.decode("utf-8", errors="replace")},
        headers=api_headers(),
        timeout=60.0,
    )
    if post.status_code != 201:
        raise RuntimeError(f"patch upload failed ({post.status_code}): {post.text[:300]}")
    log(f"captured patch for {execution_id}: {post.json()}")


def run_dispatch_via_org_sandbox(client: httpx.Client, dispatch: dict) -> tuple[str, str | None]:
    server = dispatch.get("orgAgentServer")
    if not server:
        return "failure", "No agent sandbox is provisioned for this organization"

    execution_id = dispatch["executionId"]
    task_id = dispatch["jobId"]
    workdir = f"{BUILDS_ROOT}/{task_id}"
    stop = threading.Event()
    threading.Thread(target=heartbeat_loop, args=(client, execution_id, stop), daemon=True).start()
    sandbox = _Sandbox(server["url"], server["sessionApiKey"])
    seen_events: set[str] = set()
    seen_usage: set[str] = set()
    conversation_id: str | None = None
    try:
        _prepare_repository(sandbox, dispatch["repositorySnapshot"], workdir)
        model = dispatch["resolvedModel"]
        api_key = require_api_key(model)
        message = build_task_message(dispatch["objective"], dispatch["acceptanceCriteria"])
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
                    **({"mcp_config": mcp_config} if mcp_config else {}),
                    "agent_context": agent_context,
                },
                **({"plugins": plugins} if plugins else {}),
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
        try:
            sandbox.http.patch(f"/api/conversations/{conversation_id}", json={"title": build_title(dispatch["objective"])})
        except Exception:  # best-effort: an untitled build still runs
            pass
        log(f"build {task_id} running as conversation {conversation_id} in the org sandbox")
        report = client.post(
            f"{API_URL}/internal/executions/{execution_id}/conversation",
            json={"workerId": WORKER_ID, "conversationId": conversation_id},
            headers=api_headers(),
        )
        if report.status_code != 200:
            log(f"failed to persist conversation id ({report.status_code}): {report.text}")

        started = time.monotonic()
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
                _capture_patch(client, sandbox, execution_id, workdir, dispatch["repositorySnapshot"])
                return "success", None
            if status in TERMINAL_FAILURE:
                return "failure", f"agent ended in status {status}"
            if time.monotonic() - started > MAX_RUN_SECONDS:
                sandbox.http.post(f"/api/conversations/{conversation_id}/pause")
                return "failure", f"exceeded {MAX_RUN_SECONDS}s wall time"
            time.sleep(POLL_SECONDS)
    except Exception as err:  # noqa: BLE001 - the dispatch must always reach complete()
        log(f"org sandbox dispatch failed: {err!r}")
        return "failure", str(err)[:500]
    finally:
        if conversation_id:
            try:
                _forward_events(client, sandbox, execution_id, conversation_id, seen_events)
            except Exception as err:  # noqa: BLE001
                log(f"final event sync failed: {err!r}")
        stop.set()
        sandbox.close()
