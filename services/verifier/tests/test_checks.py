import json
from pathlib import Path

from verifier.checks import NPM_DEFAULT_TEST, decide, detect_test_plan, parse_results


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_dependency_free_node_project_needs_no_install(tmp_path: Path) -> None:
    write(tmp_path / "package.json", json.dumps({"scripts": {"test": "node --test"}}))
    plan = detect_test_plan(tmp_path)
    assert plan is not None and plan.install is None and plan.parser == "tap"


def test_node_project_with_deps_installs_from_lockfile(tmp_path: Path) -> None:
    write(tmp_path / "package.json", json.dumps({"scripts": {"test": "jest"}, "devDependencies": {"jest": "1"}}))
    write(tmp_path / "package-lock.json", "{}")
    assert detect_test_plan(tmp_path).install.startswith("npm ci")


def test_npm_placeholder_test_script_is_not_a_test(tmp_path: Path) -> None:
    write(tmp_path / "package.json", json.dumps({"scripts": {"test": NPM_DEFAULT_TEST}}))
    assert detect_test_plan(tmp_path) is None


def test_python_project_uses_pytest(tmp_path: Path) -> None:
    write(tmp_path / "tests" / "test_app.py", "def test_x():\n    assert True\n")
    write(tmp_path / "requirements.txt", "flask\n")
    plan = detect_test_plan(tmp_path)
    assert plan.parser == "pytest" and "-r requirements.txt" in plan.install


def test_no_tests_means_no_plan(tmp_path: Path) -> None:
    write(tmp_path / "README.md", "hi")
    assert detect_test_plan(tmp_path) is None


def test_tap_results_including_nested_and_skipped() -> None:
    out = """TAP version 13
ok 1 - GET /health reports ok
not ok 2 - notes can be created
    ok 1 - nested subtest
ok 3 - pending thing # SKIP not ready
"""
    assert parse_results("tap", out) == [
        {"name": "GET /health reports ok", "passed": True},
        {"name": "notes can be created", "passed": False},
        {"name": "nested subtest", "passed": True},
    ]


def test_node_spec_results_ignore_the_failure_summary() -> None:
    out = """✔ GET /health reports ok (61.25ms)
✖ notes can be created (27.7ms)
ℹ tests 2
✖ failing tests:

test at test/app.test.js:17:1
✖ notes can be created (27.7ms)
"""
    assert parse_results("tap", out) == [
        {"name": "GET /health reports ok", "passed": True},
        {"name": "notes can be created", "passed": False},
    ]


def test_pytest_results() -> None:
    out = "PASSED tests/test_app.py::test_ok\nFAILED tests/test_app.py::test_bad - assert 1 == 2\n"
    assert parse_results("pytest", out) == [
        {"name": "tests/test_app.py::test_ok", "passed": True},
        {"name": "tests/test_app.py::test_bad", "passed": False},
    ]


def test_decision_is_strict() -> None:
    passing = [{"name": "a", "passed": True}]
    assert decide(0, passing)[0] == "PASS"
    assert decide(0, [])[0] == "FAIL", "no tests ran"
    assert decide(1, passing)[0] == "FAIL", "non-zero exit"
    assert decide(0, [{"name": "a", "passed": False}])[0] == "FAIL"
    assert decide(None, passing)[0] == "FAIL", "timeout"
