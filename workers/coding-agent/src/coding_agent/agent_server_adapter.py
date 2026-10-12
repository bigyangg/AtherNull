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
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode

import httpx
import websockets.sync.client as ws_client
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.sdk.conversation.conversation_stats import ConversationStats
from openhands.sdk.conversation.state import ConversationExecutionStatus
from openhands.sdk.event.base import Event
from openhands.sdk.event.conversation_state import ConversationStateUpdateEvent
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


def _split_provider_and_model(full_model: str) -> tuple[str, str]:
    """Same "<provider>/<model>" prefix convention coding_agent.llm's
    resolve_api_key/require_api_key already rely on (LiteLLM's own model
    string format) — split once on the FIRST '/' so a model id that itself
    contains slashes (e.g. "nvidia/nemotron-3-super-120b-a12b") stays intact
    after the provider prefix is removed. Falls back to (full_model,
    full_model) for a malformed string with no '/' at all, rather than
    raising — this is best-effort attribution, never something that should
    crash a usage poll."""
    provider, sep, rest = full_model.partition("/")
    if not sep:
        return full_model, full_model
    return provider, rest


def get_fresh_execution_status(conversation) -> ConversationExecutionStatus | None:
    """Genuinely fresh (never cached) read of the conversation's real
    execution_status. Returns None only when the server's own value can't be
    parsed as a known ConversationExecutionStatus member at all — callers
    must treat None as an unknown/anomalous status, never as success.

    Deliberately does NOT read `conversation.execution_status` (the SDK's own
    convenience property): that property reads through
    `RemoteState._get_conversation_info()`, which returns whatever is already
    cached once `_cached_state` is non-None — exactly the staleness hazard
    `UsageForwarder`'s own docstring documents for `.stats`/`.conversation_stats`.
    `conversation.state.refresh_from_server()` is the same genuinely-fresh
    REST call (`GET {conversation_info_base_path}/{id}`) UsageForwarder
    already established as this codebase's one audited way to get a
    non-cached read — reused here rather than inventing a second mechanism.
    """
    info = conversation.state.refresh_from_server()
    raw = info.get("execution_status")
    try:
        return ConversationExecutionStatus(raw)
    except ValueError:
        return None


class UsageLimitState:
    """Thread-safe fast view of task-level usage for one execution attempt.

    The API supplies the prior-attempt baseline at claim and reconciles it on
    usage ingestion. Current-attempt totals come from cumulative SDK stats.
    The local view is an enforcement signal, not a second durable ledger.
    A missing policy means no threshold enforcement.
    """

    def __init__(
        self,
        baseline_task_usage: int,
        limit_quantity: int | None,
        policy_id: str | None,
        metric: str | None,
    ) -> None:
        self._lock = threading.Lock()
        self.baseline_task_usage = baseline_task_usage
        self.limit_quantity = limit_quantity
        self.policy_id = policy_id
        self.metric = metric
        self.cumulative_attempt_tokens = 0
        # Idempotency guard (correction 10a/11): claimed exactly once per
        # dispatch attempt by should_enforce()'s own compare-and-set, so a
        # burst of stats-update triggers racing each other on the SAME
        # background thread (UsageForwarder's poll loop is already
        # single-threaded via its own _poll_lock) can still only ever
        # initiate enforcement once.
        self.enforcement_attempted = False
        # Set true only once conversation.pause()/interrupt() has genuinely
        # been requested by THIS process — the main thread's post-.run()
        # status check uses this to distinguish "PAUSED because we asked for
        # it" from an unrequested/anomalous PAUSED, which must never be
        # silently treated as a successful usage-limit pause (see the
        # reviewer-sharpened whitelist requirement on correction 1).
        self.pause_requested = False
        self.pause_outcome: str | None = None  # "PAUSE" | "INTERRUPT" | "ENFORCEMENT_FAILED" | None
        self.resume_mode: str | None = None  # "SAME_EXECUTION" | "NEW_ATTEMPT" | None
        # Set by CommandHandler when a genuine "execution.resume_same_
        # conversation" command arrives, carrying the (possibly extended)
        # limit to enforce against going forward (correction 18: extend and
        # resume are two separate actions — the new limit only ever takes
        # effect once resume is explicitly requested).
        self.new_limit_on_resume: int | None = None
        self.force_stop_reason: str | None = None
        # Real-execution verification (this phase's own genuine NIM run,
        # never simulated) uncovered a real race: conversation.run() can
        # return on the MAIN thread (via the post-run WebSocket state
        # update, e.g. because the server-side pause already took visible
        # effect) strictly BEFORE _enforce_usage_limit's OWN re-confirmation
        # / interrupt-fallback sequence on the background thread has finished
        # deciding PAUSE vs INTERRUPT vs ENFORCEMENT_FAILED. Reading
        # `pause_outcome` at that moment can observe it still `None`,
        # producing a false "failure" report for a pause that was, moments
        # later, genuinely confirmed. This event is set exactly once, in a
        # `finally` block, at the point _enforce_usage_limit's decision is
        # actually final — the main thread waits on it (bounded) before ever
        # reading pause_outcome/resume_mode/force_stop_reason.
        self.enforcement_done = threading.Event()

    def observed_task_usage(self) -> int:
        with self._lock:
            return self.baseline_task_usage + self.cumulative_attempt_tokens

    def add_attempt_tokens(self, n: int) -> None:
        with self._lock:
            self.cumulative_attempt_tokens += n

    def observe_attempt_total(self, total: int) -> None:
        with self._lock:
            self.cumulative_attempt_tokens = max(self.cumulative_attempt_tokens, total)

    def reconcile_baseline(self, total: int) -> None:
        with self._lock:
            self.baseline_task_usage = max(self.baseline_task_usage, total)

    def should_enforce(self) -> bool:
        """True at most once per dispatch attempt (per limit) — claims the
        enforcement slot atomically as part of the same check so two
        near-simultaneous calls can never both proceed."""
        with self._lock:
            if self.limit_quantity is None:
                return False
            if self.enforcement_attempted:
                return False
            if self.baseline_task_usage + self.cumulative_attempt_tokens < self.limit_quantity:
                return False
            self.enforcement_attempted = True
            self.enforcement_done.clear()
            return True

    def apply_resume(self, new_limit: int) -> None:
        """Correction 16/18: a fresh limit only ever takes effect once an
        explicit resume has actually happened — never hot-reloaded mid-run."""
        with self._lock:
            self.limit_quantity = new_limit
            self.enforcement_attempted = False
            self.pause_requested = False
            self.pause_outcome = None
            self.resume_mode = None
            self.enforcement_done.clear()


def _enforce_usage_limit(
    conversation,
    docker_workspace,
    client: httpx.Client,
    execution_id: str,
    worker_id: str,
    state: UsageLimitState,
    log: Callable[[str], None],
    reconcile: Callable[[], None] | None = None,
) -> None:
    """Correction 10/12 — called at most once per dispatch attempt (see
    UsageLimitState.should_enforce()'s own compare-and-set), from
    UsageForwarder's background poll thread, while conversation.run() blocks
    on the main thread. Safe by the same reasoning CommandHandler's own
    docstring already documents for calling REST methods against the shared
    Conversation from a second thread (confirmed for pause()/interrupt() too
    by this phase's own audit) — this function never calls conversation.run()
    itself, only pause()/interrupt(), and serializes with any other poll via
    UsageForwarder's existing _poll_lock (the sole caller, poll_once(), holds
    it for this function's entire duration).

    Fallback hierarchy (correction 12): pause() -> confirm PAUSED -> done.
    Else interrupt() -> confirm non-RUNNING -> done (NEW_ATTEMPT). Else fail
    closed: force the container down so the main thread's blocked .run() call
    errors out rather than silently continuing past the configured limit.
    """
    observed = state.observed_task_usage()
    log(
        f"usage limit reached for execution {execution_id}: observed={observed} "
        f"configured_limit={state.limit_quantity} -- attempting pause"
    )
    state.pause_requested = True

    def _status_is(expected: ConversationExecutionStatus) -> bool:
        deadline = time.monotonic() + 10
        while True:
            try:
                status = get_fresh_execution_status(conversation)
                if status == expected:
                    return True
                log(f"usage enforcement: waiting for {expected.value}; observed {status!r}")
            except Exception as err:  # noqa: BLE001
                log(f"usage enforcement: status confirmation failed: {err!r}")
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)

    # Real-execution verification (a genuine NVIDIA NIM run, not a mock)
    # caught a real race here: the main thread's conversation.run() can
    # return (via the post-run WebSocket state update) strictly BEFORE this
    # function finishes deciding PAUSE vs INTERRUPT vs ENFORCEMENT_FAILED.
    # state.enforcement_done (set in the `finally` below, exactly once, no
    # matter which branch is taken or whether an unexpected exception
    # escapes) is what the main thread waits on before ever reading
    # pause_outcome/resume_mode/force_stop_reason — see
    # run_dispatch_via_agent_server's own status-check loop.
    try:
        action: str | None = None
        resume_mode: str | None = None
        try:
            conversation.pause()
            if _status_is(ConversationExecutionStatus.PAUSED):
                action, resume_mode = "PAUSE", "SAME_EXECUTION"
            else:
                log("usage enforcement: pause() call succeeded but status is not genuinely PAUSED on re-check")
        except Exception as err:  # noqa: BLE001
            log(f"usage enforcement: pause() call failed: {err!r}")

        if action is None:
            try:
                conversation.interrupt()
                # The installed SDK exposes no execution_status distinct from
                # PAUSED for an interrupted run (confirmed: ConversationExecutionStatus
                # has no INTERRUPTED member) — treat interrupt() as successful
                # once the conversation is confirmed no longer RUNNING.
                status = get_fresh_execution_status(conversation)
                if status is not None and status != ConversationExecutionStatus.RUNNING:
                    action, resume_mode = "INTERRUPT", "NEW_ATTEMPT"
                else:
                    log(f"usage enforcement: interrupt() call succeeded but status is still {status!r}")
            except Exception as err:  # noqa: BLE001
                log(f"usage enforcement: interrupt() fallback failed: {err!r}")

        if action is None:
            # Fail closed (correction 12): both pause() and interrupt()
            # failed. Stop as aggressively as safely supported — tearing the
            # container down forces the main thread's blocked .run() call to
            # error out rather than silently running past the configured
            # limit.
            state.pause_outcome = "ENFORCEMENT_FAILED"
            state.force_stop_reason = "USAGE_ENFORCEMENT_FAILED"
            log("usage enforcement: both pause() and interrupt() failed -- forcing container teardown to fail closed")
            try:
                if docker_workspace is not None:
                    docker_workspace.cleanup()
            except Exception as cleanup_err:  # noqa: BLE001
                log(f"usage enforcement: forced container teardown warning: {cleanup_err!r}")
            return

        state.pause_outcome = action
        state.resume_mode = resume_mode

        if reconcile is not None:
            reconcile()
        observed = state.observed_task_usage()

        try:
            res = client.post(
                f"{API_URL}/internal/executions/{execution_id}/usage-pause",
                json={
                    "workerId": worker_id,
                    "policyId": state.policy_id,
                    "metric": state.metric,
                    "configuredLimit": state.limit_quantity,
                    "observedUsage": observed,
                    "enforcementAction": action,
                    "resumeMode": resume_mode,
                },
                headers=api_headers(),
                timeout=10.0,
            )
            if res.status_code not in (200, 201):
                log(f"usage-pause persist failed ({res.status_code}): {res.text}")
                state.force_stop_reason = "USAGE_ENFORCEMENT_FAILED"
        except httpx.HTTPError as err:
            log(f"usage-pause persist request failed: {err!r}")
            state.force_stop_reason = "USAGE_ENFORCEMENT_FAILED"
    finally:
        state.enforcement_done.set()


class UsageForwarder:
    """Forward full per-response usage and enforce a local cumulative signal.

    Stats events retain accumulated_token_usage in snapshot mode, but omit
    token_usages and cannot identify individual responses. The callback reads
    the accumulated prompt/completion count only for fast local enforcement.
    It wakes a background thread, which requests pause before performing the
    existing REST refresh and durable usage ingestion.

    refresh_from_server() returns full per-response records. Their real
    response IDs feed the existing usage_events ledger; the API's unique
    (execution_id, provider_request_id) constraint makes replays harmless.
    _seen_response_ids only reduces traffic and is updated after ingestion.
    Cached conversation.stats cannot supply these records because WebSocket
    snapshots replace it with the lossy representation.

    The same poll reconciles usage at pause, policy-governed run return, and
    teardown. Snapshot totals and full totals use a monotonic maximum, never
    additive counters, so observing the same response through both paths does
    not double-count. Postgres remains the authoritative usage evidence.
    """

    def __init__(
        self,
        client: httpx.Client,
        execution_id: str,
        worker_id: str,
        get_conversation: Callable[[], object | None],
        log: Callable[[str], None],
        usage_limit_state: "UsageLimitState | None" = None,
        get_docker_workspace: Callable[[], object | None] = lambda: None,
    ) -> None:
        self._client = client
        self._execution_id = execution_id
        self._worker_id = worker_id
        self._get_conversation = get_conversation
        self._log = log
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        # Serializes poll_once() calls so a background-thread poll and the
        # teardown-time direct call never run concurrently against the same
        # REST connection / _seen_response_ids set.
        self._poll_lock = threading.Lock()
        self._seen_response_ids: set[str] = set()
        # Phase 4D.2A — None (the default) means this dispatch has no ACTIVE
        # usage policy at all (correction 19): every enforcement check below
        # is skipped entirely, byte-for-byte the same code path as before
        # this phase existed. late-bound via a getter for the same reason
        # `get_conversation` already is (the real workspace object isn't
        # constructed until after this forwarder is).
        self._usage_limit_state = usage_limit_state
        self._get_docker_workspace = get_docker_workspace

    def start(self) -> None:
        def loop() -> None:
            while True:
                self._wake.wait()
                if self._stop.is_set():
                    return
                self._wake.clear()
                self._enforce_if_needed()
                self.poll_once()

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=10)

    def __call__(self, event: Event) -> None:
        if isinstance(event, ConversationStateUpdateEvent) and event.key == "stats":
            if self._usage_limit_state is not None:
                try:
                    stats = ConversationStats.model_validate(event.value)
                    self._observe_stats(stats)
                except (ValueError, TypeError) as err:
                    self._log(f"usage snapshot could not be parsed: {err!r}")
            self._wake.set()

    def _observe_stats(self, stats: ConversationStats) -> None:
        if self._usage_limit_state is not None:
            total = sum(
                m.accumulated_token_usage.prompt_tokens + m.accumulated_token_usage.completion_tokens
                for m in stats.usage_to_metrics.values() if m.accumulated_token_usage is not None
            )
            self._usage_limit_state.observe_attempt_total(total)

    def _enforce_if_needed(self) -> None:
        state = self._usage_limit_state
        conversation = self._get_conversation()
        if state is not None and conversation is not None and state.should_enforce():
            _enforce_usage_limit(
                conversation, self._get_docker_workspace(), self._client,
                self._execution_id, self._worker_id, state, self._log,
                reconcile=self.poll_once,
            )

    def poll_once(self) -> None:
        """Force a genuine REST poll of conversation.stats and forward any
        not-yet-forwarded usage rows. Safe to call repeatedly, safe to call
        from multiple threads (serialized internally), and safe to call even
        when nothing new has happened (a no-op POST is simply skipped)."""
        conversation = self._get_conversation()
        if conversation is None:
            return

        with self._poll_lock:
            try:
                info = conversation.state.refresh_from_server()
            except Exception as err:  # noqa: BLE001 - must never affect the dispatch
                self._log(f"usage poll: refresh_from_server failed: {err!r}")
                return

            try:
                stats = ConversationStats.model_validate(info.get("stats") or {})
            except Exception as err:  # noqa: BLE001
                self._log(f"usage poll: failed to parse ConversationStats: {err!r}")
                return

            self._observe_stats(stats)

            payload_events: list[dict] = []
            observed_at = datetime.now(UTC).isoformat()
            for metrics in stats.usage_to_metrics.values():
                for usage in metrics.token_usages:
                    response_id = usage.response_id
                    if not response_id or response_id in self._seen_response_ids:
                        continue
                    provider, model = _split_provider_and_model(usage.model)
                    payload_events.append(
                        {
                            "providerRequestId": response_id,
                            "provider": provider,
                            "model": model,
                            "inputTokens": usage.prompt_tokens,
                            "outputTokens": usage.completion_tokens,
                            "cacheReadTokens": usage.cache_read_tokens,
                            "cacheWriteTokens": usage.cache_write_tokens,
                            "reasoningTokens": usage.reasoning_tokens,
                            "observedAt": observed_at,
                        }
                    )

            if not payload_events:
                return

            try:
                res = self._client.post(
                    f"{API_URL}/internal/executions/{self._execution_id}/usage",
                    json={"workerId": self._worker_id, "usageEvents": payload_events},
                    headers=api_headers(),
                    timeout=10.0,
                )
                if res.status_code != 204:
                    self._log(f"usage forward failed ({res.status_code}): {res.text}")
                    return
                prior = res.headers.get("x-task-prior-usage")
                if self._usage_limit_state is not None and prior is not None:
                    self._usage_limit_state.reconcile_baseline(int(prior))
            except httpx.HTTPError as err:
                self._log(f"usage forward request failed: {err!r}")
                return

            # Mark as seen only after a confirmed successful POST — a failed
            # send is retried on the NEXT poll (which resends the full
            # still-unseen set; DB dedupe on (execution_id,
            # provider_request_id) makes that safe even in the rare case a
            # POST actually succeeded server-side but the response was lost).
            for event in payload_events:
                self._seen_response_ids.add(event["providerRequestId"])
            self._log(
                f"usage: forwarded {len(payload_events)} new usage row(s) "
                f"(total distinct so far: {len(self._seen_response_ids)})"
            )

            # Phase 4D.2A — correction 3: TOTAL_LLM_TOKENS is exactly
            # input_tokens + output_tokens, computed here from the SAME
            # newly-forwarded, already-deduped rows this method just
            # confirmed apps/api accepted — never a second, independently
            # maintained count. A no-op whenever this dispatch has no ACTIVE
            # usage policy (self._usage_limit_state is None, correction 19).
            if self._usage_limit_state is not None and self._usage_limit_state.should_enforce():
                _enforce_usage_limit(
                    conversation,
                    self._get_docker_workspace(),
                    self._client,
                    self._execution_id,
                    self._worker_id,
                    self._usage_limit_state,
                    self._log,
                )


class CommandHandler:
    """ADR-0007 Phase 3D — worker -> Agent Server control forwarding.

    Invoked (on RelayClient's own receive thread, NEVER the thread driving
    `conversation.run()`) with an already-authorized RelayCommandPayload
    dict: `{"commandId": ..., "command": {"type": ..., "payload": {...}}}`.
    apps/api's gateway has already checked realtime:control, execution
    status, and lease ownership before this ever arrives — this handler's
    only job is the narrow, allowlisted mapping onto the OpenHands SDK's own
    supported action surface, using the SAME `Conversation` object and the
    SAME `SESSION_API_KEY`-authenticated Agent Server connection this
    dispatch already holds for its own `.run()` call. No second local
    connection to the Agent Server is opened, and no local port is exposed —
    the audit for this phase (docs/adr/0007-secure-realtime-execution.md,
    Phase 3D status) found `RemoteConversation.send_message()` is already a
    plain REST call (`POST {base}/{id}/events`), safe to call from a second
    thread concurrently with the main thread's blocking `.run()` poll loop
    because it touches none of `RemoteConversation`'s own run-tracking state
    (`_run_armed`, `_terminal_status_queue`) — unlike `.run()`/`.pause()`/
    `.interrupt()`, which this handler deliberately does NOT call a second
    time from this thread, precisely to avoid racing the main thread's own
    in-flight `.run()` call over that shared state. A conversation that is
    still actively running already has its own server-side turn loop reading
    the event stream; adding a new user-message event via `send_message()`
    (payload `run: False`, matching local semantics) is expected to be
    picked up by that already-running turn loop without a second explicit
    trigger — verified against a real running execution as part of this
    phase's own verification pass, not assumed from reading the client
    alone (see the ADR for what that verification actually observed and any
    caveats).

    Command surface, deliberately narrow (ADR-0007: "start with the
    narrowest useful command surface... prefer explicit allowlisted command
    types"): "agent.message" (Phase 3D) plus, as of Phase 4D.2A,
    "execution.resume_same_conversation" (correction 16 — apps/api's
    POST .../usage-limit/resume route sends this over the exact same relay
    control-command pipe, via relayRegistry.sendCommand, after confirming the
    task's FSM/lease/policy preconditions server-side). A raw terminal/bash
    command type was investigated and explicitly deferred — the installed SDK
    exposes no direct shell-execution method distinct from the agent's own
    tool use, and building an unaudited second path to run arbitrary shell
    commands was rejected as unsafe for v1. See the ADR for the full
    reasoning.

    "execution.resume_same_conversation" deliberately does NOT call
    `conversation.run()` itself, for the exact same reason this class already
    never calls `.run()`/`.pause()`/`.interrupt()` from this thread (see
    above) — it only records the (possibly extended) limit and sets
    `resume_event`, which the MAIN thread (blocked in
    `run_dispatch_via_agent_server`'s wait-for-resume loop, holding the one
    `conversation.run()` call this dispatch is allowed to make at a time) is
    responsible for observing and acting on.

    Every branch below sends exactly one `send_command_ack` — "accepted" if
    the REST call to the Agent Server succeeded (the message was durably
    recorded in the conversation's event log), "rejected" if this handler
    itself declined to forward (unknown command type, malformed payload —
    an AtherNull-worker-side decision, distinct from the gateway's own
    "rejected"), or "failed" if the Agent Server's REST call itself raised.
    There is no "executed" ack from this handler — the gateway derives that
    signal from the ordinary execution.event stream this dispatch is already
    forwarding (see routes/realtime-gateway.ts), never from a second,
    worker-reported outcome that could disagree with it.
    """

    def __init__(
        self,
        conversation,
        relay: RelayClient,
        log: Callable[[str], None],
        resume_event: threading.Event | None = None,
        usage_limit_state: "UsageLimitState | None" = None,
    ) -> None:
        self._conversation = conversation
        self._relay = relay
        self._log = log
        self._resume_event = resume_event
        self._usage_limit_state = usage_limit_state
        # Guards conversation.send_message() against a hypothetically
        # overlapping second command arriving before the first REST call
        # returns (the receive loop processes commands one at a time, but a
        # lock here costs nothing and removes any doubt). httpx.Client
        # itself supports concurrent requests, but the OpenHands SDK's own
        # thread-safety story for RemoteConversation is not documented
        # either way — serializing calls through this handler is the
        # conservative, defensible choice, not a performance-critical path.
        self._lock = threading.Lock()

    def __call__(self, payload: dict) -> None:
        command_id = payload.get("commandId")
        command = payload.get("command") if isinstance(payload.get("command"), dict) else {}
        command_type = command.get("type")

        if not isinstance(command_id, str) or not command_id:
            self._log("command handler: payload missing commandId, dropping (cannot ack)")
            return

        if command_type == "execution.resume_same_conversation":
            self._handle_resume(command_id, command)
            return

        if command_type != "agent.message":
            self._log(f"command handler: unsupported command type {command_type!r}, rejecting")
            self._relay.send_command_ack(command_id, "rejected", f"unsupported command type: {command_type!r}")
            return

        command_payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
        text = command_payload.get("text")
        if not isinstance(text, str) or not text.strip():
            self._log("command handler: agent.message missing non-empty text, rejecting")
            self._relay.send_command_ack(command_id, "rejected", "missing or empty text")
            return

        try:
            with self._lock:
                self._conversation.send_message(text)
            self._relay.send_command_ack(command_id, "accepted")
        except Exception as err:  # noqa: BLE001 - must never affect the dispatch or the receive loop
            self._log(f"command handler: send_message to Agent Server failed: {err!r}")
            self._relay.send_command_ack(command_id, "failed", repr(err))

    def _handle_resume(self, command_id: str, command: dict) -> None:
        """Phase 4D.2A correction 16. Never calls conversation.run() itself —
        see the class docstring. Rejects (rather than silently accepting) if
        this dispatch was never actually paused for a usage limit, or wasn't
        paused in a same-execution-resumable way — a stray/duplicate resume
        command must never be misinterpreted as license to keep running past
        an already-enforced limit."""
        if self._resume_event is None or self._usage_limit_state is None:
            self._log("command handler: resume command received but this dispatch has no usage-limit state, rejecting")
            self._relay.send_command_ack(command_id, "rejected", "no usage-limit pause is active for this execution")
            return

        state = self._usage_limit_state
        if not (state.pause_requested and state.pause_outcome == "PAUSE" and state.resume_mode == "SAME_EXECUTION"):
            self._log("command handler: resume command received but this execution is not in a SAME_EXECUTION pause, rejecting")
            self._relay.send_command_ack(command_id, "rejected", "execution is not currently paused for a same-execution resume")
            return

        payload = command.get("payload") if isinstance(command.get("payload"), dict) else {}
        limit_quantity = payload.get("limitQuantity")
        if not isinstance(limit_quantity, (int, float)) or limit_quantity <= 0:
            self._log("command handler: resume command missing a valid limitQuantity, rejecting")
            self._relay.send_command_ack(command_id, "rejected", "missing or invalid limitQuantity")
            return

        state.new_limit_on_resume = int(limit_quantity)
        self._resume_event.set()
        self._relay.send_command_ack(command_id, "accepted")


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


def run_dispatch_via_agent_server(client: httpx.Client, dispatch: dict) -> tuple[str, str | None]:
    """Runs one dispatch end to end. Returns (outcome, reason), never raises:

      - ("success", None): the conversation's real execution_status was
        positively confirmed FINISHED (see get_fresh_execution_status) — the
        ONLY condition that ever produces this outcome. Correction 1,
        reviewer-sharpened: a whitelist, never inferred by excluding
        known-bad statuses — see the status-check loop below.
      - ("failure", reason): an ordinary agent failure (reason is usually
        None), or the fail-closed usage-enforcement path (reason =
        "USAGE_ENFORCEMENT_FAILED", correction 12).
      - ("paused", None): a genuine usage-limit pause whose enforcement
        action was INTERRUPT (resume_mode=NEW_ATTEMPT, correction 12/17).
        apps/api's POST /internal/executions/:id/usage-pause call (made from
        _enforce_usage_limit, on this dispatch's own usage-monitor thread)
        has ALREADY transitioned the task to PAUSED_USAGE_LIMIT by the time
        this returns — worker.py's caller must NOT call
        /internal/executions/:id/complete for this outcome at all; there is
        no success/failure left to report.

    A genuine same-execution usage-limit pause (enforcement action PAUSE,
    resume_mode SAME_EXECUTION) does NOT return early at all — it blocks
    inside the loop below, holding this same conversation/container alive,
    until an explicit "execution.resume_same_conversation" relay command
    arrives (correction 16), then calls conversation.run() again. Only a
    resume into a genuinely different outcome (finished, failed, or a second
    pause) ever returns from this function.
    """
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
    usage_forwarder: UsageForwarder | None = None
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

    # Phase 4D.2A — correction 2/19: `usagePolicy` is present in the claim
    # response ONLY when an ACTIVE task_usage_policies row genuinely exists
    # for this task (routes/internal.ts's claim handler); None here means
    # zero new enforcement code paths are ever triggered for this dispatch —
    # byte-for-byte the pre-4D.2A behavior. `usageBaseline` is the durable
    # cross-attempt total apps/api already summed from usage_events at claim
    # time (correction 2's `prior_task_usage_before_this_attempt`).
    usage_policy = dispatch.get("usagePolicy")
    usage_limit_state = UsageLimitState(
        baseline_task_usage=int(dispatch.get("usageBaseline") or 0),
        limit_quantity=int(usage_policy["limitQuantity"]) if usage_policy else None,
        policy_id=usage_policy["policyId"] if usage_policy else None,
        metric=usage_policy["metric"] if usage_policy else None,
    )
    resume_event = threading.Event()
    outcome = "failure"
    reason: str | None = None

    try:
        clone_repository(dispatch["repositorySnapshot"], repo_dir)

        api_key = require_api_key(dispatch["resolvedModel"])
        llm = LLM(model=dispatch["resolvedModel"], api_key=api_key)
        agent = Agent(
            llm=llm,
            tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
        )

        log(f"starting isolated container for execution {execution_id} (model={dispatch['resolvedModel']})")
        # Usage enforcement relies on the audited SDK/server pause semantics.
        # A floating image had drifted to 1.49.2 during real verification.
        workspace_options = {"server_image": "ghcr.io/openhands/agent-server:1.42.1-python"} if usage_policy else {}
        docker_workspace = LoopbackDockerWorkspace(volumes=[f"{repo_dir}:/workspace"], **workspace_options)
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

        # Phase 4D.1 — real usage metering. `lambda: conversation` closes
        # over this function's own `conversation` local variable, not a copy
        # of its current (still-None) value — the same late-bind trick this
        # function already relies on for CommandHandler below (Conversation's
        # own construction needs this forwarder in its callbacks list before
        # `conversation` exists at all). By the time UsageForwarder's
        # background thread or teardown's final poll_once() actually calls
        # this lambda, `conversation` has long since been reassigned to the
        # real object below.
        usage_forwarder = UsageForwarder(
            client,
            execution_id,
            WORKER_ID,
            lambda: conversation,
            log,
            usage_limit_state=usage_limit_state,
            get_docker_workspace=lambda: docker_workspace,
        )
        usage_forwarder.start()

        conversation = Conversation(
            agent=agent,
            workspace=docker_workspace,
            callbacks=[forwarder, RelayEventCallback(relay), usage_forwarder],
        )
        _report_conversation_id(client, execution_id, WORKER_ID, str(conversation.id))

        # ADR-0007 Phase 3D: late-bind the command handler now that
        # `conversation` exists (RelayClient itself was constructed and
        # started before this point, since Conversation's own construction
        # needs `RelayEventCallback(relay)`, which needs `relay` first — see
        # relay_client.py's set_command_handler docstring for why this
        # ordering is safe). A gateway.command CAN genuinely arrive in the
        # window between relay.start() (above) registering with the gateway
        # and this line — confirmed empirically during this phase's own
        # real-execution verification, not just theorized: the relay's WS
        # handshake can complete, making the browser's realtime:control path
        # look fully available, before Conversation's own construction (which
        # itself does WS/HTTP setup against the Agent Server) finishes. A
        # command received before this line runs is never silently lost —
        # relay_client.py's `_recv_run` sends an explicit "rejected" ack for
        # that specific case (see its own comment) rather than leaving the
        # gateway to time out into "uncertain" for a condition the worker
        # could detect and report immediately.
        relay.set_command_handler(
            CommandHandler(conversation, relay, log, resume_event=resume_event, usage_limit_state=usage_limit_state)
        )

        message = build_task_message(dispatch["objective"], dispatch["acceptanceCriteria"])
        conversation.send_message(message)

        skip_initial_run = usage_limit_state.should_enforce()
        if skip_initial_run:
            _enforce_usage_limit(conversation, docker_workspace, client, execution_id,
                                 WORKER_ID, usage_limit_state, log, reconcile=usage_forwarder.poll_once)

        # Correction 1 (reviewer-sharpened) / 16: conversation.run() returning
        # normally NEVER means success by itself — this landmine
        # (RemoteConversation._wait_for_run_completion's run_complete_callback
        # puts ANY non-RUNNING status into _terminal_status_queue, and
        # _handle_conversation_status only raises for ERROR/STUCK) is exactly
        # why every branch below is a POSITIVE, explicit check against a
        # freshly re-confirmed status, never an assumption. A same-execution
        # usage-limit pause loops back to another .run() call on this SAME
        # Conversation/container after an explicit resume command — never a
        # second Conversation, never a second container.
        while True:
            if skip_initial_run:
                skip_initial_run = False
            else:
                conversation.run()
            # Reconcile the last response before choosing a terminal outcome.
            if usage_limit_state.limit_quantity is not None:
                usage_forwarder.poll_once()

            # Real-execution verification (a genuine NVIDIA NIM run) caught a
            # real race: .run() can return on THIS thread (via the post-run
            # WebSocket state update) strictly BEFORE _enforce_usage_limit's
            # own pause-confirm / interrupt-fallback sequence, running
            # concurrently on UsageForwarder's background thread, has
            # actually finished deciding PAUSE vs INTERRUPT vs
            # ENFORCEMENT_FAILED. Reading pause_outcome at that moment could
            # observe it still None and misreport a pause that was, moments
            # later, genuinely confirmed. Bounded (30s is far longer than a
            # pause()/interrupt() REST round trip ever needs) so a genuinely
            # stuck enforcement can never hang this dispatch forever — if the
            # wait times out, enforcement_done is still unset and every check
            # below simply falls through to the anomalous/fail-closed default,
            # which is the correct, safe outcome for that unexpected case.
            if usage_limit_state.pause_requested and not usage_limit_state.enforcement_done.is_set():
                log(f"execution {execution_id}: .run() returned while usage-limit enforcement is still deciding — waiting for it to finish")
                usage_limit_state.enforcement_done.wait(timeout=30)
                if not usage_limit_state.enforcement_done.is_set():
                    usage_limit_state.force_stop_reason = "USAGE_ENFORCEMENT_FAILED"

            if usage_limit_state.force_stop_reason is not None:
                # Fail-closed (correction 12): both pause() and interrupt()
                # already failed on the usage-monitor thread, which forced
                # the container down itself. Whatever .run() just did in
                # response (raised, or returned with a now-meaningless
                # status) is irrelevant — this is unconditionally a failure.
                outcome, reason = "failure", usage_limit_state.force_stop_reason
                break

            if (
                usage_limit_state.pause_requested
                and usage_limit_state.pause_outcome == "PAUSE"
                and usage_limit_state.resume_mode == "SAME_EXECUTION"
            ):
                # Trusts _enforce_usage_limit's OWN authoritative confirmation
                # (pause_outcome is only ever set to "PAUSE" after its own
                # fresh status re-check already confirmed PAUSED) — a SECOND,
                # independent status re-check here would only reintroduce the
                # exact race this branch was restructured to close.
                log(
                    f"execution {execution_id}: genuinely paused for a usage limit "
                    "(confirmed by _enforce_usage_limit's own re-check) — holding "
                    "the conversation/container alive and waiting for an explicit "
                    "resume command"
                )
                # Blocks indefinitely — correct per the accepted
                # worker-restart limitation (docs/adr/0012): this worker
                # process holding the paused conversation open IS what makes
                # same-execution resume possible at all. If this process were
                # killed while waiting here, apps/api's own resume-route lease
                # check (routes/usage-policies.ts) is what detects the lease
                # has gone stale and steers toward the new-attempt recovery
                # path instead — nothing on this side needs its own timeout
                # to make that safe; it is a structural consequence of the
                # lease already expiring server-side.
                ownership_lost = False
                while True:
                    resume_event.wait(timeout=2)
                    resume_event.clear()
                    try:
                        authorization = client.post(
                            f"{API_URL}/internal/executions/{execution_id}/usage-resume",
                            json={"workerId": WORKER_ID}, headers=api_headers(), timeout=10,
                        )
                        if authorization.status_code in (404, 409):
                            ownership_lost = True
                            break
                        if authorization.status_code != 200:
                            continue
                        decision = authorization.json()
                        new_limit = decision["limitQuantity"]
                        if new_limit <= usage_limit_state.observed_task_usage():
                            continue
                        usage_limit_state.policy_id = decision["policyId"]
                        usage_limit_state.apply_resume(new_limit)
                        usage_limit_state.new_limit_on_resume = None
                        break
                    except (httpx.HTTPError, ValueError, KeyError) as err:
                        log(f"resume authorization unavailable; remaining paused: {err!r}")
                if ownership_lost:
                    outcome, reason = "paused", None
                    break
                # Consume the signal after accepting it. Clearing before
                # wait() loses commands delivered just after pause persistence.
                resume_event.clear()
                log(f"execution {execution_id}: resume command received — calling conversation.run() again")
                continue

            if usage_limit_state.pause_requested and usage_limit_state.pause_outcome == "INTERRUPT":
                # NEW_ATTEMPT (correction 12/17): apps/api's /usage-pause call
                # already transitioned the task to PAUSED_USAGE_LIMIT.
                # Deliberately NOT gated on a status re-check — the installed
                # SDK's interrupt() has no dedicated post-interrupt status of
                # its own (confirmed: ConversationExecutionStatus has no
                # INTERRUPTED member), and _enforce_usage_limit's own
                # confirmation step for the interrupt fallback already
                # verified non-RUNNING, whatever that resulting status
                # actually is (e.g. "idle") — this branch trusts THAT
                # confirmation (state.pause_outcome == "INTERRUPT" is only
                # ever set after it succeeded), not a second, possibly
                # racy, status read.
                # This dispatch is over — no success, no failure, and the
                # caller must NOT call /complete at all.
                log(
                    f"execution {execution_id}: usage-limit interrupt fallback — task is now "
                    "PAUSED_USAGE_LIMIT (new-attempt recovery required)"
                )
                outcome, reason = "paused", None
                break

            # Not a (confirmed) usage-limit-enforcement outcome — either no
            # policy is active for this task at all, or enforcement was
            # requested but the bounded wait above timed out without a
            # decision (an anomaly in its own right, handled safely by
            # falling through to the fail-closed default below rather than
            # ever assuming success). Ordinary whitelist check (correction 1,
            # reviewer-sharpened): a fresh, non-cached execution_status read,
            # and ConversationExecutionStatus.FINISHED is the ONLY value that
            # ever reports success — every other status (an unrequested/
            # anomalous PAUSED, WAITING_FOR_CONFIRMATION, IDLE, DELETING, or
            # an unparseable/unrecognized value, including any future status
            # a newer SDK adds that this code doesn't know about) falls
            # through to the fail-closed line below. Success is never
            # inferred by elimination.
            status = get_fresh_execution_status(conversation)
            if status == ConversationExecutionStatus.FINISHED:
                outcome, reason = "success", None
                break

            log(
                f"execution {execution_id}: anomalous non-success execution_status after "
                f".run() returned normally: {status!r} (pause_requested={usage_limit_state.pause_requested}, "
                f"pause_outcome={usage_limit_state.pause_outcome!r}) — failing closed, never reporting success"
            )
            outcome, reason = "failure", "UNEXPECTED_EXECUTION_STATUS"
            break

        log(f"agent run finished for execution {execution_id}: outcome={outcome!r} reason={reason!r}")
        return outcome, reason
    except Exception as err:  # noqa: BLE001 - any failure here must report "failure", not crash the worker loop
        log(f"execution {execution_id} failed: {err!r}")
        # If the usage-monitor thread had already forced a fail-closed
        # teardown (correction 12) before this exception was raised/caught,
        # that reason must survive even though the exception itself is
        # generic (e.g. a connection error from the container disappearing
        # out from under conversation.run()).
        return "failure", usage_limit_state.force_stop_reason
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
            if usage_forwarder is not None:
                try:
                    # Phase 4D.1 — required final reconciliation pass: a
                    # response whose stats-update trigger raced the
                    # completion path (the agent's very last LLM call, whose
                    # stats-update callback might fire after .run() has
                    # already returned/raised) must still be captured before
                    # the container that holds the real usage data is torn
                    # down. Called synchronously and directly (bypasses the
                    # background thread's debounce) — this is a genuine REST
                    # poll of conversation.stats, not the lossy event
                    # payload, exactly like every other poll_once() call.
                    usage_forwarder.poll_once()
                except Exception as usage_err:  # noqa: BLE001
                    log(f"final usage poll warning: {usage_err!r}")
            try:
                # Replay all events: the SDK can deliver older events late.
                resynced = resync_events(docker_workspace.host, session_key, str(conversation.id), None)
                _forward_resynced_events(client, execution_id, WORKER_ID, resynced)
            except Exception as recovery_err:  # noqa: BLE001
                log(f"event recovery warning: {recovery_err!r}")
        if usage_forwarder is not None:
            usage_forwarder.close()
        stop_heartbeat.set()
        heartbeat_thread.join(timeout=5)
        os.environ.pop("SESSION_API_KEY", None)
        if docker_workspace is not None:
            try:
                docker_workspace.cleanup()
            except Exception as cleanup_err:  # noqa: BLE001
                log(f"container cleanup warning: {cleanup_err!r}")
        shutil.rmtree(repo_dir, ignore_errors=True)
