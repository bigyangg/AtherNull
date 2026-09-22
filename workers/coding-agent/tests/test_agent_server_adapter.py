"""Unit coverage for agent_server_adapter's own logic — event batching and
idempotency-key shape — not the OpenHands SDK itself. Fake events are plain
objects duck-typing the .id/.timestamp/.model_dump() surface EventForwarder
actually reads, so these tests don't depend on constructing a real SDK Event
subclass."""

import os

os.environ.setdefault("WORKER_ID", "test-worker")
os.environ.setdefault("ATHERNULL_API_URL", "http://localhost:3001")
os.environ.setdefault("INTERNAL_API_TOKEN", "test-token")

import httpx
import pytest

from coding_agent.agent_server_adapter import EVENTS_BATCH_SIZE, EventForwarder


class FakeEvent:
    def __init__(self, event_id: str, kind: str, timestamp: str) -> None:
        self.id = event_id
        self.timestamp = timestamp
        self._kind = kind

    def model_dump(self, mode: str = "python") -> dict:
        return {"kind": self._kind, "id": self.id, "timestamp": self.timestamp}


def make_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_forwarder_flushes_at_batch_size() -> None:
    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(204)

    forwarder = EventForwarder(make_client(handler), "exec-1", "worker-1")
    for i in range(EVENTS_BATCH_SIZE - 1):
        forwarder(FakeEvent(f"id-{i}", "MessageEvent", f"2026-01-01T00:00:{i:02d}"))
    assert len(posts) == 0  # below threshold, no flush yet

    forwarder(FakeEvent(f"id-{EVENTS_BATCH_SIZE - 1}", "MessageEvent", "2026-01-01T00:00:99"))
    assert len(posts) == 1
    body = posts[0].read()
    assert b"worker-1" in body
    assert forwarder.last_occurred_at == "2026-01-01T00:00:99"


def test_forwarder_manual_flush_sends_partial_batch() -> None:
    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(204)

    forwarder = EventForwarder(make_client(handler), "exec-1", "worker-1")
    forwarder(FakeEvent("id-0", "SystemPromptEvent", "2026-01-01T00:00:00"))
    forwarder.flush()

    assert len(posts) == 1
    assert forwarder.last_occurred_at == "2026-01-01T00:00:00"


def test_forwarder_keeps_buffer_on_failed_post_for_retry() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    forwarder = EventForwarder(make_client(handler), "exec-1", "worker-1")
    forwarder(FakeEvent("id-0", "MessageEvent", "2026-01-01T00:00:00"))
    forwarder.flush()

    # A failed POST must not drop the batch — it has to survive for the next
    # flush to retry, otherwise a transient apps/api hiccup silently loses
    # events with no other recovery path for that gap.
    assert forwarder.last_occurred_at is None
    assert len(forwarder._buffer) == 1


def test_forwarder_retries_and_succeeds_on_next_flush() -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(500)
        return httpx.Response(204)

    forwarder = EventForwarder(make_client(handler), "exec-1", "worker-1")
    forwarder(FakeEvent("id-0", "MessageEvent", "2026-01-01T00:00:00"))
    forwarder.flush()
    assert len(forwarder._buffer) == 1

    forwarder.flush()
    assert len(forwarder._buffer) == 0
    assert forwarder.last_occurred_at == "2026-01-01T00:00:00"


def test_forwarder_flush_is_noop_when_buffer_empty() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(204)

    forwarder = EventForwarder(make_client(handler), "exec-1", "worker-1")
    forwarder.flush()
    assert calls == []


@pytest.mark.parametrize("_", range(5))
def test_session_key_generation_is_random_and_hex(_: int) -> None:
    import secrets

    key = secrets.token_hex(32)
    assert len(key) == 64
    int(key, 16)  # raises ValueError if not valid hex


def test_periodic_flush_delivers_partial_batch() -> None:
    import threading

    delivered = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        delivered.set()
        return httpx.Response(204)

    with make_client(handler) as client:
        forwarder = EventForwarder(client, "exec-1", "worker-1")
        forwarder.start(interval=0.01)
        try:
            forwarder(FakeEvent("id-0", "MessageEvent", "2026-01-01T00:00:00"))
            assert delivered.wait(2), "partial batch never reached the API"
        finally:
            forwarder.close()
        assert forwarder._buffer == []
        assert not forwarder._thread.is_alive()


def test_concurrent_flushes_do_not_drop_new_events() -> None:
    import json
    import threading

    entered = threading.Event()
    release = threading.Event()
    received = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.extend(record["id"] for record in json.loads(request.content)["events"])
        entered.set()
        assert release.wait(2)
        return httpx.Response(204)

    with make_client(handler) as client:
        forwarder = EventForwarder(client, "exec-1", "worker-1")
        forwarder(FakeEvent("first", "MessageEvent", "2026-01-01T00:00:00"))
        first = threading.Thread(target=forwarder.flush)
        second = threading.Thread(target=forwarder.flush)
        first.start()
        try:
            assert entered.wait(2)
            second.start()
            forwarder(FakeEvent("second", "MessageEvent", "2026-01-01T00:00:01"))
        finally:
            release.set()
            first.join(2)
            if second.ident is not None:
                second.join(2)
        assert received == ["first", "second"]
        assert forwarder._buffer == []


def test_failed_run_flushes_before_container_cleanup(monkeypatch) -> None:
    import json
    from unittest.mock import MagicMock
    from coding_agent import agent_server_adapter as adapter

    received = []
    workspace = MagicMock()
    workspace.host = "http://localhost:8000"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/events"):
            received.extend(json.loads(request.content)["events"])
            return httpx.Response(204)
        return httpx.Response(200)

    def make_conversation(**kwargs):
        conversation = MagicMock()
        def fail():
            kwargs["callbacks"][0](FakeEvent("partial", "MessageEvent", "2026-01-01T00:00:00"))
            raise RuntimeError("agent failed")
        conversation.run.side_effect = fail
        return conversation

    def cleanup():
        assert [event["id"] for event in received] == ["partial"]

    workspace.cleanup.side_effect = cleanup
    monkeypatch.setattr(adapter, "heartbeat_loop", lambda *args: None)
    monkeypatch.setattr(adapter, "clone_repository", lambda *args: None)
    monkeypatch.setattr(adapter, "require_api_key", lambda *args: "test-key")
    monkeypatch.setattr(adapter, "LLM", MagicMock())
    monkeypatch.setattr(adapter, "Agent", MagicMock())
    monkeypatch.setattr(adapter, "DockerWorkspace", lambda **kwargs: workspace)
    monkeypatch.setattr(adapter, "Conversation", make_conversation)
    monkeypatch.setattr(adapter, "resync_events", lambda *args: [])
    with make_client(handler) as client:
        outcome = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
        })
    assert outcome == "failure"
    assert [event["id"] for event in received] == ["partial"]
    workspace.cleanup.assert_called_once()
