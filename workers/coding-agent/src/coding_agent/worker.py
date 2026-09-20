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
from openhands.workspace import DockerWorkspace

from coding_agent.llm import MissingCredentialError, require_api_key

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

API_URL = os.getenv("ATHERNULL_API_URL", "http://localhost:3001")
INTERNAL_TOKEN = os.getenv("INTERNAL_API_TOKEN")
WORKER_ID = os.getenv("WORKER_ID", f"coding-agent-{uuid.uuid4().hex[:8]}")
POLL_INTERVAL_SECONDS = float(os.getenv("POLL_INTERVAL_SECONDS", "5"))
HEARTBEAT_INTERVAL_SECONDS = float(os.getenv("HEARTBEAT_INTERVAL_SECONDS", "60"))


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


def complete(client: httpx.Client, execution_id: str, outcome: str) -> None:
    res = client.post(
        f"{API_URL}/internal/executions/{execution_id}/complete",
        json={"workerId": WORKER_ID, "outcome": outcome},
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


def build_task_message(objective: str, acceptance_criteria: list[str]) -> str:
    message = objective.strip()
    if acceptance_criteria:
        bullets = "\n".join(f"- {c}" for c in acceptance_criteria)
        message += f"\n\nAcceptance criteria:\n{bullets}"
    return message


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
    docker_workspace: DockerWorkspace | None = None
    try:
        clone_repository(dispatch["repositorySnapshot"], repo_dir)

        api_key = require_api_key(dispatch["resolvedModel"])
        llm = LLM(model=dispatch["resolvedModel"], api_key=api_key)
        agent = Agent(
            llm=llm,
            tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
        )

        log(f"starting isolated container for execution {execution_id} (model={dispatch['resolvedModel']})")
        docker_workspace = DockerWorkspace(volumes=[f"{repo_dir}:/workspace"])

        conversation = Conversation(agent=agent, workspace=docker_workspace)
        message = build_task_message(dispatch["objective"], dispatch["acceptanceCriteria"])
        conversation.send_message(message)
        conversation.run()

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

    log(f"online, polling {API_URL} every {POLL_INTERVAL_SECONDS}s")
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
            try:
                outcome = run_dispatch(client, dispatch)
            except MissingCredentialError as err:
                log(f"missing credential, reporting failure: {err}")
                outcome = "failure"
            complete(client, dispatch["executionId"], outcome)


if __name__ == "__main__":
    main()
