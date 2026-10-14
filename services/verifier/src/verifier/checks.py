"""Pure verification logic: which test command a checkout needs, and how to
read its results. No I/O here, so it is unit-tested directly."""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1'


@dataclass(frozen=True)
class TestPlan:
    """How to verify one checkout: an optional install step (network allowed)
    and the test command (always run with no network)."""

    install: str | None
    test: str
    parser: str  # "tap" | "pytest"


_NODE_TEST_FILE = re.compile(r"(^|[._-])(test|spec)s?\.(c|m)?js$")


def node_test_files(checkout: Path) -> list[str]:
    """JavaScript test files, as Node's test runner names them: *.test.js,
    *.spec.js, test-*.js, and anything under a test/ or tests/ directory."""
    found = []
    for path in sorted(checkout.rglob("*.*js")):
        rel = path.relative_to(checkout)
        if "node_modules" in rel.parts or not path.is_file() or path.suffix not in (".js", ".mjs", ".cjs"):
            continue
        if _NODE_TEST_FILE.search(path.name) or path.name.startswith("test-") or any(p in ("test", "tests") for p in rel.parts[:-1]):
            found.append(rel.as_posix())
    return found[:200]


def detect_test_plan(checkout: Path) -> TestPlan | None:
    package_json = checkout / "package.json"
    pkg: dict = {}
    if package_json.is_file():
        try:
            pkg = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pkg = {}
    has_deps = bool(pkg.get("dependencies") or pkg.get("devDependencies"))
    install = None
    if has_deps:
        lock = (checkout / "package-lock.json").is_file()
        install = "npm ci --ignore-scripts --no-audit --no-fund" if lock else "npm install --ignore-scripts --no-audit --no-fund"
    test_script = (pkg.get("scripts") or {}).get("test")
    if test_script and test_script.strip() != NPM_DEFAULT_TEST:
        # node --test (and most JS runners) print TAP when stdout is not a TTY.
        return TestPlan(install=install, test="npm test --silent", parser="tap")

    # Tests written for Node's built-in runner but no `npm test` script (the
    # agent forgot package.json): run them directly rather than fail a build
    # whose tests exist.
    files = node_test_files(checkout)
    if files:
        return TestPlan(install=install, test=shlex.join(["node", "--test", *files]), parser="tap")

    python_markers = ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"]
    has_python_tests = any((checkout / m).is_file() for m in python_markers) or any(
        checkout.rglob("test_*.py")
    )
    if has_python_tests:
        install = "python -m pip install -q pytest"
        if (checkout / "requirements.txt").is_file():
            install += " -r requirements.txt"
        return TestPlan(install=install, test="python -m pytest -q -rA", parser="pytest")
    return None


_TAP = re.compile(r"^\s*(not )?ok \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$")
# node --test's "spec" reporter (the default in recent Node, TTY or not).
_SPEC = re.compile(r"^\s*(✔|✖) (.+?)(?: \([\d.]+ms\))?$")
_PYTEST = re.compile(r"^(PASSED|FAILED|ERROR) (\S+)")


def parse_results(parser: str, output: str) -> list[dict]:
    tests: list[dict] = []
    for line in output.splitlines():
        if parser == "tap":
            # node's spec reporter repeats failures in a trailing summary.
            if "failing tests:" in line:
                break
            m = _TAP.match(line)
            if m and not m.group(3):
                tests.append({"name": m.group(2).strip()[:500], "passed": m.group(1) is None})
                continue
            m = _SPEC.match(line)
            if m:
                tests.append({"name": m.group(2).strip()[:500], "passed": m.group(1) == "✔"})
        else:
            m = _PYTEST.match(line)
            if m:
                tests.append({"name": m.group(2)[:500], "passed": m.group(1) == "PASSED"})
    return tests


@dataclass(frozen=True)
class PreviewPlan:
    """How to turn a verified checkout into a static site for its live
    preview: an optional build command (run offline, after the tests) and
    the directories, in order, where the finished site may be."""

    build: str | None
    candidates: tuple[str, ...]


# Where common static builds put their output (Vite, CRA, Next export).
PREVIEW_OUTPUT_DIRS = ("dist", "build", "out")


def detect_preview_plan(checkout: Path) -> PreviewPlan:
    """A package.json "build" script is run (asset paths made relative, so the
    site works under /preview/<id>/); otherwise the checkout itself is the
    site if it has an index.html at its root."""
    package_json = checkout / "package.json"
    if package_json.is_file():
        try:
            pkg = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pkg = {}
        build_script = (pkg.get("scripts") or {}).get("build")
        if isinstance(build_script, str) and build_script.strip():
            command = "npm run build --silent"
            if "vite" in build_script:
                command += " -- --base=./"
            return PreviewPlan(build=command, candidates=(*PREVIEW_OUTPUT_DIRS, "."))
    return PreviewPlan(build=None, candidates=(".",))


def preview_root(checkout: Path, plan: PreviewPlan) -> Path | None:
    for candidate in plan.candidates:
        root = checkout if candidate == "." else checkout / candidate
        if (root / "index.html").is_file():
            return root
    return None


def decide_browser(result: dict | None) -> tuple[str, str]:
    """The browser smoke check's verdict on a verified web app.

    FAIL when the page throws errors or fails to load its own files, or has
    buttons and clicking them changes nothing on the page. INCONCLUSIVE when
    the check itself could not run (an infrastructure problem must not fail
    the customer's build). PASS otherwise."""
    if not result:
        return "INCONCLUSIVE", "the browser check produced no result"
    errors = [str(e) for e in result.get("errors") or []]
    infra = [e for e in errors if e.startswith(("the browser check could not run", "the browser check timed out"))]
    if infra and len(infra) == len(errors):
        return "INCONCLUSIVE", infra[0]
    if errors:
        more = f" (and {len(errors) - 1} more)" if len(errors) > 1 else ""
        return "FAIL", f"the page has errors in a browser: {errors[0]}{more}"
    if (result.get("buttons") or 0) > 0 and result.get("interactive") is False:
        return "FAIL", "the page's buttons do nothing when clicked"
    return "PASS", "the page loads without errors and responds to clicks"


def decide(exit_code: int | None, tests: list[dict]) -> tuple[str, str]:
    """PASS only when the suite exited 0 AND ran at least one test AND none
    failed. Anything else — including "no tests ran" — is a FAIL."""
    if exit_code is None:
        return "FAIL", "the test run timed out"
    if not tests:
        return "FAIL", "no tests ran"
    failed = [t for t in tests if not t["passed"]]
    if exit_code != 0 or failed:
        return "FAIL", f"{len(failed)} of {len(tests)} tests failed (exit {exit_code})"
    return "PASS", f"{len(tests)} tests passed"
