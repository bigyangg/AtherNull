"""Unit coverage for RelayClient's own logic (queueing, drop-oldest,
best-effort connect/send/close semantics) and RelayEventCallback's bridging
to it — not the `websockets` library itself, and no real network or Docker,
matching test_agent_server_adapter.py's mocking style."""

import json
import re
import threading
import time
from unittest.mock import MagicMock

import os

os.environ.setdefault("WORKER_ID", "test-worker")
os.environ.setdefault("ATHERNULL_API_URL", "http://localhost:3001")
os.environ.setdefault("INTERNAL_API_TOKEN", "test-token")

from coding_agent import relay_client as relay_module
from coding_agent.relay_client import MAX_QUEUED_MESSAGES, RelayClient, relay_ws_url


def test_relay_ws_url_builds_expected_path_and_query() -> None:
    url = relay_ws_url("http://localhost:3001", "exec-1", "worker-1")
    assert url == "ws://localhost:3001/internal/relay/exec-1?workerId=worker-1"


def test_relay_ws_url_handles_https() -> None:
    url = relay_ws_url("https://api.example.com", "exec-1", "worker-1")
    assert url.startswith("wss://api.example.com/internal/relay/exec-1")


class FakeConnection:
    def __init__(self, fail_after: "int | None" = None, inbound: "list[str] | None" = None) -> None:
        """fail_after=N: the (N+1)th send() call raises — lets tests get a
        real connected relay (worker.ready succeeds) before simulating the
        connection dying on a later send, instead of racing worker.ready's
        own send against the failure.

        `inbound` (ADR-0007 Phase 3D): a queue of raw JSON strings `.recv()`
        pops one at a time (FIFO); once empty, `.recv()` raises
        `TimeoutError` on every call, matching the real
        `websockets.sync.client` connection's own documented behavior for a
        `timeout=` call with nothing to receive yet — see relay_client.py's
        `_recv_run` for why that specific exception is what triggers a
        "keep waiting" loop iteration rather than tearing down the receive
        thread.
        """
        self.sent: list[dict] = []
        self.closed = False
        self.fail_after = fail_after
        self._inbound = list(inbound or [])
        self._inbound_lock = threading.Lock()

    def send(self, message: str) -> None:
        if self.fail_after is not None and len(self.sent) >= self.fail_after:
            raise RuntimeError("send failed")
        self.sent.append(json.loads(message))

    def recv(self, timeout: float | None = None):
        if self.closed:
            # Real `websockets` semantics: recv() on an already-closed
            # connection raises (ConnectionClosed) rather than ever
            # returning/timing out — this is what actually terminates a
            # receive thread bound to a connection the outer reconnect loop
            # has moved on from (see relay_client.py's `_run`/`_recv_run`,
            # ADR-0007 Phase 3E).
            raise ConnectionError("recv on a closed connection")
        with self._inbound_lock:
            if self._inbound:
                return self._inbound.pop(0)
        # Real connection semantics: no message available within `timeout`.
        time.sleep(min(timeout or 0.05, 0.05))
        raise TimeoutError

    def push_inbound(self, raw: str) -> None:
        with self._inbound_lock:
            self._inbound.append(raw)

    def close(self, *args, **kwargs) -> None:
        self.closed = True


def make_relay(monkeypatch, connection: "FakeConnection | None" = None, connect_error: Exception | None = None) -> RelayClient:
    def fake_connect(url, **kwargs):
        if connect_error is not None:
            raise connect_error
        return connection

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    return RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)


def _wait_until(predicate, timeout: float = 2.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_send_event_delivers_over_the_connection_once_connected(monkeypatch) -> None:
    conn = FakeConnection()
    relay = make_relay(monkeypatch, connection=conn)
    relay.start()
    assert relay.connected_within(2.0)

    relay.send_event({"id": "evt-1", "kind": "MessageEvent", "occurredAt": "2026-01-01T00:00:00", "payload": {"x": 1}})

    assert _wait_until(lambda: any(m["type"] == "execution.event" for m in conn.sent))
    msg = next(m for m in conn.sent if m["type"] == "execution.event")
    assert msg["version"] == 1
    assert msg["executionId"] == "exec-1"
    assert msg["eventId"] == "evt-1"
    assert msg["payload"]["id"] == "evt-1"

    relay.close()
    assert conn.closed
    types = [m["type"] for m in conn.sent]
    assert types[0] == "worker.ready", "worker.ready must be sent first, right after connecting"
    assert "execution.completed" in types, "close() must send execution.completed when the relay was connected"


def test_connect_failure_never_raises_and_dispatch_can_proceed(monkeypatch) -> None:
    relay = make_relay(monkeypatch, connect_error=OSError("connection refused"))
    relay.start()
    assert relay.connected_within(1.0) is False
    relay.send_event({"id": "evt-1", "kind": "K", "occurredAt": "t", "payload": {}})  # must be a silent no-op
    relay.close()  # must not raise or hang


def test_close_without_ever_starting_is_safe(monkeypatch) -> None:
    relay = make_relay(monkeypatch, connection=FakeConnection())
    relay.close()  # never started — must be a no-op, not an error


def test_send_failure_marks_relay_inactive_and_stops_trying(monkeypatch) -> None:
    # fail_after=1: worker.ready (sent immediately on connect) succeeds, the
    # next send (our explicit event) fails — simulating the connection
    # dying mid-dispatch rather than racing the very first send.
    conn = FakeConnection(fail_after=1)
    relay = make_relay(monkeypatch, connection=conn)
    relay.start()
    assert relay.connected_within(2.0)
    assert _wait_until(lambda: len(conn.sent) >= 1)  # worker.ready landed

    relay.send_event({"id": "evt-1", "kind": "K", "occurredAt": "t", "payload": {}})
    assert _wait_until(lambda: not relay.is_connected)

    relay.close()  # must still not raise despite the connection already being dead


def test_queue_drops_oldest_under_backpressure(monkeypatch) -> None:
    # The bounded deque (maxlen=MAX_QUEUED_MESSAGES) is what actually
    # provides drop-oldest semantics — verified directly against the same
    # mechanism send_event() uses, without needing to actually stall a
    # background sender thread to produce backpressure.
    relay = make_relay(monkeypatch, connection=FakeConnection())
    for i in range(MAX_QUEUED_MESSAGES + 10):
        with relay._queue_lock:
            if len(relay._queue) == relay._queue.maxlen:
                relay._dropped_count += 1
            relay._queue.append({"i": i})
    assert len(relay._queue) == MAX_QUEUED_MESSAGES
    assert relay._queue[0]["i"] == 10, "the oldest 10 entries must have been dropped, not the newest"
    assert relay.dropped_count == 10


def test_send_event_never_raises_even_on_internal_error(monkeypatch) -> None:
    relay = make_relay(monkeypatch, connection=FakeConnection())
    relay._queue = None  # sabotage internal state to force an exception path
    relay.send_event({"id": "evt-1", "kind": "K", "occurredAt": "t", "payload": {}})  # must not raise


class FakeEvent:
    def __init__(self, event_id: str, kind: str, timestamp: str) -> None:
        self.id = event_id
        self.timestamp = timestamp
        self._kind = kind

    def model_dump(self, mode: str = "python") -> dict:
        return {"kind": self._kind, "id": self.id, "timestamp": self.timestamp}


def test_relay_event_callback_forwards_the_same_record_shape_as_event_forwarder() -> None:
    from coding_agent.agent_server_adapter import RelayEventCallback

    relay = MagicMock()
    callback = RelayEventCallback(relay)
    callback(FakeEvent("evt-1", "MessageEvent", "2026-01-01T00:00:00"))

    relay.send_event.assert_called_once()
    (record,) = relay.send_event.call_args.args
    assert record["id"] == "evt-1"
    assert record["kind"] == "MessageEvent"
    assert record["occurredAt"] == "2026-01-01T00:00:00"


def test_relay_event_callback_never_raises_even_if_relay_is_broken() -> None:
    from coding_agent.agent_server_adapter import RelayEventCallback

    relay = MagicMock()
    relay.send_event.side_effect = RuntimeError("boom")
    callback = RelayEventCallback(relay)
    callback(FakeEvent("evt-1", "MessageEvent", "2026-01-01T00:00:00"))  # must not raise


# --- ADR-0007 Phase 3D: receive loop / command ack ---------------------


def test_recv_run_invokes_on_command_for_a_valid_gateway_command(monkeypatch) -> None:
    conn = FakeConnection()
    received = []

    def fake_connect(url, **kwargs):
        return conn

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient(
        "http://localhost:3001", "test-token", "worker-1", "exec-1",
        log=lambda *_: None, on_command=lambda payload: received.append(payload),
    )
    relay.start()
    assert relay.connected_within(2.0)

    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "exec-1", "eventId": None,
        "payload": {"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hi"}}},
    }))

    assert _wait_until(lambda: len(received) == 1)
    assert received[0]["commandId"] == "cmd-1"
    assert received[0]["command"]["type"] == "agent.message"

    relay.close()


def test_recv_run_ignores_command_for_a_different_execution_id(monkeypatch) -> None:
    conn = FakeConnection()
    received = []

    monkeypatch.setattr(relay_module.ws_client, "connect", lambda url, **kwargs: conn)
    relay = RelayClient(
        "http://localhost:3001", "test-token", "worker-1", "exec-1",
        log=lambda *_: None, on_command=lambda payload: received.append(payload),
    )
    relay.start()
    assert relay.connected_within(2.0)

    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "some-other-exec", "eventId": None,
        "payload": {"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hi"}}},
    }))

    time.sleep(0.3)
    assert received == []

    relay.close()


def test_recv_run_ignores_malformed_payload_without_raising(monkeypatch) -> None:
    conn = FakeConnection()
    received = []

    monkeypatch.setattr(relay_module.ws_client, "connect", lambda url, **kwargs: conn)
    relay = RelayClient(
        "http://localhost:3001", "test-token", "worker-1", "exec-1",
        log=lambda *_: None, on_command=lambda payload: received.append(payload),
    )
    relay.start()
    assert relay.connected_within(2.0)

    conn.push_inbound("not valid json{{{")
    conn.push_inbound(json.dumps({"version": 1, "type": "gateway.command", "executionId": "exec-1", "payload": "not-a-dict"}))
    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "exec-1",
        "payload": {"commandId": "cmd-2", "command": {"type": "agent.message", "payload": {"text": "still works"}}},
    }))

    assert _wait_until(lambda: len(received) == 1)
    assert received[0]["commandId"] == "cmd-2"

    relay.close()


def test_recv_run_sends_explicit_rejection_ack_when_on_command_is_none(monkeypatch) -> None:
    # ADR-0007 Phase 3D, confirmed against a real execution during this
    # phase's own verification: a gateway.command can genuinely arrive
    # before agent_server_adapter.py's late set_command_handler() call runs
    # (the relay registers with the gateway before Conversation's own
    # construction finishes). Rather than silently dropping it (which used
    # to leave the browser waiting out the full ack-timeout window for a
    # command that could never be answered), the receive loop must send an
    # explicit "rejected" ack for this specific, detectable condition.
    conn = FakeConnection()
    monkeypatch.setattr(relay_module.ws_client, "connect", lambda url, **kwargs: conn)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()
    assert relay.connected_within(2.0)

    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "exec-1",
        "payload": {"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hi"}}},
    }))

    assert _wait_until(lambda: any(m["type"] == "worker.command_ack" for m in conn.sent))
    ack = next(m for m in conn.sent if m["type"] == "worker.command_ack")
    assert ack["payload"]["commandId"] == "cmd-1"
    assert ack["payload"]["status"] == "rejected"

    relay.close()


def test_on_command_exception_does_not_kill_the_receive_thread(monkeypatch) -> None:
    conn = FakeConnection()
    call_count = {"n": 0}

    def flaky_handler(payload):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise RuntimeError("boom")

    monkeypatch.setattr(relay_module.ws_client, "connect", lambda url, **kwargs: conn)
    relay = RelayClient(
        "http://localhost:3001", "test-token", "worker-1", "exec-1",
        log=lambda *_: None, on_command=flaky_handler,
    )
    relay.start()
    assert relay.connected_within(2.0)

    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "exec-1",
        "payload": {"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "first"}}},
    }))
    assert _wait_until(lambda: call_count["n"] == 1)

    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "exec-1",
        "payload": {"commandId": "cmd-2", "command": {"type": "agent.message", "payload": {"text": "second"}}},
    }))
    assert _wait_until(lambda: call_count["n"] == 2), "a raised exception in on_command must not kill the receive loop"

    relay.close()


def test_set_command_handler_late_binding_takes_effect(monkeypatch) -> None:
    conn = FakeConnection()
    monkeypatch.setattr(relay_module.ws_client, "connect", lambda url, **kwargs: conn)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()
    assert relay.connected_within(2.0)

    received = []
    relay.set_command_handler(lambda payload: received.append(payload))

    conn.push_inbound(json.dumps({
        "version": 1, "type": "gateway.command", "executionId": "exec-1",
        "payload": {"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hi"}}},
    }))
    assert _wait_until(lambda: len(received) == 1)

    relay.close()


def test_send_command_ack_delivers_worker_command_ack_envelope(monkeypatch) -> None:
    conn = FakeConnection()
    relay = make_relay(monkeypatch, connection=conn)
    relay.start()
    assert relay.connected_within(2.0)

    relay.send_command_ack("cmd-1", "accepted")
    assert _wait_until(lambda: any(m["type"] == "worker.command_ack" for m in conn.sent))
    msg = next(m for m in conn.sent if m["type"] == "worker.command_ack")
    assert msg["executionId"] == "exec-1"
    assert msg["payload"] == {"commandId": "cmd-1", "status": "accepted"}

    relay.send_command_ack("cmd-2", "failed", "boom")
    assert _wait_until(lambda: len([m for m in conn.sent if m["type"] == "worker.command_ack"]) == 2)
    msg2 = [m for m in conn.sent if m["type"] == "worker.command_ack"][1]
    assert msg2["payload"] == {"commandId": "cmd-2", "status": "failed", "detail": "boom"}

    relay.close()


def test_send_command_ack_never_raises_even_if_relay_never_connected(monkeypatch) -> None:
    relay = make_relay(monkeypatch, connect_error=OSError("connection refused"))
    relay.start()
    assert relay.connected_within(0.5) is False
    relay.send_command_ack("cmd-1", "accepted")  # must not raise
    relay.close()


# --- static source-level safety assertions ---------------------------------
# Mirrors apps/api/test/openhands-compat.test.ts's stripComments() check,
# adapted for Python: docstrings/comments may explain the invariant, but the
# executable code must never touch SESSION_API_KEY.


def _strip_python_comments_and_docstrings(source: str) -> str:
    no_docstrings = re.sub(r'"""[\s\S]*?"""', "", source)
    no_docstrings = re.sub(r"'''[\s\S]*?'''", "", no_docstrings)
    lines = []
    for line in no_docstrings.splitlines():
        idx = line.find("#")
        lines.append(line if idx == -1 else line[:idx])
    return "\n".join(lines)


def test_relay_client_module_never_references_session_api_key_outside_docs() -> None:
    import inspect

    source = inspect.getsource(relay_module)
    assert "SESSION_API_KEY" in source, "sanity: the module docstring should still explain the invariant"
    code_only = _strip_python_comments_and_docstrings(source)
    assert "SESSION_API_KEY" not in code_only, "relay_client.py's executable code must never reference SESSION_API_KEY"


# --- ADR-0007 Phase 3E: bounded worker relay reconnect ---------------------
# Every attempt here uses a fake `connect()` (monkeypatched onto the module,
# same convention as `make_relay` above) — no real network, no real
# `websockets` handshake — so these tests run in milliseconds/seconds, not
# by actually waiting out MAX_BACKOFF_SECONDS-scale delays.


class _FakeInvalidStatusResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


def _make_invalid_status(status_code: int) -> "relay_module.InvalidStatus":
    return relay_module.InvalidStatus(_FakeInvalidStatusResponse(status_code))


def test_reconnects_after_a_transient_connect_failure(monkeypatch) -> None:
    """A transient failure (connection refused) followed by a real
    connection must be retried — this is the core Phase 3E behavior Phase 3B
    explicitly did not have ("no reconnect-on-drop")."""
    good_conn = FakeConnection()
    attempts = {"n": 0}

    def fake_connect(url, **kwargs):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise OSError("connection refused")
        return good_conn

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()

    assert relay.connected_within(5.0), "must eventually connect after one transient failure"
    assert attempts["n"] == 2, "exactly one failed attempt, then one successful attempt"
    assert relay.reconnect_count == 1

    relay.close()


def test_terminal_handshake_rejection_stops_reconnecting_immediately(monkeypatch) -> None:
    """A 409 (lease no longer owned / not RUNNING) — or 401/403/404 — is a
    definitive, Postgres-backed rejection from the gateway (routes/relay.ts's
    preValidation). Retrying it can never succeed for this dispatch, so the
    client must give up on the FIRST such rejection, never retry it."""
    attempts = {"n": 0}

    def fake_connect(url, **kwargs):
        attempts["n"] += 1
        raise _make_invalid_status(409)

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()

    assert relay.connected_within(1.0) is False
    # Give the background thread ample time to have retried if (incorrectly)
    # it were treating this as transient — it must not have.
    time.sleep(1.0)
    assert attempts["n"] == 1, "a terminal handshake rejection must never be retried"
    assert relay.reconnect_count == 0

    relay.close()  # must not raise or hang


def test_gives_up_after_max_reconnect_attempts_on_persistent_transient_failure(monkeypatch) -> None:
    """A connection that never succeeds (always a transient-looking failure)
    must not retry forever — bounded, not a tight infinite loop."""
    # Shrink the backoff bounds for this test only, so asserting the loop
    # actually gives up doesn't require waiting out production-scale
    # (up to ~90s worst case) backoff delays.
    monkeypatch.setattr(relay_module, "BASE_BACKOFF_SECONDS", 0.01)
    monkeypatch.setattr(relay_module, "MAX_BACKOFF_SECONDS", 0.05)

    attempts = {"n": 0}

    def fake_connect(url, **kwargs):
        attempts["n"] += 1
        raise OSError("connection refused")

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()

    # The background thread must terminate on its own once it gives up —
    # join (not just an is_connected check) proves the retry loop actually
    # exited rather than merely being between backoff sleeps.
    relay._thread.join(timeout=10.0)
    assert not relay._thread.is_alive(), "the reconnect loop must give up and exit on its own, not retry forever"
    assert attempts["n"] == relay_module.MAX_RECONNECT_ATTEMPTS + 1, (
        "exactly one initial attempt plus MAX_RECONNECT_ATTEMPTS retries, never unbounded"
    )
    assert relay.is_connected is False

    relay.close()  # must still be safe to call after the loop already exited


def test_a_connection_that_dies_immediately_after_connecting_is_also_bounded(monkeypatch) -> None:
    """A connection that succeeds at the handshake but is torn down on the
    very next send (e.g. the gateway accepts the upgrade and then the
    underlying TCP path dies) must count toward the SAME bounded retry
    budget as an outright connect failure — otherwise a connect-then-die
    cycle could spin as a tight loop forever, never hitting the
    connect-exception branch's own attempt counter."""
    monkeypatch.setattr(relay_module, "BASE_BACKOFF_SECONDS", 0.01)
    monkeypatch.setattr(relay_module, "MAX_BACKOFF_SECONDS", 0.05)

    attempts = {"n": 0}

    def fake_connect(url, **kwargs):
        attempts["n"] += 1
        # Every connection immediately fails its first real send (fail_after=0).
        return FakeConnection(fail_after=0)

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()
    relay.send_event({"id": "evt-1", "kind": "K", "occurredAt": "t", "payload": {}})

    relay._thread.join(timeout=10.0)
    assert not relay._thread.is_alive(), "connect-then-immediately-die must also give up, not loop forever"
    assert attempts["n"] <= relay_module.MAX_RECONNECT_ATTEMPTS + 1

    relay.close()


def test_queued_events_survive_a_reconnect(monkeypatch) -> None:
    """An event enqueued while disconnected must still be delivered once a
    reconnect succeeds — the outbound queue is not cleared across
    reconnects."""
    good_conn = FakeConnection()
    attempts = {"n": 0}

    def fake_connect(url, **kwargs):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise OSError("connection refused")
        return good_conn

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()
    # Enqueued before the relay has ever successfully connected.
    relay.send_event({"id": "evt-during-outage", "kind": "K", "occurredAt": "t", "payload": {}})

    assert relay.connected_within(5.0)
    assert _wait_until(lambda: any(m.get("eventId") == "evt-during-outage" for m in good_conn.sent))

    relay.close()


def test_reconnect_receive_thread_does_not_race_a_subsequent_reconnect(monkeypatch) -> None:
    """Regression coverage for the exact race the Phase 3E implementation
    comment calls out: a receive thread must be bound to the specific
    connection object it was started for, never re-read `self._ws`, or a
    slow-to-notice-death old thread could start reading a brand new
    connection concurrently with that new connection's own receive thread."""
    connections = [FakeConnection(), FakeConnection()]
    attempts = {"n": 0}

    def fake_connect(url, **kwargs):
        conn = connections[attempts["n"]]
        attempts["n"] += 1
        return conn

    monkeypatch.setattr(relay_module.ws_client, "connect", fake_connect)
    relay = RelayClient("http://localhost:3001", "test-token", "worker-1", "exec-1", log=lambda *_: None)
    relay.start()
    assert relay.connected_within(2.0)
    first_recv_thread = relay._recv_thread

    # Kill the first connection's send path (simulating a drop) and let the
    # background thread reconnect onto the second fake connection.
    connections[0].fail_after = 0
    relay.send_event({"id": "evt-1", "kind": "K", "occurredAt": "t", "payload": {}})
    assert _wait_until(lambda: attempts["n"] == 2, timeout=15.0), "must reconnect onto the second connection"
    assert _wait_until(lambda: relay.is_connected, timeout=5.0)

    # The old receive thread (bound to connections[0]) must have exited on
    # its own — never still running and never the same thread object driving
    # the new connection.
    assert _wait_until(lambda: not first_recv_thread.is_alive(), timeout=5.0)
    assert relay._recv_thread is not first_recv_thread

    relay.close()


def test_relay_wiring_in_agent_server_adapter_never_passes_the_session_key_to_the_relay() -> None:
    import inspect

    from coding_agent import agent_server_adapter

    source = inspect.getsource(agent_server_adapter)
    code_only = _strip_python_comments_and_docstrings(source)
    # agent_server_adapter.py legitimately uses SESSION_API_KEY/session_key
    # elsewhere (the Docker workspace/container leg) — this check is
    # deliberately scoped to the RelayClient construction call itself,
    # rather than asserting the whole file never mentions it (which would be
    # false, and rightly so).
    start = code_only.index("RelayClient(")
    relay_construction = code_only[start : start + 400]
    assert "session_key" not in relay_construction
    assert "SESSION_API_KEY" not in relay_construction
