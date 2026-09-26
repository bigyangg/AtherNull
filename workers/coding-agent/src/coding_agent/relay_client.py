"""Worker -> apps/api outbound realtime relay client (ADR-0007 Phase 3B).

Best-effort, additive-only companion to EventForwarder
(agent_server_adapter.py): EventForwarder's HTTP POST
/internal/executions/:id/events path remains the sole authoritative
persistence mechanism for the agent's event stream, completely unaffected by
anything in this module. This module's only job is to also hand the same
events to apps/api's realtime gateway over a second, independent channel —
one apps/api can later use for browser-facing streaming (Phase 3C+) — in a
way that can fail, stall, or never connect at all without changing the
dispatch's outcome by one bit.

Design constraints (see docs/adr/0007-secure-realtime-execution.md's Phase 3B
status section for the full rationale):
  - Trust direction: the worker always dials out to apps/api. apps/api never
    connects to the worker or to the Agent Server container, and this module
    never listens on anything.
  - SESSION_API_KEY must never appear anywhere in this module — not in the
    registration request, not in a message, not in a log line. This module
    never imports or references it; it only ever handles already-serialized
    OpenHands event dicts (the same ones EventForwarder already builds) and
    (Phase 3D) already-validated command dicts the gateway forwards.
  - Bounded, drop-oldest queue (MAX_QUEUED_MESSAGES): a slow or unreachable
    gateway must never grow unbounded memory on the worker, and must never
    block or slow down the actual dispatch. `send_event()` only ever
    enqueues; the network I/O happens entirely on this module's own
    background thread.
  - No reconnect-on-drop: worker.py's dispatch loop is a single, sequential,
    synchronous run per execution (no asyncio anywhere in this codebase —
    confirmed in ADR-0007's grounding audit). Once this relay's connection is
    gone (never connected, rejected at registration, or dropped mid-run), it
    stays gone for the rest of this dispatch, matching the worker's existing
    single-attempt style rather than adding new retry/backoff machinery this
    phase doesn't need. A future dispatch gets a brand-new RelayClient.

ADR-0007 Phase 3D addition: this tunnel is now bidirectional. In addition to
the existing outbound send thread (`_run`, above), a second background
thread (`_recv_run`) reads inbound `gateway.command` envelopes and invokes an
optional `on_command` callback supplied at construction time — this is how
an authorized browser command (already authorized by apps/api's gateway
before it ever reaches this process) reaches agent_server_adapter.py's own
command-handling code, which re-issues it against the local, authenticated
Agent Server connection using SESSION_API_KEY (never touched by this
module). This is safe to run concurrently with the main dispatch thread's
blocking `conversation.run()` call: the underlying
`websockets.sync.client` connection already runs its own internal
`recv_events` thread that continuously drains the socket into an in-library
queue (confirmed by reading `websockets/sync/connection.py` directly, not
assumed) — `.send()` from one thread and `.recv()` from another are both
just talking to that same thread-safe queue/protocol-mutex machinery the
library already provides, not two callers racing on the raw socket
themselves. `on_command`'s own body (agent_server_adapter.py's handler) runs
on this receive thread, never on the thread driving `.run()` — see that
module's own docstring for why it deliberately does NOT call
`conversation.run()` again from this thread.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from typing import Callable
from urllib.parse import urlencode

import websockets.sync.client as ws_client

RELAY_PROTOCOL_VERSION = 1
# Drop-oldest beyond this many queued-but-unsent messages — see module
# docstring's "bounded, drop-oldest queue" constraint. 200 comfortably covers
# EventForwarder's own EVENTS_BATCH_SIZE (20) many times over without ever
# letting a stalled relay accumulate unbounded memory on the worker.
MAX_QUEUED_MESSAGES = 200
CONNECT_TIMEOUT_SECONDS = 5.0
CLOSE_JOIN_TIMEOUT_SECONDS = 2.0


def relay_ws_url(api_url: str, execution_id: str, worker_id: str) -> str:
    """Builds the relay registration URL — matches apps/api/src/routes/
    relay.ts's route exactly: GET /internal/relay/:executionId?workerId=...,
    with INTERNAL_API_TOKEN carried as an Authorization header (see
    _connect below), not in the URL."""
    ws_base = api_url.replace("http://", "ws://").replace("https://", "wss://")
    query = urlencode({"workerId": worker_id})
    return f"{ws_base}/internal/relay/{execution_id}?{query}"


class RelayClient:
    """Holds one outbound relay connection for the duration of one dispatch.

    Registered as a second `Conversation` callback alongside (never instead
    of) EventForwarder — see agent_server_adapter.py's
    `callbacks=[forwarder, relay_callback]`. RemoteConversation invokes
    callbacks synchronously on the same thread driving `.run()`'s own event
    loop (confirmed: it never opens a second, competing WebSocket
    subscriber against the Agent Server) — `send_event()` only enqueues, so
    a slow or dead relay can never slow down the agent run itself.
    """

    def __init__(
        self,
        api_url: str,
        internal_token: str,
        worker_id: str,
        execution_id: str,
        log: Callable[[str], None] = print,
        on_command: Callable[[dict], None] | None = None,
    ) -> None:
        self._api_url = api_url
        self._internal_token = internal_token
        self._worker_id = worker_id
        self._execution_id = execution_id
        self._log = log
        # ADR-0007 Phase 3D: invoked (on the receive thread, never the main
        # dispatch thread) with the RelayCommandPayload dict
        # ({"commandId": ..., "command": {"type": ..., "payload": ...}})
        # every time a gateway.command envelope arrives for this execution.
        # None (the default) means this relay behaves exactly like Phase 3B
        # — a worker that never wired up command handling simply never acts
        # on anything received, matching this dispatch's own contract.
        self._on_command = on_command

        self._queue: deque[dict] = deque(maxlen=MAX_QUEUED_MESSAGES)
        self._queue_lock = threading.Lock()
        self._has_work = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._recv_thread: threading.Thread | None = None
        self._ws: ws_client.ClientConnection | None = None
        self._connected = threading.Event()
        self._dropped_count = 0

    # -- public API: every method here is safe to call unconditionally and
    # never raises — a caller (agent_server_adapter.py) must never need a
    # try/except around any of these to keep the dispatch's own outcome safe.

    def start(self) -> None:
        """Starts the background connect+send thread. Non-blocking — does
        not wait for the connection to succeed. Registration happening
        asynchronously (rather than blocking dispatch startup on it) is
        exactly what makes "gateway unreachable at registration time" a
        non-event for the dispatch."""
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def connected_within(self, timeout: float) -> bool:
        """Best-effort readiness check for callers that want to observe
        whether the relay came up (logging, verification/testing only).
        Dispatch logic must never branch on this — the relay is best-effort
        by design regardless of what this returns."""
        return self._connected.wait(timeout)

    def send_event(self, record: dict) -> None:
        """Enqueues one OpenHands event record — the same {id, kind,
        occurredAt, payload} shape EventForwarder already builds and already
        sends via the authoritative HTTP path — for best-effort relay.
        Never blocks on network I/O, never raises. A silent no-op once this
        relay is known to be gone (never connected, or dropped)."""
        try:
            envelope = {
                "version": RELAY_PROTOCOL_VERSION,
                "type": "execution.event",
                "executionId": self._execution_id,
                # The OpenHands event's own id — the same identity
                # execution_events.id already uses. Not a second scheme.
                "eventId": record["id"],
                "payload": record,
            }
            with self._queue_lock:
                if len(self._queue) == self._queue.maxlen:
                    self._dropped_count += 1
                self._queue.append(envelope)
            self._has_work.set()
        except Exception as err:  # noqa: BLE001 - must never affect the dispatch
            self._log(f"relay: failed to enqueue event (non-fatal): {err!r}")

    def set_command_handler(self, handler: Callable[[dict], None] | None) -> None:
        """Assigns (or clears) the callback the receive thread invokes for
        each inbound gateway.command payload. Supports late-binding: `start()`
        can be called before the caller has a `Conversation` object to bind a
        handler to (agent_server_adapter.py constructs RelayClient before
        Conversation, since the Conversation's own construction needs
        RelayEventCallback(relay), which needs `relay` to already exist) —
        the receive thread re-reads `self._on_command` on every message
        rather than capturing it once at thread-start time, so calling this
        after `start()` is safe and takes effect on the very next inbound
        command. A plain attribute assignment is safe to read from another
        thread without a lock in CPython (list/dict/attribute writes are
        already atomic here); no new lock is introduced for this alone."""
        self._on_command = handler

    def send_command_ack(self, command_id: str, status: str, detail: str | None = None) -> None:
        """Enqueues one worker.command_ack for a previously received
        gateway.command (ADR-0007 Phase 3D). `status` must be one of
        "accepted" | "rejected" | "failed" (apps/api/src/realtime/envelope.ts's
        RelayCommandAckPayloadSchema is the source of truth for this shape;
        duplicated here by necessity like every other envelope in this
        module). Never blocks, never raises — a lost ack becomes the
        browser's "uncertain" outcome, which is the deliberately safe v1
        behavior, not a bug in this method."""
        try:
            payload: dict = {"commandId": command_id, "status": status}
            if detail is not None:
                payload["detail"] = detail
            envelope = {
                "version": RELAY_PROTOCOL_VERSION,
                "type": "worker.command_ack",
                "executionId": self._execution_id,
                "eventId": None,
                "payload": payload,
            }
            with self._queue_lock:
                if len(self._queue) == self._queue.maxlen:
                    self._dropped_count += 1
                self._queue.append(envelope)
            self._has_work.set()
        except Exception as err:  # noqa: BLE001 - must never affect the dispatch
            self._log(f"relay: failed to enqueue command ack (non-fatal): {err!r}")

    def close(self, timeout: float = CLOSE_JOIN_TIMEOUT_SECONDS) -> None:
        """Best-effort flush + clean close. Never raises, never blocks
        longer than `timeout`. Safe to call even if the relay never
        connected (e.g. the gateway was unreachable at registration time)."""
        try:
            if self._connected.is_set():
                self._enqueue_lifecycle("execution.completed")
        except Exception:  # noqa: BLE001
            pass
        self._stop.set()
        self._has_work.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
        try:
            if self._ws is not None:
                self._ws.close()
        except Exception:  # noqa: BLE001
            pass
        if self._recv_thread is not None:
            self._recv_thread.join(timeout=timeout)

    @property
    def dropped_count(self) -> int:
        """How many queued messages were dropped (oldest-first) under
        backpressure — purely observational, never consulted by dispatch
        logic. Exposed for tests/verification."""
        return self._dropped_count

    @property
    def is_connected(self) -> bool:
        return self._connected.is_set()

    # -- internal --------------------------------------------------------

    def _enqueue_lifecycle(self, message_type: str) -> None:
        envelope = {
            "version": RELAY_PROTOCOL_VERSION,
            "type": message_type,
            "executionId": self._execution_id,
            "eventId": None,
            "payload": {"workerId": self._worker_id},
        }
        with self._queue_lock:
            self._queue.append(envelope)
        self._has_work.set()

    def _run(self) -> None:
        try:
            url = relay_ws_url(self._api_url, self._execution_id, self._worker_id)
            # INTERNAL_API_TOKEN travels as a header, exactly like every
            # other /internal/* call this worker already makes
            # (worker.py's api_headers()) — never in the URL, never a
            # substitute for SESSION_API_KEY, which this module never
            # touches at all.
            headers = {"Authorization": f"Bearer {self._internal_token}"}
            self._ws = ws_client.connect(url, additional_headers=headers, open_timeout=CONNECT_TIMEOUT_SECONDS)
        except Exception as err:  # noqa: BLE001
            # Gateway unreachable, registration rejected (lease no longer
            # owned by this worker, execution not RUNNING, bad/missing
            # token), or any other connect-time failure — the dispatch must
            # proceed exactly as if this module didn't exist.
            self._log(f"relay: connect failed, proceeding without a relay: {err!r}")
            return

        self._connected.set()
        self._enqueue_lifecycle("worker.ready")

        # ADR-0007 Phase 3D: start the inbound-command receive thread only
        # once the connection is up. If `_on_command` is None (no caller
        # opted into command handling — e.g. worker.py's plain
        # EXECUTION_ADAPTER=direct path, which never constructs a
        # RelayClient with one), the thread still runs but simply has
        # nothing to invoke — inbound gateway.command messages are received
        # and silently ignored rather than left unread on the socket.
        self._recv_thread = threading.Thread(target=self._recv_run, daemon=True)
        self._recv_thread.start()

        try:
            while not self._stop.is_set():
                self._has_work.wait(timeout=1.0)
                self._has_work.clear()
                while True:
                    with self._queue_lock:
                        if not self._queue:
                            break
                        envelope = self._queue.popleft()
                    try:
                        self._ws.send(json.dumps(envelope))
                    except Exception as err:  # noqa: BLE001
                        # The connection is gone. Stop trying to send for the
                        # rest of this dispatch — see module docstring on
                        # why this doesn't reconnect. The authoritative HTTP
                        # event path is completely unaffected by this.
                        self._log(f"relay: send failed, relay is now inactive for this dispatch: {err!r}")
                        self._connected.clear()
                        return
        finally:
            try:
                self._ws.close()
            except Exception:  # noqa: BLE001
                pass

    def _recv_run(self) -> None:
        """ADR-0007 Phase 3D receive loop. Runs on its own thread for the
        life of this relay connection. Reads inbound frames via the
        underlying library's own internal recv queue (see this module's
        docstring on why this is safe to run concurrently with `_run`'s send
        loop and with the main dispatch thread's blocking `.run()` call) and
        dispatches `gateway.command` envelopes to `_on_command`. Never raises
        out of this thread — an exception here must never affect the
        dispatch or the outbound send path."""
        while not self._stop.is_set():
            try:
                raw = self._ws.recv(timeout=1.0)
            except TimeoutError:
                continue
            except Exception:  # noqa: BLE001 - connection gone; stop receiving for this dispatch
                return

            try:
                envelope = json.loads(raw)
            except Exception as err:  # noqa: BLE001
                self._log(f"relay: received non-JSON message, ignoring: {err!r}")
                continue

            if not isinstance(envelope, dict):
                continue
            if envelope.get("type") != "gateway.command":
                # worker.ready/relay.heartbeat/etc are never sent to the
                # worker by apps/api today — a future message type arriving
                # here is simply ignored, matching relay.ts's own
                # log-and-ignore posture for anything it doesn't recognize.
                continue
            if envelope.get("executionId") != self._execution_id:
                self._log("relay: gateway.command executionId mismatch, ignoring")
                continue

            payload = envelope.get("payload")
            if not isinstance(payload, dict) or "commandId" not in payload or "command" not in payload:
                self._log("relay: malformed gateway.command payload, ignoring")
                continue

            if self._on_command is None:
                # A real, observed window (confirmed during this phase's own
                # real-execution verification, not just theorized): the
                # relay connects and registers with the gateway BEFORE
                # agent_server_adapter.py's set_command_handler() call, which
                # only happens once the Conversation object exists (several
                # HTTP/WS round trips later). A command arriving in that gap
                # is a real, deterministic condition this worker can already
                # detect — sending an explicit "rejected" ack here (instead
                # of silently dropping it, which used to leave the browser
                # waiting out the full ack-timeout window for a command that
                # was never going to be answered) turns an avoidable
                # "uncertain" into a fast, honest "rejected." Never treated
                # as "worker declined the command's content" — a browser or
                # user retrying moments later is expected to succeed.
                self.send_command_ack(payload["commandId"], "rejected", "worker is not ready to accept commands yet")
                continue
            try:
                self._on_command(payload)
            except Exception as err:  # noqa: BLE001 - must never affect the dispatch or this loop
                self._log(f"relay: on_command callback raised (non-fatal): {err!r}")
