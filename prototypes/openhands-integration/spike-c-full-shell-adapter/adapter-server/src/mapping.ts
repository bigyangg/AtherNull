// The measured artifact of this spike: AtherNull -> OpenHands shape
// translation. Every field here is cross-referenced against
// service-contract.md, which is the authoritative, field-by-field record of
// what maps cleanly, what's a lossy/approximate mapping, and what has no
// AtherNull source at all (stubbed, with an honest placeholder - never a
// fabricated-looking real value). Read that file alongside this one.
//
// Target shapes are transcribed (not imported) from
// spike-a-standalone-shell/upstream/src/api/conversation-service/
// agent-server-conversation-service.types.ts and
// upstream/src/types/agent-server/core/ - reproduced locally because
// upstream/ is a gitignored, unbuilt-as-a-library checkout (see Spike A's
// README: the library build's exports are broken 8/8), so importing from it
// is not a viable option; this keeps the adapter a fully standalone package
// per the spike's isolation rule.
import type { RepoProject, Task, TaskDetail, ExecutionEvent } from "./athernull-types.js";

// --- OpenHands target types (transcribed subset) --------------------------

export type SourceType = "agent" | "user" | "environment" | "hook";

export interface AppConversation {
  id: string;
  created_by_user_id: string | null;
  selected_repository: string | null;
  selected_branch: string | null;
  git_provider: "github" | "gitlab" | "bitbucket" | null;
  title: string | null;
  trigger: string | null;
  pr_number: number[];
  agent_kind: "openhands" | "acp" | null;
  llm_model: string | null;
  metrics: null;
  created_at: string;
  updated_at: string;
  execution_status:
    | "idle"
    | "running"
    | "paused"
    | "waiting_for_confirmation"
    | "finished"
    | "error"
    | "stuck";
  conversation_url: string | null;
  session_api_key: string | null;
  sandbox_id: string | null;
  workspace: { working_dir: string | null } | null;
  sub_conversation_ids: string[];
  public: boolean;
}

export interface AppConversationPage {
  items: AppConversation[];
  next_page_id: string | null;
}

export interface OpenHandsEventBase {
  id: string;
  timestamp: string;
  source: SourceType;
}

export type OpenHandsEvent = OpenHandsEventBase & Record<string, unknown>;

export interface OpenHandsEventPage {
  items: OpenHandsEvent[];
  next_page_id: string | null;
}

// --- TaskStatus -> ExecutionStatus ----------------------------------------

// AtherNull's 16-value task FSM (apps/web/lib/types.ts's TaskStatus) has no
// 1:1 counterpart in OpenHands' 7-value agent ExecutionStatus enum
// (idle/running/paused/waiting_for_confirmation/finished/error/stuck) - one
// is a payment/lifecycle FSM, the other is a live-agent-loop status. This is
// a deliberate many-to-one collapse, documented row-by-row in
// service-contract.md, not a precise translation.
const STATUS_MAP: Record<Task["status"], AppConversation["execution_status"]> = {
  CREATED: "idle",
  AWAITING_FUNDING: "idle",
  FUNDED: "idle",
  QUEUED: "idle",
  RUNNING: "running",
  VERIFYING: "finished",
  AWAITING_ACCEPTANCE: "finished",
  ACCEPTED: "finished",
  SETTLING: "finished",
  SETTLED: "finished",
  FAILED: "error",
  CANCELLED: "error",
  REJECTED: "error",
  DISPUTED: "error",
  REFUNDING: "finished",
  REFUNDED: "finished",
};

export function taskStatusToExecutionStatus(status: Task["status"]): AppConversation["execution_status"] {
  return STATUS_MAP[status] ?? "idle";
}

// --- repository / git provider --------------------------------------------

// AtherNull's permittedRepository is a bare "host/owner/repo" string
// (e.g. "github.com/athernull/example"); OpenHands' selected_repository is
// provider-relative ("owner/repo"). git_provider is inferred from the host
// segment - "unknown" hosts fall back to null (never guessed).
export function splitRepository(permittedRepository: string | null | undefined): {
  selectedRepository: string | null;
  gitProvider: AppConversation["git_provider"];
} {
  if (!permittedRepository) return { selectedRepository: null, gitProvider: null };
  const parts = permittedRepository.split("/");
  if (parts.length < 3) return { selectedRepository: permittedRepository, gitProvider: null };
  const [host, ...rest] = parts;
  const gitProvider: AppConversation["git_provider"] =
    host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host === "bitbucket.org" ? "bitbucket" : null;
  return { selectedRepository: rest.join("/"), gitProvider };
}

// --- Task/TaskDetail -> AppConversation ------------------------------------

export function mapTaskToAppConversation(
  task: Task | TaskDetail,
  project: RepoProject | null,
): AppConversation {
  const { selectedRepository, gitProvider } = splitRepository(project?.permittedRepository ?? null);
  const executions = "executions" in task ? task.executions : [];
  const latestExecution = executions[0] ?? null;

  return {
    id: task.id,
    // AtherNull's Task has no "created by" field on the task row itself
    // (only projects.owner_user_id, one hop away and not fetched here to
    // keep this a single read) - honestly null, not guessed.
    created_by_user_id: null,
    selected_repository: selectedRepository,
    // Closest available analog: AtherNull snapshots a *revision* (commit-ish
    // string, e.g. "abc123"), not a branch name, onto the task at creation
    // (0004_task_reproducibility_snapshot.sql). Surfaced here as-is with
    // this caveat recorded in service-contract.md - it will often just look
    // like a commit sha in the UI, not a real branch.
    selected_branch: task.repositoryRevision || null,
    git_provider: gitProvider,
    title: task.requirements,
    // No equivalent: AtherNull tasks aren't created via a "trigger" concept
    // (resolve/slack/api/etc.) the way OpenHands Cloud conversations are.
    trigger: null,
    pr_number: [],
    // Constant, not derived: every AtherNull execution that ever runs an
    // Agent Server conversation does so via OpenHands (agent_server_adapter.py),
    // never ACP - see internal.ts's /conversation endpoint comment.
    agent_kind: "openhands",
    llm_model: latestExecution?.resolvedModel ?? null,
    // No AtherNull equivalent: MetricsSnapshot (accumulated_cost,
    // token_usage, context_window) is Agent-Server-runtime-only telemetry,
    // never persisted by apps/api. usage_events/budgetSpentMinor exist but
    // are shaped completely differently (a running spend total in minor
    // currency units, not a MetricsSnapshot) - deliberately left null
    // rather than force-fit a shape mismatch.
    metrics: null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    execution_status: taskStatusToExecutionStatus(task.status),
    // Cloud-only sandbox proxy URL - AtherNull never runs a live, browser-
    // reachable sandbox for this read-only spike (SESSION_API_KEY-gated
    // Agent Server containers are worker-process-only, apps/api never
    // proxies to one). Always null.
    conversation_url: null,
    // NEVER populated. This is the one field this adapter is constitutionally
    // forbidden from filling in with anything but null - see the safety
    // rules in ../README.md and ../service-contract.md's dedicated section.
    session_api_key: null,
    // No AtherNull equivalent: AtherNull has no sandbox/container concept in
    // its own API surface (that's entirely inside the worker process).
    sandbox_id: null,
    // No AtherNull equivalent surfaced via the read API used here.
    workspace: null,
    sub_conversation_ids: [],
    public: false,
  };
}

export function mapTasksToAppConversationPage(
  tasks: Task[],
  projectsById: Map<string, RepoProject>,
): AppConversationPage {
  const items = tasks.map((task) => mapTaskToAppConversation(task, projectsById.get(task.projectId) ?? null));
  return { items, next_page_id: null };
}

// --- ExecutionEvent -> OpenHandsEvent --------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Every AtherNull-inserted fixture event in this spike is one of these three
// kinds (see seed/seed.ts, adapted from Spike B's
// execution-events.synthetic.ts). Real Agent-Server-forwarded events could
// in principle carry other OpenHandsEvent union members (CondensationEvent,
// PauseEvent, etc.) - those pass through unmapped (see the final branch
// below): logged and dropped, never fabricated into one of the three known
// shapes.
export function mapExecutionEventToOpenHandsEvent(event: ExecutionEvent): OpenHandsEvent | null {
  if (!isRecord(event.payload)) {
    console.warn(`[mapping] event ${event.id} (kind=${event.kind}) has a non-object payload - dropped`);
    return null;
  }
  const payload = event.payload;

  if (event.kind === "MessageEvent") {
    const source: SourceType = payload.source === "user" ? "user" : "agent";
    return {
      id: event.id,
      timestamp: event.occurredAt,
      source,
      llm_message: payload.llm_message,
      activated_skills: payload.activated_skills ?? [],
      extended_content: payload.extended_content ?? [],
      ...(typeof payload.reasoning_content === "string"
        ? { reasoning_content: payload.reasoning_content }
        : {}),
    };
  }

  if (event.kind === "ActionEvent") {
    return {
      id: event.id,
      timestamp: event.occurredAt,
      source: "agent",
      thought: payload.thought ?? [],
      // Not persisted by AtherNull's fixture content (see service-contract.md's
      // "ActionEvent stubbed fields" row) - real live executions would carry
      // these verbatim from the Agent Server's own event body, since
      // apps/api/src/routes/internal.ts stores whatever the worker forwards
      // unmodified; this spike's own synthetic seed content simply never
      // included them.
      reasoning_content: typeof payload.reasoning_content === "string" ? payload.reasoning_content : null,
      thinking_blocks: [],
      action: payload.action,
      tool_name: typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
      // Stubbed: no real LLM tool-call id exists for fixture-seeded content.
      tool_call_id: `stub-${event.id}`,
      tool_call: { id: `stub-${event.id}`, type: "function", function: { name: String(payload.tool_name ?? "unknown"), arguments: "{}" } },
      llm_response_id: event.id,
      security_risk: "UNKNOWN",
    };
  }

  if (event.kind === "ObservationEvent") {
    const observation = isRecord(payload.observation) ? payload.observation : {};
    const observationKind = typeof observation.kind === "string" ? observation.kind : "";
    const toolName =
      observationKind === "TerminalObservation"
        ? "terminal"
        : observationKind === "FileEditorObservation"
          ? "file_editor"
          : "unknown";
    return {
      id: event.id,
      timestamp: event.occurredAt,
      source: "environment",
      tool_name: toolName,
      // Stubbed: see ActionEvent's tool_call_id note above - paired to the
      // matching action's stub via the same `stub-<action_id>` convention so
      // a consumer that does try to correlate them at least gets a
      // consistent (if fabricated) id rather than two unrelated stubs.
      tool_call_id: typeof payload.action_id === "string" ? `stub-${payload.action_id}` : `stub-${event.id}`,
      observation: payload.observation,
      action_id: payload.action_id,
    };
  }

  console.warn(`[mapping] event ${event.id} has unmapped kind "${event.kind}" - dropped, not fabricated`);
  return null;
}

export function mapExecutionEventsToOpenHandsEventPage(
  events: ExecutionEvent[],
  opts: { limit?: number; sortOrder?: "TIMESTAMP_ASC" | "TIMESTAMP_DESC" } = {},
): OpenHandsEventPage {
  const mapped = events.map(mapExecutionEventToOpenHandsEvent).filter((e): e is OpenHandsEvent => e !== null);
  const sorted = [...mapped].sort((a, b) =>
    opts.sortOrder === "TIMESTAMP_DESC"
      ? b.timestamp.localeCompare(a.timestamp)
      : a.timestamp.localeCompare(b.timestamp),
  );
  const limit = opts.limit ?? sorted.length;
  // No real cursor-based pagination against AtherNull's own `after=` param
  // (jobs.ts's GET .../events accepts it) - this spike's whole seeded
  // history is 9 events, well under any page size, so every request returns
  // everything within `limit` as a single page. Documented in
  // service-contract.md as a known simplification, not attempted to be
  // hidden behind a fake next_page_id.
  return { items: sorted.slice(0, limit), next_page_id: null };
}
