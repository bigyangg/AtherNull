"""AtherNull independent verifier (ADR-0017).

Loop: claim a build awaiting verification -> fresh checkout of the approved
revision -> apply ONLY the captured patch -> run the project's tests in a
throwaway container with no network -> report PASS/FAIL with evidence.

It never sees the worker's success claim or the agent's own test output,
and it authenticates with its own token, distinct from the worker's.

    VERIFIER_API_TOKEN=... ATHERNULL_API_URL=http://localhost:3001 \\
        python -m verifier.service
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from verifier.checks import decide, detect_test_plan, parse_results

API_URL = os.getenv("ATHERNULL_API_URL", "http://localhost:3001").rstrip("/")
TOKEN = os.getenv("VERIFIER_API_TOKEN", "")
VERIFIER_ID = os.getenv("VERIFIER_ID", f"verifier-{uuid.uuid4().hex[:8]}")
IMAGE = os.getenv("VERIFIER_IMAGE", "ghcr.io/openhands/agent-server:latest-python")
POLL_SECONDS = float(os.getenv("VERIFIER_POLL_SECONDS", "5"))
TEST_TIMEOUT = int(os.getenv("VERIFIER_TEST_TIMEOUT_SECONDS", "600"))
LOG_TAIL = 8000


def log(message: str) -> None:
    print(f"[{VERIFIER_ID}] {message}", flush=True)


def api(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API_URL}{path}",
        data=data,
        method=method,
        headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read()
            return res.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        return err.code, None


def git(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    # No line-ending conversion: the patch must apply to the committed bytes,
    # whatever the host's git defaults (Windows: core.autocrlf=true).
    return subprocess.run(
        ["git", "-c", "core.autocrlf=false", *args], cwd=cwd, capture_output=True, text=True, check=False
    )


def checkout(job: dict, into: Path) -> str | None:
    """Fresh checkout of the approved revision plus the patch. Returns an
    error message, or None on success."""
    clone = subprocess.run(
        ["git", "-c", "core.autocrlf=false", "clone", "--quiet", "--config", "core.autocrlf=false", job["repository"], str(into)],
        capture_output=True,
        text=True,
        check=False,
    )
    if clone.returncode != 0:
        return f"could not clone the repository: {clone.stderr.strip()[-300:]}"
    co = git("checkout", "--quiet", job["baseRevision"], cwd=into)
    if co.returncode != 0:
        return f"approved revision {job['baseRevision']} not found: {co.stderr.strip()[-300:]}"
    if not job["patch"].strip():
        return "the build made no changes"
    patch_file = into.parent / "change.patch"
    patch_file.write_text(job["patch"], encoding="utf-8", newline="")  # never translate line endings
    applied = git("apply", "--index", "--whitespace=nowarn", str(patch_file), cwd=into)
    if applied.returncode != 0:
        return f"the build's patch does not apply to the approved revision: {applied.stderr.strip()[-300:]}"
    return None


def in_container(workdir: Path, command: str, network: bool, timeout: int) -> tuple[int | None, str]:
    args = [
        "docker", "run", "--rm",
        "--network", "bridge" if network else "none",
        "--memory", "2g", "--cpus", "2", "--pids-limit", "512",
        "-v", f"{workdir}:/work", "-w", "/work",
        "--entrypoint", "bash", IMAGE, "-lc", command,
    ]
    try:
        run = subprocess.run(
            args, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout, check=False
        )
        return run.returncode, (run.stdout or "") + (run.stderr or "")
    except subprocess.TimeoutExpired as err:
        out = err.stdout.decode() if isinstance(err.stdout, bytes) else (err.stdout or "")
        return None, out


def verify(job: dict) -> dict:
    started = time.monotonic()
    evidence: dict = {
        "repository": job["repository"],
        "baseRevision": job["baseRevision"],
        "patchSha256": job["patchSha256"],
        "image": IMAGE,
        "network": "none during tests",
    }
    tmp = Path(tempfile.mkdtemp(prefix="athernull-verify-"))
    try:
        repo = tmp / "repo"
        problem = checkout(job, repo)
        if problem:
            evidence["reason"] = problem
            return {"outcome": "FAIL", "tests": [], "evidence": evidence}

        plan = detect_test_plan(repo)
        if plan is None:
            evidence["reason"] = "no test command found (package.json test script or pytest)"
            return {"outcome": "FAIL", "tests": [], "evidence": evidence}
        evidence["testCommand"] = plan.test

        if plan.install:
            code, output = in_container(repo, plan.install, network=True, timeout=TEST_TIMEOUT)
            evidence["install"] = {"command": plan.install, "exitCode": code}
            if code != 0:
                evidence["reason"] = "installing dependencies failed"
                evidence["logTail"] = output[-LOG_TAIL:]
                return {"outcome": "FAIL", "tests": [], "evidence": evidence}

        code, output = in_container(repo, plan.test, network=False, timeout=TEST_TIMEOUT)
        tests = parse_results(plan.parser, output)
        outcome, reason = decide(code, tests)
        evidence.update({"exitCode": code, "reason": reason, "logTail": output[-LOG_TAIL:]})
        return {"outcome": outcome, "tests": tests, "evidence": evidence}
    finally:
        evidence["durationMs"] = int((time.monotonic() - started) * 1000)
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> None:
    if not TOKEN:
        print("VERIFIER_API_TOKEN is required", file=sys.stderr)
        raise SystemExit(2)
    log(f"online, polling {API_URL} every {POLL_SECONDS}s (image={IMAGE})")
    while True:
        try:
            status, job = api("POST", "/internal/verifications/claim", {"verifierId": VERIFIER_ID})
        except (urllib.error.URLError, OSError) as err:
            log(f"claim failed: {err!r}")
            time.sleep(POLL_SECONDS)
            continue
        if status != 200 or not job:
            if status not in (200, 204):
                log(f"claim refused ({status})")
            time.sleep(POLL_SECONDS)
            continue

        log(f"verifying task {job['taskId']} (execution {job['executionId']})")
        try:
            result = verify(job)
        except Exception as err:  # noqa: BLE001 - a verifier crash must not pass a build
            result = {"outcome": "FAIL", "tests": [], "evidence": {"reason": f"verifier error: {err!r}"[:500]}}
        status, _ = api(
            "POST",
            f"/internal/verifications/{job['executionId']}/result",
            {"verifierId": VERIFIER_ID, **result},
        )
        log(f"task {job['taskId']}: {result['outcome']} ({result['evidence'].get('reason')}) -> report {status}")


if __name__ == "__main__":
    main()
