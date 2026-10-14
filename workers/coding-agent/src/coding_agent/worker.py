"""The production worker adapter (ADR-001) — polls apps/api's internal
claim/heartbeat/complete loop and does real agentic work inside an isolated
Docker container per dispatch, via openhands-workspace's DockerWorkspace.

Run as a persistent process: `python -m coding_agent.worker` (Ctrl+C to stop).

Explicit non-goals for this pass (do not assume these are handled):
  - No budget/spend enforcement mid-run — Phase 3's quota work, not this.
  - No wall-clock deadline enforcement beyond the existing lease/heartbeat —
    the dispatch's `deadline` is the lease boundary for reclaim purposes,
    not a hard kill switch on the running agent.
  - No retry-on-crash beyond what apps/api's own FAILED->QUEUED retry cap
    (routes/internal.ts, MAX_EXECUTION_ATTEMPTS) already provides server-side.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool

from coding_agent.llm import MissingCredentialError, require_api_key
from coding_agent.loopback_docker_workspace import LoopbackDockerWorkspace

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

API_URL = os.getenv("ATHERNULL_API_URL", "http://localhost:3001")
INTERNAL_TOKEN = os.getenv("INTERNAL_API_TOKEN")
# setdefault: the module is loaded twice (as __main__ and as
# coding_agent.worker by the adapters), and both copies must agree on the id
# the lease is held under.
WORKER_ID = os.environ.setdefault("WORKER_ID", f"coding-agent-{uuid.uuid4().hex[:8]}")
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "5"))
HEARTBEAT_INTERVAL_SECONDS = float(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "60"))
# "direct" (default) is this file's own run_dispatch, unchanged. "agent_server"
# opts into agent_server_adapter.run_dispatch_via_agent_server (Phase 1,
# approved scope) — same contract, adds conversation-id/event persistence and
# container auth. Rollback is flipping this back and restarting the worker.
EXECUTION_ADAPTER = os.getenv("EXECUTION_ADAPTER", "direct")


def log(message: str) -> None:
    print(f"[{WORKER_ID}] {message}", flush=True)


def api_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {INTERNAL_TOKEN}", "Content-Type": "application/json"}


def claim(client: httpx.Client) -> dict | None:
    res = client.post(
        f"{API_URL}/internal/executions/claim",
        json={"workerId": WORKER_ID},
        headers=api_headers(),
    )
    if res.status_code == 204:
        return None
    res.raise_for_status()
    return res.json()


def heartbeat(client: httpx.Client, execution_id: str) -> None:
    res = client.post(
        f"{API_URL}/internal/executions/{execution_id}/heartbeat",
        json={"workerId": WORKER_ID},
        headers=api_headers(),
    )
    if res.status_code != 200:
        log(f"heartbeat failed ({res.status_code}): {res.text}")


def complete(client: httpx.Client, execution_id: str, outcome: str, reason: str | None = None) -> None:
    # Phase 4D.2A correction 12 — `reason` is an optional machine-readable
    # string (today, the only value ever sent is the literal
    # "USAGE_ENFORCEMENT_FAILED", set exclusively by
    # agent_server_adapter.py's fail-closed usage-enforcement path). Omitted
    # entirely (not sent as null) for every ordinary completion, matching
    # this route's own optional-field contract (routes/internal.ts).
    payload: dict = {"workerId": WORKER_ID, "outcome": outcome}
    if reason is not None:
        payload["reason"] = reason
    res = client.post(
        f"{API_URL}/internal/executions/{execution_id}/complete",
        json=payload,
        headers=api_headers(),
    )
    res.raise_for_status()
    log(f"completed execution {execution_id} as {outcome}: {res.json()}")


def heartbeat_loop(client: httpx.Client, execution_id: str, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_INTERVAL_SECONDS):
        heartbeat(client, execution_id)


def clone_repository(repository_snapshot: str, dest: Path) -> None:
    # repositorySnapshot is "<source>@<revision>" — <source> may be a real
    # git URL or a local filesystem path (this pass's disposable test repo),
    # `git clone` handles both identically, so no special-casing is needed.
    source, _, revision = repository_snapshot.rpartition("@")
    if not source:
        raise ValueError(f"Malformed repositorySnapshot (no '@revision'): {repository_snapshot!r}")

    log(f"cloning {source} @ {revision} -> {dest}")
    subprocess.run(["git", "clone", source, str(dest)], check=True)
    subprocess.run(["git", "-C", str(dest), "checkout", revision], check=True)


# How AtherNull checks and ships a build (services/verifier): its tests run
# offline with `npm test` (output read as node:test / TAP) or pytest, and a
# web app gets a live preview from its static files. Told to the agent so a
# correct build is also a verifiable, previewable one.
DELIVERY_RULES = """How this build is checked and delivered:
- An independent verifier checks out your final commit on its own, installs dependencies, then runs the tests with NO network. Only passing tests count.
- JavaScript/TypeScript: `npm test` must run the tests with Node's built-in runner (`node --test`, using `node:test` and `node:assert`). Do not use Jest, Vitest or Mocha. Always commit a `package.json` at the project root with `"scripts": { "test": "node --test" }`, even for a plain HTML/CSS/JS site, and run `npm test` yourself before finishing. Python: pytest.
- Put the logic in plain modules the tests import; test real behaviour, not just that files exist.
- If this is a web app, it gets a public live link. Unless the request names a framework, build it as a static site with plain HTML, CSS and JavaScript: index.html at the repository root, relative paths for every asset (./app.js, never /app.js), no build step, no server. If a framework is required, use Vite with `base: './'` so `npm run build` writes a static site to dist/.
- The live page runs sandboxed: it cannot use localStorage, cookies or call back to AtherNull; keep state in memory.
- The verifier also opens index.html in a real browser: the build fails if the page throws any error or its buttons do nothing. Make the browser code and the tested code work together: either load your scripts with <script type="module"> and use import/export everywhere, or use plain scripts with no import/export at all (expose the logic for Node with `if (typeof module !== "undefined") module.exports = ...`). Never put `export` in a file loaded by a plain <script> tag.
- Before you finish, check the page in a real browser from the terminal (headless Chromium is installed: serve the folder with `python3 -m http.server` and run `chromium --headless=new --no-sandbox --enable-logging=stderr --v=0 --dump-dom http://127.0.0.1:8000/`), and fix any "Uncaught" error it prints.
- Commit nothing secret, and keep the change to what was asked."""


def build_task_message(objective: str, acceptance_criteria: list[str], change_requests: list[dict] | None = None) -> str:
    message = objective.strip()
    if acceptance_criteria:
        bullets = "\n".join(f"- {c}" for c in acceptance_criteria)
        message += f"\n\nAcceptance criteria:\n{bullets}"
    if change_requests:
        # Request changes, or an automatic fix round after failed checks: the
        # previous version is already in the working tree; fix it rather than
        # starting over.
        customer = [c for c in change_requests if c.get("source") != "verifier"]
        latest = change_requests[-1]
        message += (
            "\n\nA previous version of this build is already in the working directory: change it, do not start "
            "over. Keep everything that already works, keep the tests passing, and add tests for what you fix."
        )
        if customer:
            rounds = "\n".join(f"- Round {i}: {str(c.get('feedback', '')).strip()}" for i, c in enumerate(customer, 1))
            message += f"\nThe customer reviewed it and asked for these changes (the latest round matters most):\n{rounds}"
        if latest.get("source") == "verifier":
            message += (
                "\n\nThe independent checks then rejected the latest version. Fix exactly what they found, and "
                "check it yourself the same way before you finish (run the tests, and load the page in headless "
                f"Chromium for a web app):\n{str(latest.get('feedback', '')).strip()}"
            )
    return f"{message}\n\n{DELIVERY_RULES}"


def run_dispatch(client: httpx.Client, dispatch: dict) -> str:
    """Runs one dispatch end to end. Returns "success" or "failure" — never
    raises, so the caller's complete() call always fires."""
    execution_id = dispatch["executionId"]
    stop_heartbeat = threading.Event()
    heartbeat_thread = threading.Thread(
        target=heartbeat_loop, args=(client, execution_id, stop_heartbeat), daemon=True
    )
    heartbeat_thread.start()

    repo_dir = Path(tempfile.mkdtemp(prefix="athernull-worker-"))
    docker_workspace: LoopbackDockerWorkspace | None = None
    try:
        clone_repository(dispatch["repositorySnapshot"], repo_dir)

        api_key = require_api_key(dispatch["resolvedModel"])
        llm = LLM(model=dispatch["resolvedModel"], api_key=api_key)
        agent = Agent(
            llm=llm,
            tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
        )

        log(f"starting isolated container for execution {execution_id} (model={dispatch['resolvedModel']})")
        docker_workspace = LoopbackDockerWorkspace(volumes=[f"{repo_dir}:/workspace"])

        conversation = Conversation(agent=agent, workspace=docker_workspace)
        message = build_task_message(dispatch["objective"], dispatch["acceptanceCriteria"])
        conversation.send_message(message)
        conversation.run()

        from openhands.sdk.conversation.state import ConversationExecutionStatus

        from coding_agent.agent_server_adapter import get_fresh_execution_status

        if get_fresh_execution_status(conversation) != ConversationExecutionStatus.FINISHED:
            return "failure"

        log(f"agent run finished for execution {execution_id}")
        return "success"
    except Exception as err:  # noqa: BLE001 - any failure here must report "failure", not crash the worker loop
        log(f"execution {execution_id} failed: {err!r}")
        return "failure"
    finally:
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=5)
        if docker_workspace is not None:
            try:
                docker_workspace.cleanup()
            except Exception as cleanup_err:  # noqa: BLE001
                log(f"container cleanup warning: {cleanup_err!r}")
        shutil.rmtree(repo_dir, ignore_errors=True)


def main() -> None:
    if not INTERNAL_TOKEN:
        print("INTERNAL_API_TOKEN must be set (must match apps/api's own value).", file=sys.stderr)
        raise SystemExit(2)
    if EXECUTION_ADAPTER not in ("direct", "agent_server", "org_sandbox"):
        print(f"EXECUTION_ADAPTER must be 'direct', 'agent_server' or 'org_sandbox', got {EXECUTION_ADAPTER!r}", file=sys.stderr)
        raise SystemExit(2)

    # Imported lazily so the "direct" default (production today) never pays
    # for or depends on agent_server_adapter's extra imports (websockets,
    # etc.) unless explicitly opted into.
    dispatch_fn = run_dispatch
    if EXECUTION_ADAPTER == "agent_server":
        from coding_agent.agent_server_adapter import run_dispatch_via_agent_server

        dispatch_fn = run_dispatch_via_agent_server
    elif EXECUTION_ADAPTER == "org_sandbox":
        # ADR-0015: builds run as conversations on the org's own sandboxed
        # Agent Server, live in the Agent Canvas.
        from coding_agent.org_sandbox_adapter import run_dispatch_via_org_sandbox

        dispatch_fn = run_dispatch_via_org_sandbox

    log(f"online, polling {API_URL} every {POLL_INTERVAL_SECONDS}s (adapter={EXECUTION_ADAPTER})")
    with httpx.Client(timeout=30.0) as client:
        while True:
            try:
                dispatch = claim(client)
            except httpx.HTTPError as err:
                log(f"claim request failed: {err!r}")
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            if dispatch is None:
                time.sleep(POLL_INTERVAL_SECONDS)
                continue

            log(f"claimed job={dispatch['jobId']} execution={dispatch['executionId']}")
            reason: str | None = None
            try:
                if dispatch.get("usagePolicy") and EXECUTION_ADAPTER == "direct":
                    from coding_agent.agent_server_adapter import (
                        run_dispatch_via_agent_server,
                    )

                    result = run_dispatch_via_agent_server(client, dispatch)
                else:
                    result = dispatch_fn(client, dispatch)
            except MissingCredentialError as err:
                log(f"missing credential, reporting failure: {err}")
                result = "failure"

            # The "direct" adapter (run_dispatch) returns a plain
            # "success"/"failure" string — unchanged by this phase, no usage
            # enforcement exists on that path. The "agent_server" adapter
            # (run_dispatch_via_agent_server, Phase 4D.2A) returns
            # (outcome, reason); outcome can also be "paused" (correction 12
            # NEW_ATTEMPT recovery), which must NEVER be reported to
            # /internal/executions/:id/complete — apps/api has already
            # transitioned the task to PAUSED_USAGE_LIMIT itself, via the
            # worker's own POST .../usage-pause call, before this dispatch
            # returned at all.
            outcome, reason = (result, None) if isinstance(result, str) else result

            if outcome == "paused":
                log(f"execution {dispatch['executionId']} ended in a usage-limit pause — not calling /complete")
                continue

            complete(client, dispatch["executionId"], outcome, reason)


if __name__ == "__main__":
    main()
