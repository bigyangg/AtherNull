"""
Hierarchical Memory System for AtherNull Worker (Python).

Three-tier memory architecture matching the TypeScript contracts:
1. Project Permanent Memory — overall progress, TODO list, decisions, artifacts
2. Running/Temp Memory — active task, checkpoints, agent assignments, resource usage
3. Per-Agent Memory — agent-specific permanent knowledge + running state

Stored as JSON files in the sandbox volume at:
  /workspace/.athernull/<project-id>/
    ├── memory.json          # ProjectMemory
    ├── running.json         # RunningMemory
    ├── checkpoints/         # Checkpoint files
    ├── threads/             # ThreadMessage files
    └── agents/
        └── <agent-id>/
            ├── memory.json  # AgentMemory (permanent)
            └── running.json # AgentRunningMemory
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any

from coding_agent.worker import log


# ============================================================================
# Enums
# ============================================================================

class ProjectPhaseStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    BLOCKED = "blocked"


class ProjectOverallStatus(str, Enum):
    PLANNING = "PLANNING"
    BUILDING = "BUILDING"
    VERIFYING = "VERIFYING"
    AWAITING_ACCEPTANCE = "AWAITING_ACCEPTANCE"
    SETTLED = "SETTLED"
    REFUNDED = "REFUNDED"
    FAILED = "FAILED"
    ARCHIVED = "ARCHIVED"


class TodoStatus(str, Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    DONE = "done"
    BLOCKED = "blocked"


class AgentAssignmentStatus(str, Enum):
    ASSIGNED = "assigned"
    RUNNING = "running"
    WAITING = "waiting"
    HANDED_OFF = "handed_off"
    DONE = "done"


class OpenIssueType(str, Enum):
    TEST_FAILURE = "test_failure"
    BUILD_ERROR = "build_error"
    VERIFICATION_FAILURE = "verification_failure"
    TIMEOUT = "timeout"
    RESOURCE_EXHAUSTED = "resource_exhausted"
    BLOCKED = "blocked"
    OTHER = "other"


class OpenIssueStatus(str, Enum):
    OPEN = "open"
    RESOLVED = "resolved"
    ESCALATED = "escalated"


class AgentRole(str, Enum):
    COORDINATOR = "coordinator"
    PLANNER = "planner"
    IMPLEMENTER = "implementer"
    FIXER = "fixer"
    REVIEWER = "reviewer"
    RESEARCHER = "researcher"
    VERIFIER = "verifier"


class AgentCapability(str, Enum):
    TERMINAL = "terminal"
    FILE_EDITOR = "file_editor"
    TASK_TRACKER = "task_tracker"
    GIT = "git"
    WEB_SEARCH = "web_search"
    CODE_SEARCH = "code_search"
    BROWSER = "browser"
    DATABASE = "database"


class ThreadType(str, Enum):
    PLANNING = "planning"
    BUILD = "build"
    FIX = "fix"
    REVIEW = "review"
    DISCUSSION = "discussion"


class ThreadStatus(str, Enum):
    OPEN = "open"
    RESOLVED = "resolved"
    ARCHIVED = "archived"


class CheckpointLabel(str, Enum):
    BASELINE = "baseline"
    MILESTONE = "milestone"
    PRE_RISK = "pre_risk"
    PRE_FAILURE = "pre_failure"
    MANUAL = "manual"
    HANDOFF = "handoff"


class ErrorType(str, Enum):
    TEST_FAILURE = "test_failure"
    TIMEOUT = "timeout"
    AGENT_STUCK = "agent_stuck"
    TOOL_ERROR = "tool_error"
    NETWORK = "network"
    RESOURCE_EXHAUSTED = "resource_exhausted"
    UNKNOWN = "unknown"


class RollbackAction(str, Enum):
    ROLLBACK = "rollback"
    ESCALATE = "escalate"
    RETRY_SAME = "retry_same"


# ============================================================================
# Data Classes
# ============================================================================

@dataclass
class ProjectPhase:
    status: ProjectPhaseStatus = ProjectPhaseStatus.PENDING
    thread_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProjectPhase:
        return cls(
            status=ProjectPhaseStatus(data.get("status", "pending")),
            thread_id=data.get("thread_id"),
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
        )


@dataclass
class ProjectPhases:
    planning: ProjectPhase = field(default_factory=ProjectPhase)
    implementation: ProjectPhase = field(default_factory=ProjectPhase)
    verification: ProjectPhase = field(default_factory=ProjectPhase)
    acceptance: ProjectPhase = field(default_factory=ProjectPhase)

    def to_dict(self) -> dict[str, Any]:
        return {k: v.to_dict() for k, v in asdict(self).items()}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProjectPhases:
        return cls(
            planning=ProjectPhase.from_dict(data.get("planning", {})),
            implementation=ProjectPhase.from_dict(data.get("implementation", {})),
            verification=ProjectPhase.from_dict(data.get("verification", {})),
            acceptance=ProjectPhase.from_dict(data.get("acceptance", {})),
        )


@dataclass
class TodoItem:
    id: str
    title: str
    status: TodoStatus = TodoStatus.PENDING
    deliverable: str | None = None
    assignee: str | None = None
    depends_on: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TodoItem:
        return cls(
            id=data["id"],
            title=data["title"],
            status=TodoStatus(data.get("status", "pending")),
            deliverable=data.get("deliverable"),
            assignee=data.get("assignee"),
            depends_on=data.get("depends_on", []),
        )


@dataclass
class Decision:
    id: str
    question: str
    decision: str
    rationale: str | None = None
    thread_ref: str | None = None
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Decision:
        return cls(
            id=data["id"],
            question=data["question"],
            decision=data["decision"],
            rationale=data.get("rationale"),
            thread_ref=data.get("thread_ref"),
            timestamp=data.get("timestamp", datetime.now(UTC).isoformat()),
        )


@dataclass
class ProjectArtifacts:
    repo_url: str | None = None
    deploy_url: str | None = None
    live_preview: str | None = None
    final_commit: str | None = None
    build_logs: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProjectArtifacts:
        return cls(
            repo_url=data.get("repo_url"),
            deploy_url=data.get("deploy_url"),
            live_preview=data.get("live_preview"),
            final_commit=data.get("final_commit"),
            build_logs=data.get("build_logs"),
        )


@dataclass
class ProjectMemory:
    project_id: str
    name: str
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    owner: str = ""
    overall_status: ProjectOverallStatus = ProjectOverallStatus.PLANNING
    phases: ProjectPhases = field(default_factory=ProjectPhases)
    todo_list: list[TodoItem] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    artifacts: ProjectArtifacts = field(default_factory=ProjectArtifacts)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "name": self.name,
            "created_at": self.created_at,
            "owner": self.owner,
            "overall_status": self.overall_status.value,
            "phases": self.phases.to_dict(),
            "todo_list": [t.to_dict() for t in self.todo_list],
            "decisions": [d.to_dict() for d in self.decisions],
            "artifacts": self.artifacts.to_dict(),
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ProjectMemory:
        return cls(
            project_id=data["project_id"],
            name=data["name"],
            created_at=data.get("created_at", datetime.now(UTC).isoformat()),
            owner=data.get("owner", ""),
            overall_status=ProjectOverallStatus(data.get("overall_status", "PLANNING")),
            phases=ProjectPhases.from_dict(data.get("phases", {})),
            todo_list=[TodoItem.from_dict(t) for t in data.get("todo_list", [])],
            decisions=[Decision.from_dict(d) for d in data.get("decisions", [])],
            artifacts=ProjectArtifacts.from_dict(data.get("artifacts", {})),
            metadata=data.get("metadata", {}),
        )

    def add_todo(self, title: str, deliverable: str | None = None, assignee: str | None = None) -> TodoItem:
        todo = TodoItem(id=str(uuid.uuid4())[:8], title=title, deliverable=deliverable, assignee=assignee)
        self.todo_list.append(todo)
        return todo

    def update_todo(self, todo_id: str, status: TodoStatus | None = None, **kwargs) -> bool:
        for todo in self.todo_list:
            if todo.id == todo_id:
                if status:
                    todo.status = status
                for k, v in kwargs.items():
                    if hasattr(todo, k):
                        setattr(todo, k, v)
                return True
        return False

    def add_decision(self, question: str, decision: str, rationale: str | None = None, thread_ref: str | None = None) -> Decision:
        dec = Decision(id=str(uuid.uuid4())[:8], question=question, decision=decision, rationale=rationale, thread_ref=thread_ref)
        self.decisions.append(dec)
        return dec


@dataclass
class AgentAssignment:
    task: str
    status: AgentAssignmentStatus = AgentAssignmentStatus.ASSIGNED
    started_at: str | None = None
    checkpoint_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentAssignment:
        return cls(
            task=data["task"],
            status=AgentAssignmentStatus(data.get("status", "assigned")),
            started_at=data.get("started_at"),
            checkpoint_id=data.get("checkpoint_id"),
        )


@dataclass
class OpenIssue:
    id: str
    type: OpenIssueType
    thread_ref: str | None = None
    status: OpenIssueStatus = OpenIssueStatus.OPEN
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    resolved_at: str | None = None
    resolution: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> OpenIssue:
        return cls(
            id=data["id"],
            type=OpenIssueType(data["type"]),
            thread_ref=data.get("thread_ref"),
            status=OpenIssueStatus(data.get("status", "open")),
            created_at=data.get("created_at", datetime.now(UTC).isoformat()),
            resolved_at=data.get("resolved_at"),
            resolution=data.get("resolution"),
        )


@dataclass
class ResourceUsage:
    tokens_used: int = 0
    wall_time_sec: int = 0
    checkpoints_created: int = 0
    rollbacks_performed: int = 0
    api_calls: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ResourceUsage:
        return cls(**data)


@dataclass
class RunningMemory:
    active_task_id: str | None = None
    active_thread_id: str | None = None
    current_checkpoint: str | None = None
    checkpoint_history: list[str] = field(default_factory=list)
    agent_assignments: dict[str, AgentAssignment] = field(default_factory=dict)
    open_issues: list[OpenIssue] = field(default_factory=list)
    resource_usage: ResourceUsage = field(default_factory=ResourceUsage)
    last_sync_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "active_task_id": self.active_task_id,
            "active_thread_id": self.active_thread_id,
            "current_checkpoint": self.current_checkpoint,
            "checkpoint_history": self.checkpoint_history,
            "agent_assignments": {k: v.to_dict() for k, v in self.agent_assignments.items()},
            "open_issues": [i.to_dict() for i in self.open_issues],
            "resource_usage": self.resource_usage.to_dict(),
            "last_sync_at": self.last_sync_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RunningMemory:
        return cls(
            active_task_id=data.get("active_task_id"),
            active_thread_id=data.get("active_thread_id"),
            current_checkpoint=data.get("current_checkpoint"),
            checkpoint_history=data.get("checkpoint_history", []),
            agent_assignments={k: AgentAssignment.from_dict(v) for k, v in data.get("agent_assignments", {}).items()},
            open_issues=[OpenIssue.from_dict(i) for i in data.get("open_issues", [])],
            resource_usage=ResourceUsage.from_dict(data.get("resource_usage", {})),
            last_sync_at=data.get("last_sync_at", datetime.now(UTC).isoformat()),
        )


@dataclass
class AgentPermanentKnowledge:
    project_conventions: str = ""
    code_style: str = ""
    known_gotchas: list[str] = field(default_factory=list)
    domain_knowledge: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentPermanentKnowledge:
        return cls(**data)


@dataclass
class AgentRunningState:
    current_subtask: str | None = None
    working_files: list[str] = field(default_factory=list)
    blockers: list[str] = field(default_factory=list)
    recent_decisions: list[str] = field(default_factory=list)
    last_heartbeat: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentRunningState:
        return cls(**data)


@dataclass
class AgentInteractionLogEntry:
    timestamp: str
    type: str  # user_instruction, tool_result, decision, error, handoff
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentInteractionLogEntry:
        return cls(**data)


@dataclass
class AgentMemory:
    agent_id: str
    role: AgentRole
    capabilities: list[AgentCapability]
    permanent_knowledge: AgentPermanentKnowledge = field(default_factory=AgentPermanentKnowledge)
    running_state: AgentRunningState = field(default_factory=AgentRunningState)
    interaction_log: list[AgentInteractionLogEntry] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "role": self.role.value,
            "capabilities": [c.value for c in self.capabilities],
            "permanent_knowledge": self.permanent_knowledge.to_dict(),
            "running_state": self.running_state.to_dict(),
            "interaction_log": [e.to_dict() for e in self.interaction_log],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> AgentMemory:
        return cls(
            agent_id=data["agent_id"],
            role=AgentRole(data["role"]),
            capabilities=[AgentCapability(c) for c in data.get("capabilities", [])],
            permanent_knowledge=AgentPermanentKnowledge.from_dict(data.get("permanent_knowledge", {})),
            running_state=AgentRunningState.from_dict(data.get("running_state", {})),
            interaction_log=[AgentInteractionLogEntry.from_dict(e) for e in data.get("interaction_log", [])],
            created_at=data.get("created_at", datetime.now(UTC).isoformat()),
            updated_at=data.get("updated_at", datetime.now(UTC).isoformat()),
        )

    def log_interaction(self, type: str, content: str, metadata: dict[str, Any] | None = None) -> None:
        self.interaction_log.append(AgentInteractionLogEntry(
            timestamp=datetime.now(UTC).isoformat(),
            type=type,
            content=content,
            metadata=metadata or {},
        ))
        self.updated_at = datetime.now(UTC).isoformat()


@dataclass
class ThreadContextPointers:
    task_id: str
    checkpoint_id: str | None = None
    execution_id: str | None = None
    related_threads: list[str] = field(default_factory=list)
    parent_thread_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ThreadContextPointers:
        return cls(**data)


@dataclass
class ThreadMessage:
    id: str
    thread_id: str
    role: str  # user, assistant, system, tool
    content: str
    metadata: dict[str, Any] | None = None
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ThreadMessage:
        return cls(**data)


@dataclass
class ThreadMeta:
    id: str
    project_id: str
    task_id: str
    type: ThreadType
    status: ThreadStatus = ThreadStatus.OPEN
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    created_by: str = ""
    parent_thread_id: str | None = None
    context_pointers: ThreadContextPointers | None = None
    message_count: int = 0
    last_message_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ThreadMeta:
        cp = data.get("context_pointers")
        return cls(
            id=data["id"],
            project_id=data["project_id"],
            task_id=data["task_id"],
            type=ThreadType(data["type"]),
            status=ThreadStatus(data.get("status", "open")),
            created_at=data.get("created_at", datetime.now(UTC).isoformat()),
            updated_at=data.get("updated_at", datetime.now(UTC).isoformat()),
            created_by=data.get("created_by", ""),
            parent_thread_id=data.get("parent_thread_id"),
            context_pointers=ThreadContextPointers.from_dict(cp) if cp else None,
            message_count=data.get("message_count", 0),
            last_message_at=data.get("last_message_at"),
        )


@dataclass
class Checkpoint:
    id: str
    label: CheckpointLabel
    reason: str
    git_commit: str
    conversation_state: dict[str, Any]
    environment: dict[str, Any]
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    parent_checkpoint: str | None = None
    task_id: str = ""
    execution_id: str = ""
    project_id: str = ""
    files_changed: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Checkpoint:
        return cls(**data)


@dataclass
class CheckpointIndex:
    project_id: str
    task_id: str
    checkpoints: list[dict[str, Any]] = field(default_factory=list)  # simplified for index
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CheckpointIndex:
        return cls(**data)


@dataclass
class ErrorContext:
    error_type: ErrorType
    location: str
    checkpoint_after: str | None = None
    reversible: bool = False
    fix_strategy: str | None = None
    error_message: str = ""
    stack_trace: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ErrorContext:
        return cls(**data)


@dataclass
class RollbackDecision:
    action: RollbackAction
    target_checkpoint: str | None = None
    fix_instruction: str | None = None
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RollbackDecision:
        return cls(**data)


@dataclass
class RollbackResult:
    success: bool
    new_conversation_id: str | None = None
    checkpoint: Checkpoint | None = None
    files_restored: list[str] = field(default_factory=list)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "new_conversation_id": self.new_conversation_id,
            "checkpoint": self.checkpoint.to_dict() if self.checkpoint else None,
            "files_restored": self.files_restored,
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RollbackResult:
        cp = data.get("checkpoint")
        return cls(
            success=data["success"],
            new_conversation_id=data.get("new_conversation_id"),
            checkpoint=Checkpoint.from_dict(cp) if cp else None,
            files_restored=data.get("files_restored", []),
            error=data.get("error"),
        )


# ============================================================================
# Memory Manager
# ============================================================================

class MemoryManager:
    """Manages reading/writing memory files to the sandbox volume."""

    def __init__(self, project_id: str, base_path: str = "/workspace/.athernull"):
        self.project_id = project_id
        self.base_path = Path(base_path) / project_id
        self.base_path.mkdir(parents=True, exist_ok=True)
        (self.base_path / "checkpoints").mkdir(exist_ok=True)
        (self.base_path / "threads").mkdir(exist_ok=True)
        (self.base_path / "agents").mkdir(exist_ok=True)

    # --- Project Memory ---

    def get_project_memory_path(self) -> Path:
        return self.base_path / "memory.json"

    def load_project_memory(self) -> ProjectMemory | None:
        path = self.get_project_memory_path()
        if not path.exists():
            return None
        try:
            with open(path) as f:
                return ProjectMemory.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load project memory: {e}")
            return None

    def save_project_memory(self, memory: ProjectMemory) -> None:
        path = self.get_project_memory_path()
        try:
            with open(path, "w") as f:
                json.dump(memory.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to save project memory: {e}")
            raise

    def create_project_memory(self, project_id: str, name: str, owner: str) -> ProjectMemory:
        memory = ProjectMemory(project_id=project_id, name=name, owner=owner)
        self.save_project_memory(memory)
        return memory

    # --- Running Memory ---

    def get_running_memory_path(self) -> Path:
        return self.base_path / "running.json"

    def load_running_memory(self) -> RunningMemory:
        path = self.get_running_memory_path()
        if not path.exists():
            return RunningMemory()
        try:
            with open(path) as f:
                return RunningMemory.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load running memory: {e}")
            return RunningMemory()

    def save_running_memory(self, memory: RunningMemory) -> None:
        memory.last_sync_at = datetime.now(UTC).isoformat()
        path = self.get_running_memory_path()
        try:
            with open(path, "w") as f:
                json.dump(memory.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to save running memory: {e}")
            raise

    # --- Agent Memory ---

    def get_agent_dir(self, agent_id: str) -> Path:
        path = self.base_path / "agents" / agent_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_agent_memory_path(self, agent_id: str) -> Path:
        return self.get_agent_dir(agent_id) / "memory.json"

    def get_agent_running_path(self, agent_id: str) -> Path:
        return self.get_agent_dir(agent_id) / "running.json"

    def load_agent_memory(self, agent_id: str) -> AgentMemory | None:
        path = self.get_agent_memory_path(agent_id)
        if not path.exists():
            return None
        try:
            with open(path) as f:
                return AgentMemory.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load agent memory for {agent_id}: {e}")
            return None

    def save_agent_memory(self, memory: AgentMemory) -> None:
        memory.updated_at = datetime.now(UTC).isoformat()
        path = self.get_agent_memory_path(memory.agent_id)
        try:
            with open(path, "w") as f:
                json.dump(memory.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to save agent memory for {memory.agent_id}: {e}")
            raise

    def load_agent_running(self, agent_id: str) -> AgentRunningState:
        path = self.get_agent_running_path(agent_id)
        if not path.exists():
            return AgentRunningState()
        try:
            with open(path) as f:
                return AgentRunningState.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load agent running for {agent_id}: {e}")
            return AgentRunningState()

    def save_agent_running(self, agent_id: str, running: AgentRunningState) -> None:
        path = self.get_agent_running_path(agent_id)
        try:
            with open(path, "w") as f:
                json.dump(running.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to save agent running for {agent_id}: {e}")
            raise

    # --- Threads ---

    def get_thread_dir(self, thread_id: str) -> Path:
        path = self.base_path / "threads" / thread_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_thread_meta_path(self, thread_id: str) -> Path:
        return self.get_thread_dir(thread_id) / "meta.json"

    def get_thread_messages_path(self, thread_id: str) -> Path:
        return self.get_thread_dir(thread_id) / "messages.jsonl"

    def load_thread_meta(self, thread_id: str) -> ThreadMeta | None:
        path = self.get_thread_meta_path(thread_id)
        if not path.exists():
            return None
        try:
            with open(path) as f:
                return ThreadMeta.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load thread meta for {thread_id}: {e}")
            return None

    def save_thread_meta(self, meta: ThreadMeta) -> None:
        meta.updated_at = datetime.now(UTC).isoformat()
        path = self.get_thread_meta_path(meta.id)
        try:
            with open(path, "w") as f:
                json.dump(meta.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to save thread meta for {meta.id}: {e}")
            raise

    def append_thread_message(self, thread_id: str, message: ThreadMessage) -> None:
        path = self.get_thread_messages_path(thread_id)
        try:
            with open(path, "a") as f:
                f.write(json.dumps(message.to_dict()) + "\n")
        except Exception as e:
            log(f"Failed to append message to thread {thread_id}: {e}")
            raise

    def load_thread_messages(self, thread_id: str, limit: int | None = None) -> list[ThreadMessage]:
        path = self.get_thread_messages_path(thread_id)
        if not path.exists():
            return []
        try:
            messages = []
            with open(path) as f:
                for line in f:
                    if line.strip():
                        messages.append(ThreadMessage.from_dict(json.loads(line)))
            if limit:
                return messages[-limit:]
            return messages
        except Exception as e:
            log(f"Failed to load thread messages for {thread_id}: {e}")
            return []

    def create_thread(
        self,
        project_id: str,
        task_id: str,
        type: ThreadType,
        created_by: str,
        parent_thread_id: str | None = None,
        context_pointers: ThreadContextPointers | None = None,
        initial_message: ThreadMessage | None = None,
    ) -> ThreadMeta:
        thread_id = f"{type.value}-{str(uuid.uuid4())[:8]}"
        meta = ThreadMeta(
            id=thread_id,
            project_id=project_id,
            task_id=task_id,
            type=type,
            created_by=created_by,
            parent_thread_id=parent_thread_id,
            context_pointers=context_pointers,
        )
        self.save_thread_meta(meta)
        if initial_message:
            initial_message.thread_id = thread_id
            self.append_thread_message(thread_id, initial_message)
            meta.message_count = 1
            meta.last_message_at = initial_message.created_at
            self.save_thread_meta(meta)
        return meta

    def list_threads(self, project_id: str, task_id: str | None = None) -> list[ThreadMeta]:
        threads_dir = self.base_path / "threads"
        if not threads_dir.exists():
            return []
        threads = []
        for thread_dir in threads_dir.iterdir():
            if thread_dir.is_dir():
                meta = self.load_thread_meta(thread_dir.name)
                if meta and meta.project_id == project_id and (task_id is None or meta.task_id == task_id):
                    threads.append(meta)
        return threads

    # --- Checkpoints ---

    def get_checkpoint_path(self, checkpoint_id: str) -> Path:
        return self.base_path / "checkpoints" / f"{checkpoint_id}.json"

    def get_checkpoint_index_path(self) -> Path:
        return self.base_path / "checkpoints" / "index.json"

    def load_checkpoint(self, checkpoint_id: str) -> Checkpoint | None:
        path = self.get_checkpoint_path(checkpoint_id)
        if not path.exists():
            return None
        try:
            with open(path) as f:
                return Checkpoint.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load checkpoint {checkpoint_id}: {e}")
            return None

    def save_checkpoint(self, checkpoint: Checkpoint) -> None:
        path = self.get_checkpoint_path(checkpoint.id)
        try:
            with open(path, "w") as f:
                json.dump(checkpoint.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to save checkpoint {checkpoint.id}: {e}")
            raise
        # Update index
        self._update_checkpoint_index(checkpoint)

    def _update_checkpoint_index(self, checkpoint: Checkpoint) -> None:
        index_path = self.get_checkpoint_index_path()
        try:
            if index_path.exists():
                with open(index_path) as f:
                    index = CheckpointIndex.from_dict(json.load(f))
            else:
                index = CheckpointIndex(project_id=self.project_id, task_id=checkpoint.task_id)

            # Remove existing entry with same ID
            index.checkpoints = [c for c in index.checkpoints if c.get("id") != checkpoint.id]

            # Add new entry
            index.checkpoints.append({
                "id": checkpoint.id,
                "label": checkpoint.label.value,
                "reason": checkpoint.reason,
                "timestamp": checkpoint.timestamp,
                "git_commit": checkpoint.git_commit,
            })
            index.updated_at = datetime.now(UTC).isoformat()

            with open(index_path, "w") as f:
                json.dump(index.to_dict(), f, indent=2)
        except Exception as e:
            log(f"Failed to update checkpoint index: {e}")

    def load_checkpoint_index(self) -> CheckpointIndex:
        path = self.get_checkpoint_index_path()
        if not path.exists():
            return CheckpointIndex(project_id=self.project_id, task_id="")
        try:
            with open(path) as f:
                return CheckpointIndex.from_dict(json.load(f))
        except Exception as e:
            log(f"Failed to load checkpoint index: {e}")
            return CheckpointIndex(project_id=self.project_id, task_id="")

    def list_checkpoints(self, task_id: str | None = None) -> list[dict[str, Any]]:
        index = self.load_checkpoint_index()
        if task_id:
            # Filter would need to check task_id in full checkpoint
            return index.checkpoints
        return index.checkpoints


# ============================================================================
# Convenience Functions
# ============================================================================

def get_memory_manager(project_id: str, base_path: str = "/workspace/.athernull") -> MemoryManager:
    """Get or create a MemoryManager for a project."""
    return MemoryManager(project_id, base_path)


def ensure_project_memory(
    project_id: str,
    name: str,
    owner: str,
    base_path: str = "/workspace/.athernull",
) -> ProjectMemory:
    """Ensure project memory exists, create if not."""
    mgr = get_memory_manager(project_id, base_path)
    memory = mgr.load_project_memory()
    if memory is None:
        memory = mgr.create_project_memory(project_id, name, owner)
    return memory