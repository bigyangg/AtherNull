# workers/coding-agent

SDK-driven coding agent. Owns: SDK invocation, event capture, output packaging (spec §3).
Must not own: payment approval and settlement keys.

Pinned to `openhands-sdk`/`openhands-tools` 1.42.1 (ADR-001, `docs/adr/0001-openhands-sdk-as-dependency.md`).
Install both together: `pip install -e .` from this directory, or via the pinned versions in
`pyproject.toml` — they're released as a matched pair and must stay in sync.

The Phase 2 spike (agent edits a disposable test repo end-to-end) lands here.


## Agent Server adapter

Set `EXECUTION_ADAPTER=agent_server` in the worker environment to enable
per-execution authentication, conversation IDs, and persisted execution events.
The default is `direct`; restart the worker after changing this setting.
Apply database migrations `0006_execution_conversation_id.sql` and
`0007_execution_events.sql` before using the adapter or the event API.

Events flush every second or at 20 events. The worker flushes partial history
and attempts a complete replay before cleaning up either a successful or failed
run. Database event IDs deduplicate replay. Persistent API outages or a worker
process crash can still prevent delivery; there is no durable local outbox.
The browser polls complete snapshots and fetches again when execution stops.
Ingestion-based pagination remains future work for large histories.

Run worker regression tests from this directory with
`python -m pytest tests -q`. Install test dependencies with `pip install -e ".[dev]"`.
The API test database must also include migrations through `0007`.
