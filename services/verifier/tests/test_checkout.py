"""ADR-0019: a build with a result commit is verified by checking out exactly
that commit from a bundle AtherNull serves — no patch is applied."""

import subprocess
from pathlib import Path

import pytest

from verifier import service


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "core.autocrlf=false", "-c", "user.name=AtherNull Agent", "-c", "user.email=agent@athernull.io", *args],
        cwd=cwd, capture_output=True, text=True, check=True,
    ).stdout.strip()


@pytest.fixture()
def built(tmp_path: Path):
    """A repository with a base commit and a build commit, bundled the way the API serves it."""
    src = tmp_path / "src"
    src.mkdir()
    git(src, "init", "--quiet", "--initial-branch=main")
    (src / "app.js").write_bytes(b"export const a = 1;\r\n")
    git(src, "add", "-A")
    git(src, "commit", "--quiet", "-m", "base")
    (src / "app.js").write_bytes(b"export const a = 2;\r\n")
    git(src, "add", "-A")
    git(src, "commit", "--quiet", "-m", "build")
    commit = git(src, "rev-parse", "HEAD")
    git(src, "update-ref", "refs/heads/athernull-out-x", commit)
    bundle = tmp_path / "served.bundle"
    git(src, "bundle", "create", "--quiet", str(bundle), "refs/heads/athernull-out-x")
    return commit, bundle.read_bytes()


def job(commit: str) -> dict:
    return {"executionId": "e1", "resultCommit": commit, "patch": "diff --git a/app.js b/app.js\n", "repository": "unused", "baseRevision": "unused"}


def test_the_result_commit_is_checked_out_byte_for_byte(tmp_path: Path, built, monkeypatch) -> None:
    commit, bundle = built
    requested = []
    monkeypatch.setattr(service, "api_bytes", lambda path: (requested.append(path), (200, bundle))[1])
    work = tmp_path / "work"
    work.mkdir()
    assert service.checkout(job(commit), work / "repo") is None
    assert requested == [f"/internal/verifications/e1/bundle?verifierId={service.VERIFIER_ID}"]
    assert git(work / "repo", "rev-parse", "HEAD") == commit
    assert (work / "repo" / "app.js").read_bytes() == b"export const a = 2;\r\n", "line endings untouched"


def test_an_unavailable_commit_or_empty_change_fails_verification(tmp_path: Path, built, monkeypatch) -> None:
    commit, _ = built
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(service, "api_bytes", lambda path: (409, b""))
    assert "could not fetch" in service.checkout(job(commit), work / "a")
    assert service.checkout({**job(commit), "patch": "  "}, work / "b") == "the build made no changes"


def test_a_bundle_without_the_commit_fails(tmp_path: Path, built, monkeypatch) -> None:
    _, bundle = built
    monkeypatch.setattr(service, "api_bytes", lambda path: (200, bundle))
    work = tmp_path / "work"
    work.mkdir()
    assert "is missing" in service.checkout(job("0" * 40), work / "repo")
