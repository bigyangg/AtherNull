"""
Checkpoint Manager for AtherNull Worker.

Handles creation, rollback, and management of checkpoints during build execution.
Integrates with the org sandbox adapter for git commits, conversation state snapshots,
and environment captures.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from coding_agent.memory import (
    Checkpoint,
    CheckpointLabel,
    ErrorContext,
    ErrorType,
    MemoryManager,
    RollbackAction,
    RollbackDecision,
    RollbackResult,
    get_memory_manager,
)
from coding_agent.worker import log
from coding_agent.org_sandbox_adapter import _Sandbox


class CheckpointManager:
    """Manages checkpoints for a build task in the org sandbox."""

    def __init__(
        self,
        sandbox: "_Sandbox",
        task_id: str,
        execution_id: str,
        project_id: str,
        workdir: str,
        conversation_id: str | None = None,
    ):
        self.sandbox = sandbox
        self.task_id = task_id
        self.execution_id = execution_id
        self.project_id = project_id
        self.workdir = workdir
        self.conversation_id = conversation_id
        self.memory_mgr = get_memory_manager(project_id)
        self.current_checkpoint_id: str | None = None

    def create_checkpoint(self, label: CheckpointLabel, reason: str) -> Checkpoint:
        """Create a new checkpoint with git commit, conversation state, and environment."""
        # 1. Git commit working tree
        commit = self._git_commit_all(f"checkpoint: {label.value} - {reason}")

        # 2. Snapshot conversation state
        conv_state = self._capture_conversation_state()

        # 3. Snapshot environment
        env_snapshot = self._capture_environment()

        # 4. Get changed files since last checkpoint
        files_changed = self._get_changed_files(commit)

        # 5. Create checkpoint metadata
        checkpoint_id = f"cp-{uuid.uuid4().hex[:8]}"
        cp = Checkpoint(
            id=checkpoint_id,
            label=label,
            reason=reason,
            git_commit=commit,
            conversation_state=conv_state,
            environment=env_snapshot,
            timestamp=datetime.now(UTC).isoformat(),
            parent_checkpoint=self.current_checkpoint_id,
            task_id=self.task_id,
            execution_id=self.execution_id,
            project_id=self.project_id,
            files_changed=files_changed,
        )

        # 6. Persist
        self.memory_mgr.save_checkpoint(cp)
        self.current_checkpoint_id = checkpoint_id
        log(f"Created checkpoint {checkpoint_id} ({label.value}): {reason}")
        return cp

    def rollback_to(self, checkpoint_id: str) -> RollbackResult:
        """Rollback to a specific checkpoint."""
        cp = self.memory_mgr.load_checkpoint(checkpoint_id)
        if not cp:
            return RollbackResult(
                success=False,
                error=f"Checkpoint {checkpoint_id} not found",
            )

        try:
            # 1. Git reset --hard to checkpoint commit
            self._git_reset_hard(cp.git_commit)

            # 2. Restore conversation state (create new conversation from checkpoint)
            new_conv = self._restore_conversation(cp.conversation_state)

            # 3. Restore environment
            self._restore_environment(cp.environment)

            log(f"Rolled back to checkpoint {checkpoint_id} ({cp.label.value})")
            return RollbackResult(
                success=True,
                new_conversation_id=new_conv.id if new_conv else None,
                checkpoint=cp,
                files_restored=cp.files_changed or [],
            )
        except Exception as e:
            log(f"Rollback to {checkpoint_id} failed: {e}")
            return RollbackResult(success=False, error=str(e))

    def _git_commit_all(self, message: str) -> str:
        """Commit all changes in working directory and return commit SHA."""
        q = shlex.quote
        code, output = self.sandbox.bash(
            f"cd {q(self.workdir)} && git add -A && "
            f"git -c user.name='AtherNull Agent' -c user.email=agent@athernull.io "
            f"-c commit.gpgsign=false commit --quiet --allow-empty -m {q(message)}"
        )
        if code != 0:
            # If nothing to commit, get current HEAD
            code, output = self.sandbox.bash(f"cd {q(self.workdir)} && git rev-parse HEAD")
            if code == 0:
                return output.strip()
            raise RuntimeError(f"git commit failed (exit {code}): {output[-300:]}")

        # Get the new commit SHA
        code, output = self.sandbox.bash(f"cd {q(self.workdir)} && git rev-parse HEAD")
        if code != 0:
            raise RuntimeError(f"git rev-parse failed (exit {code}): {output[-300:]}")
        return output.strip()

    def _git_reset_hard(self, commit: str) -> None:
        """Hard reset working directory to a commit."""
        q = shlex.quote
        code, output = self.sandbox.bash(
            f"cd {q(self.workdir)} && git reset --hard {q(commit)}"
        )
        if code != 0:
            raise RuntimeError(f"git reset --hard failed (exit {code}): {output[-300:]}")

    def _get_changed_files(self, since_commit: str) -> list[str]:
        """Get list of files changed since a commit."""
        q = shlex.quote
        code, output = self.sandbox.bash(
            f"cd {q(self.workdir)} && git diff --name-only {q(since_commit)}"
        )
        if code != 0:
            return []
        return [f.strip() for f in output.strip().split("\n") if f.strip()]

    def _capture_conversation_state(self) -> dict[str, Any]:
        """Capture the current conversation state from the Agent Server."""
        if not self.conversation_id:
            return {}

        try:
            res = self.sandbox.http.get(f"/api/conversations/{self.conversation_id}")
            res.raise_for_status()
            info = res.json()
            return {
                "conversation_id": self.conversation_id,
                "title": info.get("title"),
                "execution_status": info.get("execution_status"),
                "message_count": info.get("message_count", 0),
                "created_at": info.get("created_at"),
                "updated_at": info.get("updated_at"),
                "tags": info.get("tags", {}),
            }
        except Exception as e:
            log(f"Failed to capture conversation state: {e}")
            return {}

    def _restore_conversation(self, conv_state: dict[str, Any]) -> Any | None:
        """Restore conversation state by creating a new conversation from checkpoint.
        Returns the new conversation info or None if failed.
        """
        # This would need to be implemented based on the Agent Server API
        # For now, we create a new conversation and the agent continues from there
        # The conversation state provides context for the agent to resume
        log(f"Restoring conversation from checkpoint: {conv_state.get('conversation_id')}")
        return None

    def _capture_environment(self) -> dict[str, Any]:
        """Capture environment snapshot: env vars, installed packages, running processes."""
        env = {}

        # Environment variables (filtered)
        try:
            code, output = self.sandbox.bash("env")
            if code == 0:
                env_vars = {}
                for line in output.strip().split("\n"):
                    if "=" in line:
                        k, v = line.split("=", 1)
                        # Only capture relevant env vars
                        if any(prefix in k for prefix in ["PATH", "HOME", "USER", "LANG", "TERM", "PYTHON", "NODE", "NPM", "PIP", "UV", "POETRY", "CARGO", "GO", "JAVA", "GRADLE", "MAVEN", "DOCKER", "KUBERNETES", "AWS", "GCP", "AZURE", "DATABASE", "REDIS", "POSTGRES", "MYSQL", "MONGO", "ES", "KAFKA", "RABBIT", "NATS", "CONSUL", "VAULT", "NOMAD", "TERRAFORM", "ANSIBLE", "CHEF", "PUPPET", "SALT"]):
                            env_vars[k] = v
                env["env_vars"] = env_vars
        except Exception as e:
            log(f"Failed to capture env vars: {e}")

        # Python packages
        try:
            code, output = self.sandbox.bash("pip list --format=json")
            if code == 0:
                env["python_packages"] = json.loads(output)
        except Exception as e:
            log(f"Failed to capture python packages: {e}")

        # Node version and packages
        try:
            code, output = self.sandbox.bash("node --version && npm --version")
            if code == 0:
                lines = output.strip().split("\n")
                env["node_version"] = lines[0] if lines else None
                env["npm_version"] = lines[1] if len(lines) > 1 else None
        except Exception as e:
            log(f"Failed to capture node info: {e}")

        try:
            code, output = self.sandbox.bash("npm list --json --depth=0")
            if code == 0:
                env["npm_packages"] = json.loads(output).get("dependencies", {})
        except Exception as e:
            log(f"Failed to capture npm packages: {e}")

        # Running processes
        try:
            code, output = self.sandbox.bash("ps aux --no-headers | head -20")
            if code == 0:
                env["processes"] = output.strip().split("\n")
        except Exception as e:
            log(f"Failed to capture processes: {e}")

        # Disk usage
        try:
            code, output = self.sandbox.bash("df -h /workspace")
            if code == 0:
                env["disk_usage"] = output.strip()
        except Exception as e:
            log(f"Failed to capture disk usage: {e}")

        return env

    def _restore_environment(self, env_snapshot: dict[str, Any]) -> None:
        """Restore environment from snapshot."""
        # Reinstall Python packages
        if "python_packages" in env_snapshot:
            packages = env_snapshot["python_packages"]
            if isinstance(packages, list):
                pkg_specs = [f"{p['name']}=={p['version']}" for p in packages if "name" in p and "version" in p]
                if pkg_specs:
                    self.sandbox.bash(f"pip install {' '.join(pkg_specs)}")

        # Reinstall npm packages
        if "npm_packages" in env_snapshot:
            pkgs = env_snapshot["npm_packages"]
            if isinstance(pkgs, dict):
                pkg_specs = [f"{name}@{version}" for name, version in pkgs.items()]
                if pkg_specs:
                    self.sandbox.bash(f"npm install {' '.join(pkg_specs)}")

        # Set environment variables
        if "env_vars" in env_snapshot:
            for k, v in env_snapshot["env_vars"].items():
                self.sandbox.bash(f"export {k}={shlex.quote(v)}")


def classify_error(error: Exception, checkpoint_after: str | None = None) -> RollbackDecision:
    """Classify an error and decide on rollback action."""
    error_msg = str(error).lower()

    # Tool errors (file not found, command failed, permission denied) → usually reversible
    if any(kw in error_msg for kw in ["file not found", "command failed", "permission denied", "no such file"]):
        return RollbackDecision(
            action=RollbackAction.ROLLBACK,
            target_checkpoint=checkpoint_after,
            fix_instruction="Fix the file path or command and retry",
            reason=f"Tool error, likely reversible: {error}",
        )

    # Test failures → reversible
    if "test" in error_msg and ("fail" in error_msg or "error" in error_msg or "assert" in error_msg):
        return RollbackDecision(
            action=RollbackAction.ROLLBACK,
            target_checkpoint=checkpoint_after,
            fix_instruction="Fix failing tests and re-run",
            reason=f"Test failure, reversible: {error}",
        )

    # Timeout → reversible
    if "timeout" in error_msg or "timed out" in error_msg:
        return RollbackDecision(
            action=RollbackAction.ROLLBACK,
            target_checkpoint=checkpoint_after,
            fix_instruction="Increase timeout or split operation into smaller units",
            reason=f"Timeout, reversible: {error}",
        )

    # Network/API errors → sometimes reversible
    if any(kw in error_msg for kw in ["rate limit", "api error", "connection", "network", "dns", "resolve"]):
        return RollbackDecision(
            action=RollbackAction.ROLLBACK,
            target_checkpoint=checkpoint_after,
            fix_instruction="Wait and retry, or check API key/network connectivity",
            reason=f"Network/API error, may be transient: {error}",
        )

    # Resource exhaustion → escalate (needs larger sandbox)
    if any(kw in error_msg for kw in ["memory", "oom", "disk", "space", "cpu", "process limit"]):
        return RollbackDecision(
            action=RollbackAction.ESCALATE,
            target_checkpoint=None,
            fix_instruction=None,
            reason=f"Resource exhaustion, needs larger sandbox or task decomposition: {error}",
        )

    # Agent stuck → could be reversible
    if "stuck" in error_msg or "idle" in error_msg:
        return RollbackDecision(
            action=RollbackAction.ROLLBACK,
            target_checkpoint=checkpoint_after,
            fix_instruction="Restart agent with clearer instructions or split task",
            reason=f"Agent stuck, may be reversible: {error}",
        )

    # Unknown → escalate
    return RollbackDecision(
        action=RollbackAction.ESCALATE,
        target_checkpoint=None,
        fix_instruction=None,
        reason=f"Unknown error, cannot auto-recover: {error}",
    )


def generate_fix_instruction(error: Exception, context: ErrorContext) -> str:
    """Generate a fix instruction based on error and context."""
    error_type = context.error_type
    location = context.location

    base = f"Error at {location}: {error}\n\n"

    if error_type == ErrorType.TEST_FAILURE:
        return base + "The tests failed. Analyze the test output, identify the failing assertions, and fix the implementation. Ensure all tests pass before continuing."
    elif error_type == ErrorType.TOOL_ERROR:
        return base + "A tool command failed. Check the command syntax, file paths, and permissions. Correct the issue and retry the operation."
    elif error_type == ErrorType.TIMEOUT:
        return base + "The operation timed out. Consider breaking the task into smaller steps, increasing the timeout, or optimizing the operation."
    elif error_type == ErrorType.NETWORK:
        return base + "A network error occurred. Verify connectivity, check API endpoints, and retry. Consider adding retry logic with backoff."
    elif error_type == ErrorType.AGENT_STUCK:
        return base + "The agent appears stuck. Provide more specific instructions, break down the task, or clarify the expected outcome."
    else:
        return base + "An unexpected error occurred. Analyze the error message and stack trace, then apply the appropriate fix."