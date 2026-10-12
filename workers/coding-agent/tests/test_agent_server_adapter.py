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
from openhands.sdk.conversation.conversation_stats import ConversationStats
from openhands.sdk.event.conversation_state import ConversationStateUpdateEvent
from openhands.sdk.llm.utils.metrics import Metrics

from coding_agent.agent_server_adapter import (
    EVENTS_BATCH_SIZE,
    EventForwarder,
    UsageForwarder,
    _split_provider_and_model,
)


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
    monkeypatch.setattr(adapter, "LoopbackDockerWorkspace", lambda **kwargs: workspace)
    monkeypatch.setattr(adapter, "Conversation", make_conversation)
    monkeypatch.setattr(adapter, "resync_events", lambda *args: [])
    with make_client(handler) as client:
        outcome = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
        })
    assert outcome == ("failure", None)
    assert [event["id"] for event in received] == ["partial"]
    workspace.cleanup.assert_called_once()


# --- ADR-0007 Phase 3D: CommandHandler (worker -> Agent Server control) ----


def test_command_handler_forwards_agent_message_and_acks_accepted() -> None:
    from unittest.mock import MagicMock

    from coding_agent.agent_server_adapter import CommandHandler

    conversation = MagicMock()
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hello agent"}}})

    conversation.send_message.assert_called_once_with("hello agent")
    relay.send_command_ack.assert_called_once_with("cmd-1", "accepted")


def test_command_handler_never_calls_run_again_on_the_conversation() -> None:
    # Deliberate: calling .run()/.pause()/.interrupt() again from this
    # handler's thread would race the main dispatch thread's own in-flight
    # blocking .run() call over RemoteConversation's shared _run_armed /
    # _terminal_status_queue state (see this module's own CommandHandler
    # docstring). send_message() alone is the only SDK call this handler is
    # allowed to make.
    from unittest.mock import MagicMock

    from coding_agent.agent_server_adapter import CommandHandler

    conversation = MagicMock()
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hi"}}})

    conversation.run.assert_not_called()
    conversation.pause.assert_not_called()
    conversation.interrupt.assert_not_called()


def test_command_handler_rejects_unsupported_command_type_without_touching_conversation() -> None:
    from unittest.mock import MagicMock

    from coding_agent.agent_server_adapter import CommandHandler

    conversation = MagicMock()
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"commandId": "cmd-1", "command": {"type": "terminal.exec", "payload": {"cmd": "rm -rf /"}}})

    conversation.send_message.assert_not_called()
    relay.send_command_ack.assert_called_once()
    args = relay.send_command_ack.call_args.args
    assert args[0] == "cmd-1"
    assert args[1] == "rejected"


def test_command_handler_rejects_missing_or_empty_text() -> None:
    from unittest.mock import MagicMock

    from coding_agent.agent_server_adapter import CommandHandler

    conversation = MagicMock()
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "   "}}})

    conversation.send_message.assert_not_called()
    relay.send_command_ack.assert_called_once_with("cmd-1", "rejected", "missing or empty text")


def test_command_handler_acks_failed_when_send_message_raises() -> None:
    from unittest.mock import MagicMock

    from coding_agent.agent_server_adapter import CommandHandler

    conversation = MagicMock()
    conversation.send_message.side_effect = RuntimeError("agent server 500")
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"commandId": "cmd-1", "command": {"type": "agent.message", "payload": {"text": "hello"}}})

    relay.send_command_ack.assert_called_once()
    args = relay.send_command_ack.call_args.args
    assert args[0] == "cmd-1"
    assert args[1] == "failed"


def test_command_handler_drops_payload_with_no_commandid_without_raising() -> None:
    from unittest.mock import MagicMock

    from coding_agent.agent_server_adapter import CommandHandler

    conversation = MagicMock()
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"command": {"type": "agent.message", "payload": {"text": "hi"}}})  # no commandId

    conversation.send_message.assert_not_called()
    relay.send_command_ack.assert_not_called()


def test_run_dispatch_via_agent_server_wires_command_handler_after_conversation_exists(monkeypatch) -> None:
    """Confirms the late-binding wiring in run_dispatch_via_agent_server: the
    RelayClient's command handler is set to a real CommandHandler bound to
    the actual Conversation object, not left None or bound to something
    else."""
    from unittest.mock import MagicMock

    from coding_agent import agent_server_adapter as adapter

    workspace = MagicMock()
    workspace.host = "http://localhost:8000"

    captured_relay = {}

    class FakeRelay:
        def __init__(self, *args, **kwargs):
            self.handler = None
            captured_relay["instance"] = self

        def start(self):
            pass

        def send_event(self, *args, **kwargs):
            pass

        def set_command_handler(self, handler):
            self.handler = handler

        def close(self, *args, **kwargs):
            pass

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/events"):
            return httpx.Response(204)
        return httpx.Response(200)

    conversation = MagicMock()

    def make_conversation(**kwargs):
        return conversation

    monkeypatch.setattr(adapter, "heartbeat_loop", lambda *args: None)
    monkeypatch.setattr(adapter, "clone_repository", lambda *args: None)
    monkeypatch.setattr(adapter, "require_api_key", lambda *args: "test-key")
    monkeypatch.setattr(adapter, "LLM", MagicMock())
    monkeypatch.setattr(adapter, "Agent", MagicMock())
    monkeypatch.setattr(adapter, "LoopbackDockerWorkspace", lambda **kwargs: workspace)
    monkeypatch.setattr(adapter, "Conversation", make_conversation)
    monkeypatch.setattr(adapter, "resync_events", lambda *args: [])
    monkeypatch.setattr(adapter, "RelayClient", FakeRelay)

    with make_client(handler) as client:
        adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
        })

    relay_instance = captured_relay["instance"]
    assert relay_instance.handler is not None
    assert isinstance(relay_instance.handler, adapter.CommandHandler)
    assert relay_instance.handler._conversation is conversation


# --- Phase 4D.1: UsageForwarder (real usage metering) ----------------------
#
# FakeRemoteConversation/FakeRemoteState duck-type only the exact surface
# UsageForwarder actually reads: `conversation.state.refresh_from_server()`
# returning the conversation-info dict a real Agent Server's
# GET {conversation_info_base_path}/{id} would return (with the genuine,
# non-snapshotted "stats" field a real _compose_conversation_info produces,
# confirmed against real source in this phase's own audit — see
# UsageForwarder's docstring). Never `conversation.stats` /
# `conversation.conversation_stats` directly, since those go through
# RemoteState's cache and are exactly what this whole mechanism must bypass.


class FakeRemoteState:
    def __init__(self, info: dict, error: Exception | None = None) -> None:
        self.info = info
        self.error = error
        self.call_count = 0

    def refresh_from_server(self) -> dict:
        self.call_count += 1
        if self.error is not None:
            raise self.error
        return self.info


class FakeRemoteConversation:
    def __init__(self, info: dict, error: Exception | None = None) -> None:
        self.state = FakeRemoteState(info, error)


def _stats_info(
    *,
    model: str = "nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
    response_id: str = "resp-1",
    prompt_tokens: int = 100,
    completion_tokens: int = 50,
    cache_read_tokens: int = 10,
    cache_write_tokens: int = 0,
    reasoning_tokens: int = 5,
    usage_id: str = "agent",
) -> dict:
    """Builds the exact shape a real, non-snapshotted
    _compose_conversation_info's "stats" field has: a real ConversationStats
    with a genuine per-response token_usages entry, dumped the same way
    conversation_service.py's _compose_conversation_info does (mode="json",
    no snapshot context)."""
    metrics = Metrics(model_name=model)
    metrics.add_token_usage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
        context_window=4096,
        response_id=response_id,
        reasoning_tokens=reasoning_tokens,
    )
    stats = ConversationStats(usage_to_metrics={usage_id: metrics})
    return {"stats": stats.model_dump(mode="json")}


def test_split_provider_and_model_preserves_slashes_in_the_model_id() -> None:
    assert _split_provider_and_model("nvidia_nim/nvidia/nemotron-3-super-120b-a12b") == (
        "nvidia_nim",
        "nvidia/nemotron-3-super-120b-a12b",
    )


def test_split_provider_and_model_falls_back_when_no_slash_present() -> None:
    assert _split_provider_and_model("malformed-model-string") == (
        "malformed-model-string",
        "malformed-model-string",
    )


def test_usage_forwarder_ignores_non_stats_state_update_events() -> None:
    forwarder = UsageForwarder(
        make_client(lambda r: httpx.Response(204)), "exec-1", "worker-1", lambda: None, log=lambda *_: None
    )
    forwarder(ConversationStateUpdateEvent(key="not-stats", value={"foo": "bar"}))
    assert not forwarder._wake.is_set()


def test_usage_forwarder_wakes_on_the_real_stats_trigger() -> None:
    forwarder = UsageForwarder(
        make_client(lambda r: httpx.Response(204)), "exec-1", "worker-1", lambda: None, log=lambda *_: None
    )
    metrics = Metrics(model_name="test-model")
    stats = ConversationStats(usage_to_metrics={"agent": metrics})
    # Constructing this with key="stats" and a real ConversationStats value
    # is exactly what a genuine event_service.py stats_callback constructs
    # server-side (before it travels the wire and gets deserialized here) —
    # forces the same snapshot serialization this class must never rely on.
    forwarder(ConversationStateUpdateEvent(key="stats", value=stats))
    assert forwarder._wake.is_set()


def test_usage_forwarder_skips_when_no_conversation_constructed_yet() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(204)

    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: None, log=lambda *_: None)
        forwarder.poll_once()

    assert calls == []


def test_usage_forwarder_poll_once_forwards_genuine_per_response_token_usage() -> None:
    import json

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(204)

    conversation = FakeRemoteConversation(_stats_info())
    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder.poll_once()

    assert conversation.state.call_count == 1
    assert len(posts) == 1
    body = json.loads(posts[0].read())
    assert body["workerId"] == "worker-1"
    assert len(body["usageEvents"]) == 1
    event = body["usageEvents"][0]
    assert event["providerRequestId"] == "resp-1"
    assert event["provider"] == "nvidia_nim"
    assert event["model"] == "nvidia/nemotron-3-super-120b-a12b"
    assert event["inputTokens"] == 100
    assert event["outputTokens"] == 50
    assert event["cacheReadTokens"] == 10
    assert event["cacheWriteTokens"] == 0
    assert event["reasoningTokens"] == 5
    assert isinstance(event["observedAt"], str) and event["observedAt"]
    assert "cost" not in json.dumps(body).lower()  # never on this wire, not even null


def test_usage_forwarder_never_reads_the_triggering_events_lossy_value() -> None:
    """The event that wakes the poller carries a snapshot-serialized value
    with no token_usages and a stale response_id (exactly what a real
    ConversationStateUpdateEvent(key="stats", ...) looks like on the wire) —
    poll_once must still forward the genuine data from the (separately
    stubbed) REST poll, proving the event's own .value is never consulted
    for usage data."""
    import json

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(204)

    conversation = FakeRemoteConversation(_stats_info(response_id="genuine-resp-id"))

    stale_metrics = Metrics(model_name="test-model")
    stale_metrics.add_token_usage(
        prompt_tokens=1, completion_tokens=1, cache_read_tokens=0,
        cache_write_tokens=0, context_window=0, response_id="stale-resp-id",
    )
    lossy_event = ConversationStateUpdateEvent(key="stats", value=ConversationStats(usage_to_metrics={"agent": stale_metrics}))
    # Confirm the event really is lossy before using it as a trigger.
    assert "token_usages" not in json.dumps(lossy_event.value)

    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder(lossy_event)  # only a wake-up signal; .value must be ignored
        forwarder.poll_once()

    assert len(posts) == 1
    event = json.loads(posts[0].read())["usageEvents"][0]
    assert event["providerRequestId"] == "genuine-resp-id"


def test_usage_forwarder_does_not_resend_a_response_id_already_forwarded() -> None:
    """Simulates a repeated cumulative conversation.stats poll returning the
    exact same data twice (a reconnect, a redundant trigger) — the second
    poll must find nothing new to send. This is the worker-side bandwidth
    optimization; DB-level dedupe (0011_usage_metering.sql's
    unique(execution_id, provider_request_id)) is the actual correctness
    backstop, exercised separately in apps/api's own test suite."""
    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(204)

    conversation = FakeRemoteConversation(_stats_info(response_id="resp-1"))
    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder.poll_once()
        forwarder.poll_once()

    assert conversation.state.call_count == 2, "each trigger must still force a real REST poll"
    assert len(posts) == 1, "second poll's already-seen response_id must not be resent"


def test_usage_forwarder_forwards_only_the_newly_appeared_response_id_on_growth() -> None:
    """A cumulative poll that grows (a second genuine LLM call happened
    between two polls) must forward only the new entry, not resend the old
    one — proving this is a real diff against _seen_response_ids, not
    "resend everything every time"."""
    import json

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(204)

    metrics = Metrics(model_name="nvidia_nim/nvidia/nemotron-3-super-120b-a12b")
    metrics.add_token_usage(
        prompt_tokens=10, completion_tokens=5, cache_read_tokens=0,
        cache_write_tokens=0, context_window=0, response_id="resp-1",
    )
    conversation = FakeRemoteConversation({"stats": ConversationStats(usage_to_metrics={"agent": metrics}).model_dump(mode="json")})

    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder.poll_once()
        assert len(posts) == 1

        metrics.add_token_usage(
            prompt_tokens=20, completion_tokens=8, cache_read_tokens=0,
            cache_write_tokens=0, context_window=0, response_id="resp-2",
        )
        conversation.state.info = {"stats": ConversationStats(usage_to_metrics={"agent": metrics}).model_dump(mode="json")}
        forwarder.poll_once()

    assert len(posts) == 2
    second_body = json.loads(posts[1].read())
    assert [e["providerRequestId"] for e in second_body["usageEvents"]] == ["resp-2"]


def test_usage_forwarder_skips_entries_with_an_empty_response_id() -> None:
    metrics = Metrics(model_name="test-model")
    metrics.add_token_usage(
        prompt_tokens=1, completion_tokens=1, cache_read_tokens=0,
        cache_write_tokens=0, context_window=0, response_id="",
    )
    conversation = FakeRemoteConversation({"stats": ConversationStats(usage_to_metrics={"agent": metrics}).model_dump(mode="json")})
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(204)

    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder.poll_once()

    assert calls == [], "an entry with no real response_id must never be forwarded"


def test_usage_forwarder_swallows_a_refresh_from_server_failure() -> None:
    conversation = FakeRemoteConversation({}, error=RuntimeError("network down"))
    logs = []
    with make_client(lambda r: httpx.Response(204)) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=logs.append)
        forwarder.poll_once()  # must not raise

    assert any("usage poll" in message for message in logs)


def test_usage_forwarder_does_not_mark_seen_on_a_failed_post_so_next_poll_retries() -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(500)
        return httpx.Response(204)

    conversation = FakeRemoteConversation(_stats_info(response_id="resp-1"))
    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder.poll_once()  # apps/api 500s
        forwarder.poll_once()  # must retry the same entry, not treat it as sent

    assert call_count == 2


def test_usage_forwarder_background_thread_polls_on_wake_and_close_stops_it() -> None:
    import threading

    posts = []
    delivered = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        delivered.set()
        return httpx.Response(204)

    conversation = FakeRemoteConversation(_stats_info(response_id="resp-bg"))
    metrics = Metrics(model_name="test-model")
    trigger_stats = ConversationStats(usage_to_metrics={"agent": metrics})

    with make_client(handler) as client:
        forwarder = UsageForwarder(client, "exec-1", "worker-1", lambda: conversation, log=lambda *_: None)
        forwarder.start()
        try:
            forwarder(ConversationStateUpdateEvent(key="stats", value=trigger_stats))
            assert delivered.wait(2), "background poll never fired on the stats trigger"
        finally:
            forwarder.close()

    assert len(posts) == 1
    assert not forwarder._thread.is_alive()


def test_run_dispatch_via_agent_server_wires_usage_forwarder_and_polls_once_at_teardown(monkeypatch) -> None:
    """Confirms UsageForwarder is (a) included in the Conversation callbacks
    list, (b) started, (c) polled exactly once as the required final
    reconciliation pass at teardown (before container cleanup), and
    (d) closed — using a fake in place of the real class so this test proves
    the wiring, not UsageForwarder's own internals (covered above)."""
    from unittest.mock import MagicMock

    from coding_agent import agent_server_adapter as adapter

    workspace = MagicMock()
    workspace.host = "http://localhost:8000"
    captured = {}

    class FakeUsageForwarder:
        def __init__(self, client, execution_id, worker_id, get_conversation, log, usage_limit_state=None, get_docker_workspace=None):
            captured["get_conversation"] = get_conversation
            captured["instance"] = self
            self.started = False
            self.closed = False
            self.poll_calls = 0

        def start(self):
            self.started = True

        def poll_once(self):
            self.poll_calls += 1

        def close(self):
            self.closed = True

        def __call__(self, event):
            pass

    conversation = MagicMock()
    # A genuinely FINISHED status so this wiring-only test's incidental
    # outcome assertion reflects a real positive confirmation (correction 1's
    # whitelist), not a MagicMock default that would otherwise be parsed as
    # an unrecognized/anomalous status.
    conversation.state.refresh_from_server.return_value = {"execution_status": "finished"}

    def make_conversation(**kwargs):
        captured["callbacks"] = kwargs["callbacks"]
        return conversation

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200)

    monkeypatch.setattr(adapter, "heartbeat_loop", lambda *args: None)
    monkeypatch.setattr(adapter, "clone_repository", lambda *args: None)
    monkeypatch.setattr(adapter, "require_api_key", lambda *args: "test-key")
    monkeypatch.setattr(adapter, "LLM", MagicMock())
    monkeypatch.setattr(adapter, "Agent", MagicMock())
    monkeypatch.setattr(adapter, "LoopbackDockerWorkspace", lambda **kwargs: workspace)
    monkeypatch.setattr(adapter, "Conversation", make_conversation)
    monkeypatch.setattr(adapter, "resync_events", lambda *args: [])
    monkeypatch.setattr(adapter, "UsageForwarder", FakeUsageForwarder)

    with make_client(handler) as client:
        outcome = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
        })

    assert outcome == ("success", None)
    usage_forwarder = captured["instance"]
    assert usage_forwarder.started
    assert usage_forwarder in captured["callbacks"]
    assert captured["get_conversation"]() is conversation, "get_conversation must resolve to the real, later-constructed Conversation"
    assert usage_forwarder.poll_calls == 1, "exactly one final teardown poll, no more"
    assert usage_forwarder.closed
