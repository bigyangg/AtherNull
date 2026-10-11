# services/verifier

Independent verification (ADR-0017). Claims a build awaiting verification,
clones the repository at the approved revision, applies only the patch the
worker captured, and runs the project's tests in a throwaway container with
no network. Reports PASS/FAIL with evidence; the API moves the build to
review or FAILED.

It never sees the worker's success claim, and it uses its own token
(`VERIFIER_API_TOKEN`, distinct from the worker's), so a worker cannot
approve its own work.

```sh
PYTHONPATH=src VERIFIER_API_TOKEN=... ATHERNULL_API_URL=http://localhost:3001   python -m verifier.service
PYTHONPATH=src python -m pytest tests     # unit tests
```

Env: `VERIFIER_IMAGE` (default `ghcr.io/openhands/agent-server:latest-python`,
has Node and Python), `VERIFIER_TEST_TIMEOUT_SECONDS` (600),
`VERIFIER_POLL_SECONDS` (5). Stdlib only; needs `git` and `docker`.
