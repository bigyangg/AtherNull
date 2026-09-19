# workers/coding-agent

SDK-driven coding agent. Owns: SDK invocation, event capture, output packaging (spec §3).
Must not own: payment approval and settlement keys.

Pinned to `openhands-sdk`/`openhands-tools` 1.42.1 (ADR-001, `docs/adr/0001-openhands-sdk-as-dependency.md`).
Install both together: `pip install -e .` from this directory, or via the pinned versions in
`pyproject.toml` — they're released as a matched pair and must stay in sync.

The Phase 2 spike (agent edits a disposable test repo end-to-end) lands here.
