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
    OpenHands event dicts (the same ones EventForwarder already builds).
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
    ) -> None:
        self._api_url = api_url
        self._internal_token = internal_token
        self._worker_id = worker_id
        self._execution_id = execution_id
        self._log = log

        self._queue: deque[dict] = deque(maxlen=MAX_QUEUED_MESSAGES)
        self._queue_lock = threading.Lock()
        self._has_work = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
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
