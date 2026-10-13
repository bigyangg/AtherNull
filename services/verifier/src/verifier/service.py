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

import base64
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

from verifier.checks import (
    decide,
    decide_browser,
    detect_preview_plan,
    detect_test_plan,
    parse_results,
    preview_root,
)

API_URL = os.getenv("ATHERNULL_API_URL", "http://localhost:3001").rstrip("/")
TOKEN = os.getenv("VERIFIER_API_TOKEN", "")
VERIFIER_ID = os.getenv("VERIFIER_ID", f"verifier-{uuid.uuid4().hex[:8]}")
IMAGE = os.getenv("VERIFIER_IMAGE", "ghcr.io/openhands/agent-server:latest-python")
POLL_SECONDS = float(os.getenv("VERIFIER_POLL_SECONDS", "5"))
# The dependency install is the only step with a network. In production it
# runs on the customer-sandbox network (athernull-sandboxes), so the host
# firewall applies: public registries yes, the host / private ranges / other
# sandboxes no (docs/runbooks/sandbox-network.md). Tests always run offline.
INSTALL_NETWORK = os.getenv("VERIFIER_INSTALL_NETWORK", "bridge")
INSTALL_DNS = [d.strip() for d in os.getenv("VERIFIER_INSTALL_DNS", "").split(",") if d.strip()]
TEST_TIMEOUT = int(os.getenv("VERIFIER_TEST_TIMEOUT_SECONDS", "600"))
LOG_TAIL = 8000
# Live preview limits (the API enforces the same ones).
PREVIEW_MAX_FILES = 2000
PREVIEW_MAX_BYTES = 20 * 1024 * 1024
PREVIEW_SKIP_DIRS = {".git", "node_modules"}


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


def api_bytes(path: str) -> tuple[int, bytes]:
    """A binary download from the API (a git bundle)."""
    req = urllib.request.Request(f"{API_URL}{path}", method="GET", headers={"authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        return err.code, b""


def git(*args: str, cwd: Path) -> subprocess.CompletedProcess:
    # No line-ending conversion: the patch must apply to the committed bytes,
    # whatever the host's git defaults (Windows: core.autocrlf=true).
    return subprocess.run(
        ["git", "-c", "core.autocrlf=false", *args], cwd=cwd, capture_output=True, text=True, check=False
    )


def checkout_commit(job: dict, into: Path) -> str | None:
    """ADR-0019: a fresh clone of exactly the build's result commit, fetched
    from AtherNull as a bundle. Nothing is applied or re-created."""
    if not job["patch"].strip():
        return "the build made no changes"
    status, bundle = api_bytes(f"/internal/verifications/{job['executionId']}/bundle?verifierId={VERIFIER_ID}")
    if status != 200 or not bundle:
        return f"could not fetch the build's commit (HTTP {status})"
    bundle_file = into.parent / "result.bundle"
    bundle_file.write_bytes(bundle)
    clone = subprocess.run(
        ["git", "-c", "core.autocrlf=false", "clone", "--quiet", "--config", "core.autocrlf=false", str(bundle_file), str(into)],
        capture_output=True,
        text=True,
        check=False,
    )
    if clone.returncode != 0:
        return f"could not open the build's commit: {clone.stderr.strip()[-300:]}"
    co = git("checkout", "--quiet", job["resultCommit"], cwd=into)
    if co.returncode != 0:
        return f"the build's commit {job['resultCommit']} is missing: {co.stderr.strip()[-300:]}"
    return None


def checkout(job: dict, into: Path) -> str | None:
    """Fresh checkout of the approved revision plus the patch. Returns an
    error message, or None on success."""
    if job.get("resultCommit"):
        return checkout_commit(job, into)
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


def in_container(
    workdir: Path, command: str, network: bool, timeout: int, env: dict[str, str] | None = None
) -> tuple[int | None, str]:
    args = [
        "docker", "run", "--rm",
        *[arg for key, value in (env or {}).items() for arg in ("-e", f"{key}={value}")],
        "--network", INSTALL_NETWORK if network else "none",
        *[arg for dns in (INSTALL_DNS if network else []) for arg in ("--dns", dns)],
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
        **({"resultCommit": job["resultCommit"]} if job.get("resultCommit") else {}),
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
        result = {"outcome": outcome, "tests": tests, "evidence": evidence}
        if outcome == "PASS":
            root, note = preview_site(repo)
            evidence["preview"] = note
            if root is not None:
                # A web app must also work in a browser: passing unit tests
                # with a page that throws on load, or whose buttons do
                # nothing, is not a working build.
                browser = browser_check(repo, root)
                verdict, why = decide_browser(browser)
                evidence["browserCheck"] = {"verdict": verdict, "reason": why, **(browser or {})}
                tests.append({"name": "web page loads without errors and responds in a browser", "passed": verdict != "FAIL"})
                if verdict == "FAIL":
                    result["outcome"] = "FAIL"
                    evidence["reason"] = f"the app does not work in a browser: {why}"
                    evidence["preview"] = "no preview: the app failed the browser check"
                    return result
                files, note = collect_preview(root)
                evidence["preview"] = note
                if files:
                    result["preview"] = files
        return result
    finally:
        evidence["durationMs"] = int((time.monotonic() - started) * 1000)
        shutil.rmtree(tmp, ignore_errors=True)


BROWSER_SMOKE = Path(__file__).with_name("browser_smoke.mjs")
SMOKE_PORT = 8123


def preview_site(repo: Path) -> tuple[Path | None, str]:
    """Where the verified checkout's static site is, building it first if the
    project has a build step (offline, like the tests)."""
    plan = detect_preview_plan(repo)
    if plan.build:
        code, output = in_container(repo, plan.build, network=False, timeout=TEST_TIMEOUT, env={"PUBLIC_URL": "."})
        if code != 0:
            return None, f"no preview: the site build failed (exit {code}): {output[-300:]}"
    root = preview_root(repo, plan)
    if root is None:
        return None, "no preview: no index.html (not a web app, or no static build output)"
    return root, "web app found"


def browser_check(repo: Path, root: Path) -> dict | None:
    """Opens the site in headless Chromium inside the verifier's container,
    still with no network: the page is served from the checkout itself."""
    shutil.copyfile(BROWSER_SMOKE, repo / ".athernull-smoke.mjs")
    rel = root.relative_to(repo).as_posix()
    site = "/work" if rel in ("", ".") else f"/work/{rel}"
    command = (
        f"cd {site} && (python3 -m http.server {SMOKE_PORT} --bind 127.0.0.1 >/dev/null 2>&1 &) "
        f"&& sleep 1 && node /work/.athernull-smoke.mjs http://127.0.0.1:{SMOKE_PORT}/"
    )
    _code, output = in_container(repo, command, network=False, timeout=150)
    for line in reversed(output.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                return None
    return None


def collect_preview(root: Path) -> tuple[list[dict] | None, str]:
    """The site's files, upload-ready."""
    files: list[dict] = []
    total = 0
    for path in sorted(root.rglob("*")):
        rel_parts = path.relative_to(root).parts
        if any(part in PREVIEW_SKIP_DIRS or part.startswith(".") for part in rel_parts):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        data = path.read_bytes()
        total += len(data)
        if len(files) >= PREVIEW_MAX_FILES or total > PREVIEW_MAX_BYTES:
            return None, "no preview: the site is too large"
        files.append({"path": "/".join(rel_parts), "content": base64.b64encode(data).decode("ascii")})
    return files, f"preview built: {len(files)} files, {total} bytes"


def publish_preview(job: dict, files: list[dict]) -> None:
    status, body = api(
        "POST",
        f"/internal/verifications/{job['executionId']}/preview",
        {"verifierId": VERIFIER_ID, "files": files},
    )
    log(f"task {job['taskId']}: preview publish -> {status} {body or ''}")


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
        preview = result.pop("preview", None)
        if preview:
            # Published while this verifier still holds the lease, before the
            # verdict makes the build reviewable.
            try:
                publish_preview(job, preview)
            except Exception as err:  # noqa: BLE001 - a preview never blocks the verdict
                log(f"task {job['taskId']}: preview publish failed: {err!r}")
        status, _ = api(
            "POST",
            f"/internal/verifications/{job['executionId']}/result",
            {"verifierId": VERIFIER_ID, **result},
        )
        log(f"task {job['taskId']}: {result['outcome']} ({result['evidence'].get('reason')}) -> report {status}")


if __name__ == "__main__":
    main()
