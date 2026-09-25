"""Agent Server execution adapter (Phase 1, approved scope).

worker.py's run_dispatch() already provisions a per-execution Agent Server
without knowing it — DockerWorkspace launches
ghcr.io/openhands/agent-server:latest-python per task and the SDK drives it
internally over REST/WebSocket (ADR-0001). This adapter doesn't replace that
sandboxing; it adds what the direct-SDK path never captured:

  - a session key, so the container's Agent Server actually requires
    authentication (today it doesn't — see docs/adr/0002 for the full finding)
  - the OpenHands conversation id, persisted to `executions.conversation_id`
  - the event stream, persisted to `execution_events` before anything else
    (including the browser) can see it

Selected via EXECUTION_ADAPTER=agent_server (see worker.py's main()). The
default EXECUTION_ADAPTER=direct path (run_dispatch, unchanged) is the
fallback — this module is purely additive.

Explicit non-goal for this pass: resuming a conversation after the *worker
process itself* crashes/restarts. A crashed worker's lease expires and the
task returns to QUEUED for a fresh attempt/fresh container under the existing
claim FSM (apps/api/src/routes/internal.ts) — reattaching to an orphaned
still-running container (Conversation(..., conversation_id=<existing>) is
supported by the SDK) is a real future option, not attempted here.
"""

import json
import os
import secrets
import shutil
import tempfile
import threading
from pathlib import Path
from urllib.parse import urlencode

import httpx
import websockets.sync.client as ws_client
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.sdk.event.base import Event
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool

from coding_agent.llm import require_api_key
from coding_agent.loopback_docker_workspace import LoopbackDockerWorkspace
from coding_agent.relay_client import RelayClient
from coding_agent.worker import (
    API_URL,
    INTERNAL_TOKEN,
    WORKER_ID,
    api_headers,
    build_task_message,
    clone_repository,
    heartbeat_loop,
    log,
)

EVENTS_BATCH_SIZE = 20
EVENTS_FLUSH_INTERVAL_SECONDS = 1.0


def _report_conversation_id(client: httpx.Client, execution_id: str, worker_id: str, conversation_id: str) -> None:
    res = client.post(
        f"{API_URL}/internal/executions/{execution_id}/conversation",
        json={"workerId": worker_id, "conversationId": conversation_id},
        headers=api_headers(),
    )
    if res.status_code != 200:
        log(f"failed to persist conversation id ({res.status_code}): {res.text}")


class EventForwarder:
    """Registered as a Conversation callback — RemoteConversation invokes this
    for every event it receives on the WebSocket it already opens to drive
    .run() (confirmed from openhands/sdk/conversation/impl/remote_conversation.py),
    so this never opens a second, competing subscriber against the
    container's event socket.

    Buffers and POSTs in small batches. Never raises — a forwarding failure
    is logged and the batch stays queued for the next flush; the ultimate
    backstop for a batch that never makes it is resync_events() below, called
    once after the run finishes.
    """

    def __init__(self, client: httpx.Client, execution_id: str, worker_id: str) -> None:
        self._client = client
        self._execution_id = execution_id
        self._worker_id = worker_id
        self._buffer: list[dict] = []
        self._lock = threading.Lock()
        self._flush_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_occurred_at: str | None = None

    def start(self, interval: float = EVENTS_FLUSH_INTERVAL_SECONDS) -> None:
        def periodically_flush() -> None:
            while not self._stop.wait(interval):
                self.flush()

        self._thread = threading.Thread(target=periodically_flush, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
        self.flush()

    def __call__(self, event: Event) -> None:
        payload = event.model_dump(mode="json")
        record = {
            "id": str(event.id),
            "kind": payload.get("kind", type(event).__name__),
            "occurredAt": event.timestamp,
            "payload": payload,
        }
        with self._lock:
            self._buffer.append(record)
            should_flush = len(self._buffer) >= EVENTS_BATCH_SIZE
        if should_flush:
            self.flush()

    def flush(self) -> None:
        # Timer, SDK callbacks and shutdown can race. Serialize each POST and
        # its acknowledgement so two flushes never delete each other's data.
        with self._flush_lock:
            while True:
                with self._lock:
                    if not self._buffer:
                        return
                    batch = self._buffer[:EVENTS_BATCH_SIZE]
                try:
                    res = self._client.post(
                        f"{API_URL}/internal/executions/{self._execution_id}/events",
                        json={"workerId": self._worker_id, "events": batch},
                        headers=api_headers(),
                        timeout=10.0,
                    )
                    if res.status_code != 204:
                        log(f"event forward failed ({res.status_code}): {res.text}")
                        return
                    with self._lock:
                        del self._buffer[: len(batch)]
                    self.last_occurred_at = batch[-1]["occurredAt"]
                except httpx.HTTPError as err:
                    log(f"event forward request failed: {err!r}")
                    return


class RelayEventCallback:
    """Registered as a second `Conversation` callback alongside (never
    instead of) EventForwarder — see `run_dispatch_via_agent_server`'s
    `callbacks=[forwarder, relay_callback]`. RemoteConversation invokes both
    callbacks synchronously on the same thread driving `.run()`, for the
    same events, off the one WebSocket subscription the SDK already opens
    (ADR-0007: this worker never opens a second, competing subscriber
    against the container's own event socket).

    Builds the exact same {id, kind, occurredAt, payload} record shape
    EventForwarder already builds (deliberately duplicated rather than
    shared, to keep EventForwarder — the authoritative, well-tested path —
    completely untouched by this best-effort, additive one) and hands it to
    RelayClient.send_event(), which never blocks and never raises.

    __call__ itself also never raises: a relay problem must never surface as
    a Conversation callback exception, which the SDK would otherwise treat
    as a real callback failure during `.run()`.
    """

    def __init__(self, relay: RelayClient) -> None:
        self._relay = relay

    def __call__(self, event: Event) -> None:
        try:
            payload = event.model_dump(mode="json")
            record = {
                "id": str(event.id),
                "kind": payload.get("kind", type(event).__name__),
                "occurredAt": event.timestamp,
                "payload": payload,
            }
            self._relay.send_event(record)
        except Exception as err:  # noqa: BLE001 - must never affect the dispatch
            log(f"relay: failed to forward event to relay callback (non-fatal): {err!r}")


def resync_events(host: str, api_key: str | None, conversation_id: str, after_timestamp: str | None) -> list[dict]:
    """Ask the container's Agent Server to resend events since the last one
    this worker successfully persisted — the exact resend_mode mechanism
    validated against a live Agent Server this session (both 'all' and
    'since' confirmed to replay correctly). Used only as a post-run gap-fill:
    the SDK's own WebSocket (driving .run() via EventForwarder above) is the
    real-time path and needs no reconnect logic of its own."""
    ws_url = host.replace("http://", "ws://").replace("https://", "wss://")
    params = (
        {"resend_mode": "since", "after_timestamp": after_timestamp}
        if after_timestamp
        else {"resend_mode": "all"}
    )
    url = f"{ws_url}/sockets/events/{conversation_id}?{urlencode(params)}"
    headers = {"X-Session-API-Key": api_key} if api_key else {}

    events: list[dict] = []
    with ws_client.connect(url, additional_headers=headers, open_timeout=10) as ws:
        while True:
            try:
                message = ws.recv(timeout=3.0)
            except TimeoutError:
                break
            events.append(json.loads(message))
    return events


def _forward_resynced_events(client: httpx.Client, execution_id: str, worker_id: str, events: list[dict]) -> None:
    if not events:
        return
    records = [
        {
            "id": event["id"],
            "kind": event.get("kind", "Unknown"),
            "occurredAt": event["timestamp"],
            "payload": event,
        }
        for event in events
    ]
    res = client.post(
        f"{API_URL}/internal/executions/{execution_id}/events",
        json={"workerId": worker_id, "events": records},
        headers=api_headers(),
    )
    if res.status_code != 204:
        log(f"resync forward failed ({res.status_code}): {res.text}")
    else:
        log(f"resync forwarded {len(records)} event(s)")


def run_dispatch_via_agent_server(client: httpx.Client, dispatch: dict) -> str:
    """Same signature/contract as worker.run_dispatch(): runs one dispatch end
    to end, returns "success"/"failure", never raises — so worker.py's
    complete() call always fires regardless of which adapter ran it."""
    execution_id = dispatch["executionId"]
    stop_heartbeat = threading.Event()
    heartbeat_thread = threading.Thread(
        target=heartbeat_loop, args=(client, execution_id, stop_heartbeat), daemon=True
    )
    heartbeat_thread.start()

    repo_dir = Path(tempfile.mkdtemp(prefix="athernull-worker-"))
    docker_workspace: LoopbackDockerWorkspace | None = None
    forwarder: EventForwarder | None = None
    relay: RelayClient | None = None
    conversation = None

    # A random per-execution key so this container's Agent Server actually
    # requires authentication (today it accepts unauthenticated requests —
    # see docs/adr/0002-agent-server-execution-isolation.md). SESSION_API_KEY
    # is on DockerWorkspace's own forward_env default list, so setting it in
    # this process's environment before construction gets it into the
    # container automatically. Safe as a process-global env var only because
    # worker.py's main() runs one dispatch at a time (never concurrently).
    session_key = secrets.token_hex(32)
    os.environ["SESSION_API_KEY"] = session_key

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
        # DockerWorkspace forwards SESSION_API_KEY into the container but
        # hardcodes its own outer client's api_key to None after container
        # start (confirmed in openhands/workspace/docker/workspace.py) —
        # RemoteWorkspaceMixin reads api_key fresh on every request (not
        # cached at construction), so overriding it here, before the
        # Conversation is created, is correct and sufficient.
        docker_workspace.api_key = session_key

        forwarder = EventForwarder(client, execution_id, WORKER_ID)
        forwarder.start()

        # ADR-0007 Phase 3B: best-effort outbound relay to apps/api's
        # realtime gateway, additive alongside (never instead of) the
        # authoritative EventForwarder above. start() is non-blocking and
        # never raises — a gateway that's unreachable, or a registration
        # apps/api rejects (lease/status mismatch), degrades silently to "no
        # relay for this dispatch," exactly as if this code didn't exist.
        # INTERNAL_API_TOKEN is reused as-is; SESSION_API_KEY is never passed
        # to RelayClient and never appears anywhere in relay_client.py.
        relay = RelayClient(API_URL, INTERNAL_TOKEN, WORKER_ID, execution_id, log=log)
        relay.start()

        conversation = Conversation(
            agent=agent,
            workspace=docker_workspace,
            callbacks=[forwarder, RelayEventCallback(relay)],
        )
        _report_conversation_id(client, execution_id, WORKER_ID, str(conversation.id))

        message = build_task_message(dispatch["objective"], dispatch["acceptanceCriteria"])
        conversation.send_message(message)
        conversation.run()

        log(f"agent run finished for execution {execution_id}")
        return "success"
    except Exception as err:  # noqa: BLE001 - any failure here must report "failure", not crash the worker loop
        log(f"execution {execution_id} failed: {err!r}")
        return "failure"
    finally:
        # Persist partial runs before reporting completion or deleting the
        # container. Recovery errors must not change the agent's outcome.
        if forwarder is not None:
            forwarder.close()
        if relay is not None:
            try:
                # Best-effort flush + clean close (sends execution.completed
                # if the relay ever connected). Bounded by RelayClient's own
                # internal timeout — never blocks dispatch completion on a
                # slow/dead gateway.
                relay.close()
            except Exception as relay_close_err:  # noqa: BLE001
                log(f"relay close warning: {relay_close_err!r}")
        if conversation is not None and docker_workspace is not None:
            try:
                # Replay all events: the SDK can deliver older events late.
                resynced = resync_events(docker_workspace.host, session_key, str(conversation.id), None)
                _forward_resynced_events(client, execution_id, WORKER_ID, resynced)
            except Exception as recovery_err:  # noqa: BLE001
                log(f"event recovery warning: {recovery_err!r}")
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=5)
        os.environ.pop("SESSION_API_KEY", None)
        if docker_workspace is not None:
            try:
                docker_workspace.cleanup()
            except Exception as cleanup_err:  # noqa: BLE001
                log(f"container cleanup warning: {cleanup_err!r}")
        shutil.rmtree(repo_dir, ignore_errors=True)
