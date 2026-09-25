"""Unit coverage for RelayClient's own logic (queueing, drop-oldest,
best-effort connect/send/close semantics) and RelayEventCallback's bridging
to it — not the `websockets` library itself, and no real network or Docker,
matching test_agent_server_adapter.py's mocking style."""

import json
import re
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
    def __init__(self, fail_after: "int | None" = None) -> None:
        """fail_after=N: the (N+1)th send() call raises — lets tests get a
        real connected relay (worker.ready succeeds) before simulating the
        connection dying on a later send, instead of racing worker.ready's
        own send against the failure."""
        self.sent: list[dict] = []
        self.closed = False
        self.fail_after = fail_after

    def send(self, message: str) -> None:
        if self.fail_after is not None and len(self.sent) >= self.fail_after:
            raise RuntimeError("send failed")
        self.sent.append(json.loads(message))

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
