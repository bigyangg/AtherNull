"""AtherNull OpenHands worker.

Wraps the pinned openhands-sdk/openhands-tools behind this package's own
adapter (see ADR-001) so the public platform API in packages/contracts never
depends on OpenHands' internal signatures directly.
"""
