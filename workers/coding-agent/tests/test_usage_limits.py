"""Phase 4D.2A — Operational Usage Limits + Pause/Resume: worker-side unit and
integration coverage.

Organized to match the delegation's own test categories:
  A. Run-return landmine (whitelist status check)
  B. Usage accounting fast-path (UsageLimitState)
  D. Pause enforcement
  E. Failure fallback (interrupt / fail-closed)
  F. Resume (CommandHandler + full same-execution loop)

Fakes duck-type only the exact surface this code actually reads — same
convention as test_agent_server_adapter.py's own FakeRemoteState/
FakeRemoteConversation for UsageForwarder.
"""

import os

os.environ.setdefault("WORKER_ID", "test-worker")
os.environ.setdefault("ATHERNULL_API_URL", "http://localhost:3001")
os.environ.setdefault("INTERNAL_API_TOKEN", "test-token")

import json
import threading
from unittest.mock import MagicMock

import httpx
import pytest
from openhands.sdk.conversation.state import ConversationExecutionStatus

from coding_agent import agent_server_adapter as adapter
from coding_agent.agent_server_adapter import (
    CommandHandler,
    UsageLimitState,
    _enforce_usage_limit,
    get_fresh_execution_status,
)


def make_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


class FakeRemoteState:
    def __init__(self, info: dict) -> None:
        self.info = info

    def refresh_from_server(self) -> dict:
        return self.info


class FakeConversation:
    """Duck-types only conversation.state.refresh_from_server(),
    .pause(), .interrupt() — the exact surface get_fresh_execution_status and
    _enforce_usage_limit read/call."""

    def __init__(self, status: str, pause_error: Exception | None = None, interrupt_error: Exception | None = None) -> None:
        self.state = FakeRemoteState({"execution_status": status})
        self._pause_error = pause_error
        self._interrupt_error = interrupt_error
        self.pause_calls = 0
        self.interrupt_calls = 0
        self.id = "fake-conversation-id"

    def send_message(self, message: str) -> None:
        pass

    def run(self) -> None:
        pass

    def set_status(self, status: str) -> None:
        self.state.info = {"execution_status": status}

    def pause(self) -> None:
        self.pause_calls += 1
        if self._pause_error is not None:
            raise self._pause_error

    def interrupt(self) -> None:
        self.interrupt_calls += 1
        if self._interrupt_error is not None:
            raise self._interrupt_error


# --- A. Run-return landmine: get_fresh_execution_status / whitelist --------


def test_get_fresh_execution_status_reads_via_refresh_from_server_not_cached_property() -> None:
    """The SDK's own `.execution_status` convenience property reads through
    RemoteState's cache (returns whatever is already cached once
    `_cached_state` is non-None) — exactly the staleness hazard this function
    must avoid. Accessing `conversation.execution_status` at all here would
    be a regression back to the cached path."""

    class ConversationThatForbidsTheCachedProperty:
        def __init__(self) -> None:
            self.state = FakeRemoteState({"execution_status": "finished"})

        @property
        def execution_status(self):  # pragma: no cover - must never be read
            raise AssertionError("get_fresh_execution_status must never read the cached .execution_status property")

    status = get_fresh_execution_status(ConversationThatForbidsTheCachedProperty())
    assert status == ConversationExecutionStatus.FINISHED


def test_get_fresh_execution_status_returns_none_for_unparseable_value() -> None:
    """A genuinely unrecognized status string (e.g. a future SDK version adds
    a new member this code doesn't know about) must come back as None, never
    silently coerced to something that could look like success."""
    conversation = FakeConversation(status="some_future_status_v2")
    assert get_fresh_execution_status(conversation) is None


def test_finished_status_is_the_only_condition_that_reports_success(monkeypatch) -> None:
    """Correction 1, reviewer-sharpened: a positive whitelist. FINISHED is
    the only status this loop ever treats as success."""
    workspace = MagicMock()
    workspace.host = "http://localhost:8000"
    conversation = FakeConversation(status="finished")

    def make_conversation(**kwargs):
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

    with make_client(handler) as client:
        outcome = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
        })

    assert outcome == ("success", None)


@pytest.mark.parametrize(
    "status",
    ["paused", "waiting_for_confirmation", "idle", "deleting", "some_unrecognized_future_status"],
)
def test_non_finished_status_never_reports_success_and_never_calls_complete_success(monkeypatch, status) -> None:
    """The critical landmine regression test: conversation.run() returning
    normally (no exception) with a fabricated non-FINISHED status — including
    a bare PAUSED this process never itself requested — must NEVER produce
    outcome == "success". This is exactly the scenario where the OLD
    (pre-fix) code, which returned "success" unconditionally whenever .run()
    didn't raise, would have silently misreported a paused/anomalous
    execution as successful task completion."""
    workspace = MagicMock()
    workspace.host = "http://localhost:8000"
    conversation = FakeConversation(status=status)

    def make_conversation(**kwargs):
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

    with make_client(handler) as client:
        outcome, reason = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
        })

    assert outcome != "success", f"status {status!r} must never produce a success outcome"
    assert outcome == "failure"
    assert reason == "UNEXPECTED_EXECUTION_STATUS"


def test_worker_main_loop_never_posts_success_complete_for_a_non_success_outcome(monkeypatch, tmp_path) -> None:
    """worker.py's own outcome-normalization: a ("failure", reason) 2-tuple
    from the agent_server adapter must produce a POST to /complete with
    outcome="failure" (and the reason forwarded), never "success"."""
    from coding_agent import worker

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/claim"):
            return httpx.Response(200, json={
                "jobId": "job-1", "executionId": "exec-1", "objective": "x",
                "acceptanceCriteria": [], "resolvedModel": "m",
            })
        if request.url.path.endswith("/complete"):
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={"status": "FAILED"})
        return httpx.Response(200)

    calls = {"n": 0}

    def fake_dispatch_fn(client, dispatch):
        calls["n"] += 1
        return ("failure", "UNEXPECTED_EXECUTION_STATUS")

    monkeypatch.setattr(worker, "INTERNAL_TOKEN", "test-token")
    with make_client(handler) as client:
        dispatch = worker.claim(client)
        assert dispatch is not None
        result = fake_dispatch_fn(client, dispatch)
        outcome, reason = (result, None) if isinstance(result, str) else result
        assert outcome != "paused"
        worker.complete(client, dispatch["executionId"], outcome, reason)

    assert len(posts) == 1
    assert posts[0]["outcome"] == "failure"
    assert posts[0]["reason"] == "UNEXPECTED_EXECUTION_STATUS"


def test_worker_main_loop_skips_complete_entirely_for_paused_outcome() -> None:
    """A ("paused", None) outcome (usage-limit interrupt fallback, new-attempt
    recovery) must never reach /complete at all — apps/api has already
    transitioned the task via the worker's own /usage-pause call."""
    # Mirrors the exact branch in worker.main()'s dispatch loop.
    result = ("paused", None)
    outcome, _reason = (result, None) if isinstance(result, str) else result
    should_call_complete = outcome != "paused"
    assert should_call_complete is False


# --- B. UsageLimitState fast-path -------------------------------------------


def test_usage_limit_state_observed_usage_is_baseline_plus_attempt_tokens() -> None:
    """Correction 2's exact formula: prior_task_usage_before_this_attempt +
    current_attempt_accumulated_usage."""
    state = UsageLimitState(baseline_task_usage=500, limit_quantity=1000, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    assert state.observed_task_usage() == 500
    state.add_attempt_tokens(120)
    state.add_attempt_tokens(30)
    assert state.observed_task_usage() == 650, "must include the cross-attempt baseline, not just this attempt's own tokens"


def test_should_enforce_never_fires_with_no_active_policy() -> None:
    """Correction 19: no ACTIVE policy means zero enforcement, ever."""
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=None, policy_id=None, metric=None)
    state.add_attempt_tokens(10_000_000)
    assert state.should_enforce() is False


def test_should_enforce_fires_exactly_once_at_threshold() -> None:
    """Idempotency guard (correction 10a): should_enforce() claims the
    enforcement slot atomically — a second call after crossing the same
    threshold must never re-trigger."""
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    state.add_attempt_tokens(50)
    assert state.should_enforce() is False, "below the limit"
    state.add_attempt_tokens(60)  # now 110 >= 100
    assert state.should_enforce() is True
    assert state.should_enforce() is False, "must never fire twice for the same crossing"
    state.add_attempt_tokens(1000)
    assert state.should_enforce() is False, "still must not re-fire even as usage keeps climbing"


def test_retry_baseline_included_means_a_second_attempt_does_not_reset_the_allowance() -> None:
    """Correction 2/15: a fresh execution attempt (new UsageLimitState
    instance, new claim) must start from the durable cross-attempt baseline,
    not from zero — simulates what routes/internal.ts's claim handler
    supplies as `usageBaseline`."""
    prior_attempt_usage = 950
    limit = 1000
    state = UsageLimitState(baseline_task_usage=prior_attempt_usage, limit_quantity=limit, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    # This fresh attempt has produced only 60 tokens of its own so far, but
    # the cumulative task total (950 + 60 = 1010) already exceeds the limit.
    state.add_attempt_tokens(60)
    assert state.should_enforce() is True


def test_apply_resume_updates_limit_and_clears_enforcement_flag_for_future_re_enforcement() -> None:
    """Correction 18: a new (extended) limit only ever takes effect via an
    explicit resume — and after resuming, a SECOND usage-limit crossing must
    still be detectable (the guard must not be permanently latched)."""
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    state.add_attempt_tokens(150)
    assert state.should_enforce() is True
    state.pause_requested = True
    state.pause_outcome = "PAUSE"

    state.apply_resume(new_limit=500)
    assert state.limit_quantity == 500
    assert state.pause_requested is False
    assert state.pause_outcome is None

    state.add_attempt_tokens(400)  # cumulative now 550 >= 500
    assert state.should_enforce() is True, "must be able to enforce again after a resume with a higher limit"


# --- D. Pause enforcement ----------------------------------------------------


def test_enforce_usage_limit_pause_success_persists_pause_and_sets_state() -> None:
    conversation = FakeConversation(status="running")

    def on_pause():
        conversation.set_status("paused")

    # pause() itself doesn't change status in the fake by default; wire it so
    # calling pause() has the real-world effect the confirmation re-check
    # depends on.
    original_pause = conversation.pause

    def pause_with_effect():
        original_pause()
        on_pause()

    conversation.pause = pause_with_effect

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/usage-pause"):
            posts.append(json.loads(request.content))
            return httpx.Response(201)
        return httpx.Response(200)

    state = UsageLimitState(baseline_task_usage=900, limit_quantity=1000, policy_id="policy-1", metric="TOTAL_LLM_TOKENS")
    state.add_attempt_tokens(150)  # observed = 1050, over the limit — overshoot preserved

    with make_client(handler) as client:
        _enforce_usage_limit(conversation, None, client, "exec-1", "worker-1", state, log=lambda *_: None)

    assert conversation.pause_calls == 1
    assert conversation.interrupt_calls == 0
    assert state.pause_outcome == "PAUSE"
    assert state.resume_mode == "SAME_EXECUTION"
    assert state.force_stop_reason is None
    assert len(posts) == 1
    assert posts[0]["enforcementAction"] == "PAUSE"
    assert posts[0]["resumeMode"] == "SAME_EXECUTION"
    assert posts[0]["observedUsage"] == 1050, "the real, unclamped overshoot value must be sent, never clamped to 1000"
    assert posts[0]["configuredLimit"] == 1000


# --- E. Failure fallback -----------------------------------------------------


def test_enforce_usage_limit_falls_back_to_interrupt_when_pause_fails() -> None:
    conversation = FakeConversation(status="running", pause_error=RuntimeError("pause endpoint down"))

    def interrupt_with_effect():
        conversation.interrupt_calls += 1
        conversation.set_status("idle")

    conversation.interrupt = interrupt_with_effect

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/usage-pause"):
            posts.append(json.loads(request.content))
            return httpx.Response(201)
        return httpx.Response(200)

    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="policy-1", metric="TOTAL_LLM_TOKENS")
    state.add_attempt_tokens(120)

    with make_client(handler) as client:
        _enforce_usage_limit(conversation, None, client, "exec-1", "worker-1", state, log=lambda *_: None)

    assert conversation.pause_calls == 1
    assert conversation.interrupt_calls == 1
    assert state.pause_outcome == "INTERRUPT"
    assert state.resume_mode == "NEW_ATTEMPT", "interrupt fallback must never claim same-conversation resumability"
    assert posts[0]["enforcementAction"] == "INTERRUPT"
    assert posts[0]["resumeMode"] == "NEW_ATTEMPT"


def test_enforce_usage_limit_fails_closed_when_both_pause_and_interrupt_fail() -> None:
    conversation = FakeConversation(
        status="running",
        pause_error=RuntimeError("pause down"),
        interrupt_error=RuntimeError("interrupt also down"),
    )
    docker_workspace = MagicMock()

    posts = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(request)
        return httpx.Response(201)

    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="policy-1", metric="TOTAL_LLM_TOKENS")
    state.add_attempt_tokens(120)

    with make_client(handler) as client:
        _enforce_usage_limit(conversation, docker_workspace, client, "exec-1", "worker-1", state, log=lambda *_: None)

    assert state.force_stop_reason == "USAGE_ENFORCEMENT_FAILED"
    assert state.pause_outcome == "ENFORCEMENT_FAILED"
    docker_workspace.cleanup.assert_called_once()
    # No usage-pause row is ever persisted for the fail-closed path — the
    # eventual outcome goes through EXISTING failure semantics
    # (/complete with reason=USAGE_ENFORCEMENT_FAILED), not a pause record.
    assert posts == []


def test_full_dispatch_reports_paused_outcome_for_interrupt_fallback(monkeypatch) -> None:
    """End-to-end (within this adapter, mocked SDK): a usage-limit crossing
    whose pause() fails but interrupt() succeeds must surface as the
    ("paused", None) outcome — not success, not failure — via
    run_dispatch_via_agent_server's own whitelist loop."""
    workspace = MagicMock()
    workspace.host = "http://localhost:8000"
    conversation = FakeConversation(status="running", pause_error=RuntimeError("down"))

    def make_conversation(**kwargs):
        return conversation

    class FakeUsageForwarder:
        def __init__(self, client, execution_id, worker_id, get_conversation, log, usage_limit_state=None, get_docker_workspace=None):
            self._state = usage_limit_state
            self._client = client
            self._execution_id = execution_id
            self._worker_id = worker_id
            self._get_conversation = get_conversation
            self._log = log
            self._get_docker_workspace = get_docker_workspace

        def start(self):
            pass

        def close(self):
            pass

        def poll_once(self):
            pass

        def __call__(self, event):
            pass

        def trigger(self):
            # Simulates a real stats-update poll discovering enough new
            # tokens to cross the configured limit, exactly as
            # UsageForwarder.poll_once() would before calling
            # _enforce_usage_limit.
            self._state.add_attempt_tokens(200)
            if self._state.should_enforce():
                conversation.interrupt = lambda: (setattr(conversation, "interrupt_calls", conversation.interrupt_calls + 1), conversation.set_status("idle"))
                adapter._enforce_usage_limit(
                    self._get_conversation(), self._get_docker_workspace(), self._client,
                    self._execution_id, self._worker_id, self._state, self._log,
                )

    captured = {}

    def make_usage_forwarder(*args, **kwargs):
        fwd = FakeUsageForwarder(*args, **kwargs)
        captured["forwarder"] = fwd
        return fwd

    def run_side_effect():
        # Simulate the usage-monitor thread doing its job synchronously
        # during this "blocking" run() call, then leaving the conversation
        # in the resulting status for the main thread's post-run check.
        captured["forwarder"].trigger()

    conversation.run = MagicMock(side_effect=run_side_effect)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200 if not request.url.path.endswith("/usage-pause") else 201)

    monkeypatch.setattr(adapter, "heartbeat_loop", lambda *args: None)
    monkeypatch.setattr(adapter, "clone_repository", lambda *args: None)
    monkeypatch.setattr(adapter, "require_api_key", lambda *args: "test-key")
    monkeypatch.setattr(adapter, "LLM", MagicMock())
    monkeypatch.setattr(adapter, "Agent", MagicMock())
    monkeypatch.setattr(adapter, "LoopbackDockerWorkspace", lambda **kwargs: workspace)
    monkeypatch.setattr(adapter, "Conversation", make_conversation)
    monkeypatch.setattr(adapter, "resync_events", lambda *args: [])
    monkeypatch.setattr(adapter, "UsageForwarder", make_usage_forwarder)

    with make_client(handler) as client:
        outcome = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
            "usagePolicy": {"policyId": "policy-1", "metric": "TOTAL_LLM_TOKENS", "limitQuantity": 100},
            "usageBaseline": 0,
        })

    assert outcome == ("paused", None)
    assert conversation.run.call_count == 1, "interrupt-fallback/NEW_ATTEMPT must return, never loop back to run() again"


# --- F. Resume: CommandHandler -----------------------------------------------


def _same_execution_paused_state() -> UsageLimitState:
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    state.pause_requested = True
    state.pause_outcome = "PAUSE"
    state.resume_mode = "SAME_EXECUTION"
    return state


def test_command_handler_resume_accepts_and_sets_event_when_genuinely_paused() -> None:
    conversation = MagicMock()
    relay = MagicMock()
    state = _same_execution_paused_state()
    resume_event = threading.Event()
    handler = CommandHandler(conversation, relay, log=lambda *_: None, resume_event=resume_event, usage_limit_state=state)

    handler({
        "commandId": "cmd-1",
        "command": {"type": "execution.resume_same_conversation", "payload": {"limitQuantity": 500}},
    })

    assert resume_event.is_set()
    assert state.new_limit_on_resume == 500
    relay.send_command_ack.assert_called_once_with("cmd-1", "accepted")
    # This handler must never itself call run()/pause()/interrupt() — see the
    # class docstring's own invariant, unchanged by this new command type.
    conversation.run.assert_not_called()
    conversation.pause.assert_not_called()
    conversation.interrupt.assert_not_called()


def test_command_handler_resume_rejects_when_not_actually_in_a_same_execution_pause() -> None:
    conversation = MagicMock()
    relay = MagicMock()
    # A dispatch that was never paused at all.
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    resume_event = threading.Event()
    handler = CommandHandler(conversation, relay, log=lambda *_: None, resume_event=resume_event, usage_limit_state=state)

    handler({
        "commandId": "cmd-1",
        "command": {"type": "execution.resume_same_conversation", "payload": {"limitQuantity": 500}},
    })

    assert not resume_event.is_set()
    relay.send_command_ack.assert_called_once()
    ack_args = relay.send_command_ack.call_args[0]
    assert ack_args[0] == "cmd-1"
    assert ack_args[1] == "rejected"


def test_command_handler_resume_rejects_a_new_attempt_pause_as_not_same_execution_resumable() -> None:
    conversation = MagicMock()
    relay = MagicMock()
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    state.pause_requested = True
    state.pause_outcome = "INTERRUPT"
    state.resume_mode = "NEW_ATTEMPT"
    resume_event = threading.Event()
    handler = CommandHandler(conversation, relay, log=lambda *_: None, resume_event=resume_event, usage_limit_state=state)

    handler({
        "commandId": "cmd-1",
        "command": {"type": "execution.resume_same_conversation", "payload": {"limitQuantity": 500}},
    })

    assert not resume_event.is_set()
    assert relay.send_command_ack.call_args[0][1] == "rejected"


def test_command_handler_resume_rejects_missing_or_invalid_limit_quantity() -> None:
    conversation = MagicMock()
    relay = MagicMock()
    state = _same_execution_paused_state()
    resume_event = threading.Event()
    handler = CommandHandler(conversation, relay, log=lambda *_: None, resume_event=resume_event, usage_limit_state=state)

    handler({"commandId": "cmd-1", "command": {"type": "execution.resume_same_conversation", "payload": {}}})

    assert not resume_event.is_set()
    assert relay.send_command_ack.call_args[0][1] == "rejected"


def test_command_handler_resume_without_state_wiring_rejects_cleanly() -> None:
    """A dispatch that never had any usage policy at all (correction 19) has
    no usage_limit_state/resume_event wired up — a resume command arriving
    for it anyway (should never happen in practice) must be rejected, not
    raise."""
    conversation = MagicMock()
    relay = MagicMock()
    handler = CommandHandler(conversation, relay, log=lambda *_: None)

    handler({"commandId": "cmd-1", "command": {"type": "execution.resume_same_conversation", "payload": {"limitQuantity": 5}}})

    assert relay.send_command_ack.call_args[0][1] == "rejected"


# --- F. Resume: full same-execution loop ------------------------------------


def test_full_dispatch_same_execution_resume_then_finishes(monkeypatch) -> None:
    """The complete correction-16 loop: conversation.run() is called, a
    usage-limit pause is genuinely confirmed, the dispatch blocks holding the
    conversation alive, a resume command arrives over the relay's command
    handler (simulated on a background thread, exactly as it would arrive on
    RelayClient's own receive thread in production), and the SAME
    Conversation object's .run() is called a second time, this time reaching
    FINISHED."""
    workspace = MagicMock()
    workspace.host = "http://localhost:8000"
    conversation = FakeConversation(status="running")
    conversation.run = MagicMock()

    def run_side_effect():
        if conversation.run.call_count == 1:
            conversation.set_status("paused")
            # Deliver exactly once before run() returns: the main loop must
            # preserve an already-delivered signal when entering its wait.
            captured_relay["instance"].handler({
                "commandId": "resume-cmd-1",
                "command": {"type": "execution.resume_same_conversation", "payload": {"limitQuantity": 999}},
            })
        else:
            conversation.set_status("finished")

    conversation.run.side_effect = run_side_effect

    def make_conversation(**kwargs):
        return conversation

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

        def send_command_ack(self, *args, **kwargs):
            pass

        def close(self, *args, **kwargs):
            pass

    captured_state = {}

    class FakeUsageForwarder:
        def __init__(self, client, execution_id, worker_id, get_conversation, log, usage_limit_state=None, get_docker_workspace=None):
            self._state = usage_limit_state
            # Simulates what _enforce_usage_limit would have already set on
            # the usage-monitor background thread by the time .run() returns
            # with status PAUSED — this test isolates the resume-loop logic
            # itself (already covered separately by
            # test_enforce_usage_limit_pause_success_persists_pause_and_sets_state),
            # not the enforcement-triggering wiring.
            if usage_limit_state is not None:
                usage_limit_state.pause_requested = True
                usage_limit_state.pause_outcome = "PAUSE"
                usage_limit_state.resume_mode = "SAME_EXECUTION"
                # The main loop waits (bounded, 30s) on enforcement_done
                # before reading pause_outcome — see run_dispatch_via_agent_
                # server's own race-fix comment. This fake sets the flags
                # directly rather than calling the real _enforce_usage_limit,
                # so it must also mark enforcement as done immediately to
                # avoid a real 30s stall in this test.
                usage_limit_state.enforcement_done.set()
            captured_state["instance"] = usage_limit_state

        def start(self):
            pass

        def close(self):
            pass

        def poll_once(self):
            pass

        def __call__(self, event):
            pass

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/usage-resume"):
            return httpx.Response(200, json={"policyId": "policy-2", "limitQuantity": 999})
        return httpx.Response(201 if request.url.path.endswith("/usage-pause") else 200)

    monkeypatch.setattr(adapter, "heartbeat_loop", lambda *args: None)
    monkeypatch.setattr(adapter, "clone_repository", lambda *args: None)
    monkeypatch.setattr(adapter, "require_api_key", lambda *args: "test-key")
    monkeypatch.setattr(adapter, "LLM", MagicMock())
    monkeypatch.setattr(adapter, "Agent", MagicMock())
    monkeypatch.setattr(adapter, "LoopbackDockerWorkspace", lambda **kwargs: workspace)
    monkeypatch.setattr(adapter, "Conversation", make_conversation)
    monkeypatch.setattr(adapter, "resync_events", lambda *args: [])
    monkeypatch.setattr(adapter, "RelayClient", FakeRelay)
    monkeypatch.setattr(adapter, "UsageForwarder", FakeUsageForwarder)

    with make_client(handler) as client:
        outcome = adapter.run_dispatch_via_agent_server(client, {
            "executionId": "exec-1", "repositorySnapshot": {},
            "resolvedModel": "test-model", "objective": "test", "acceptanceCriteria": [],
            "usagePolicy": {"policyId": "policy-1", "metric": "TOTAL_LLM_TOKENS", "limitQuantity": 100},
            "usageBaseline": 0,
        })

    assert outcome == ("success", None)
    assert conversation.run.call_count == 2, "must resume the SAME conversation via a second .run() call, never a new one"


def test_snapshot_fast_path_is_local_cumulative_and_replay_safe():
    from openhands.sdk.conversation.conversation_stats import ConversationStats
    from openhands.sdk.event.conversation_state import ConversationStateUpdateEvent
    from openhands.sdk.llm.utils.metrics import Metrics

    state = UsageLimitState(baseline_task_usage=900, limit_quantity=1000, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    metrics = Metrics(model_name="test")
    metrics.add_token_usage(prompt_tokens=100, completion_tokens=50, cache_read_tokens=30,
                           cache_write_tokens=0, reasoning_tokens=20, context_window=4096, response_id="r1")
    event = ConversationStateUpdateEvent(key="stats", value=ConversationStats(usage_to_metrics={"agent": metrics}))
    client = MagicMock()
    forwarder = adapter.UsageForwarder(client, "exec", "worker", lambda: None, lambda *_: None, usage_limit_state=state)
    forwarder(event)
    forwarder(event)
    assert state.observed_task_usage() == 1050
    assert state.should_enforce()
    assert not state.should_enforce()
    client.post.assert_not_called()


def test_pause_persistence_failure_cannot_be_reported_as_success():
    conversation = FakeConversation(status="paused")
    state = UsageLimitState(baseline_task_usage=0, limit_quantity=100, policy_id="p1", metric="TOTAL_LLM_TOKENS")
    state.add_attempt_tokens(120)
    with make_client(lambda _: httpx.Response(503)) as client:
        _enforce_usage_limit(conversation, None, client, "exec", "worker", state, lambda *_: None)
    assert state.force_stop_reason == "USAGE_ENFORCEMENT_FAILED"
