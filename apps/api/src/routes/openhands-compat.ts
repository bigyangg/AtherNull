// Production OpenHands-compatible read surface (Phase 2 of the OpenHands
// workspace integration — see docs/adr/0006-openhands-workspace-frontend.md
// and docs/openhands-workspace-integration-phase1-design.md). This file
// implements the 7 "Required" endpoints from the Phase 1 design doc's
// endpoint matrix, plus GET /api/conversations/:id (singular) — added after
// live-frontend verification showed the pinned OpenHands frontend does call
// it once during conversation-detail navigation, contradicting this phase's
// original evidence that only the batch endpoint was used — as real,
// authenticated, tenant-scoped apps/api routes — distinct from (and not
// reusing any code from) the isolated prototype under
// prototypes/openhands-integration/, which took auth/tenancy shortcuts this
// file must not repeat.
//
// --- The resolver (resolveConversationTarget) ------------------------------
//
// OpenHands' frontend addresses a "conversation" by a single opaque id
// (`:id` in /api/conversations/:id/events/..., or `ids[]=` in the batch GET
// /api/conversations). AtherNull has two candidate identifiers for the same
// underlying work: a TASK id (the durable job) and an EXECUTION's own
// `conversation_id` (the OpenHands Agent Server's own conversation id,
// stamped onto `executions.conversation_id` once the coding-agent worker's
// agent_server_adapter.py creates the conversation — see
// 0006_execution_conversation_id.sql). resolveConversationTarget() below
// tries the requested id as a `conversation_id` FIRST, via a real, indexed,
// org-scoped join (`executions` inner-joined to `tasks`, filtered on
// `tasks.organization_id`) — never a linear/in-process scan. Only if that
// join finds no row does it fall back to treating the requested id as a task
// id (the exact org-scoped `tasks` lookup pattern jobs.ts repeats 5x),
// taking that task's most recent execution (or `null`, if the task has no
// executions yet — an explicit, distinct "not started" outcome, never
// conflated with "not found"/"wrong org"). Every call site logs which
// resolution path fired (`resolutionMethod`), so fallback usage is
// server-side observable per the Phase 1 contract.
//
// A `requestedId` that matches no task in the caller's own organization —
// whether it genuinely doesn't exist anywhere, or exists but belongs to a
// different organization — resolves to the same `null` outcome. This is
// deliberate: the route layer must not let a cross-org probe distinguish
// "not found" from "found, but not yours."
//
// TODO(conversation_id invariant): the Phase 1 design doc's duplicate
// preflight found zero duplicate, non-null `executions.conversation_id`
// values in current dev/test data (no production DB exists yet), but that
// invariant is currently enforced by nothing at the database level — no
// unique index exists on `executions.conversation_id`. The proposed fix is a
// partial unique index (`WHERE conversation_id IS NOT NULL`), documented but
// deliberately NOT created as a migration in this phase (see the phase plan,
// "conversation_id invariant (documented, not migrated)"). The `.orderBy /
// .limit(1)`-free `executeTakeFirst()` below on the conversation_id lookup
// silently picks an arbitrary match if that invariant is ever violated —
// the next person to touch this code should create that index rather than
// add ordering here to paper over a duplicate.
//
// --- Tags / status grammar --------------------------------------------------
//
// `AppConversation.tags` is populated via
// `@athernull/contracts`' serializeAtherNullTags(taskStatus, verificationOutcome)
// — the strict `athernull:task-status:*` / `athernull:verification:*` grammar
// documented in packages/contracts/src/openhands-compat.ts and the design
// doc's §4 "Exact typed status/verification transport". The verification
// outcome used here is always the LATEST verification_runs row for the
// SPECIFIC execution being mapped (matched by `verification_runs.execution_id`),
// mirroring the prototype's buildStatusTags() — never "the task's latest run
// regardless of which execution it was for."
//
// --- session_api_key --------------------------------------------------------
//
// `AppConversation.session_api_key` is ALWAYS `null` from this route layer —
// this file never reads, forwards, or has access to a real Agent Server's
// session_api_key (that value lives only inside the coding-agent worker
// process, per agent_server_adapter.py's own credential handling; apps/api
// never sees it). Do not "fix" this to a real value without re-reading the
// Phase 1 design doc's dedicated safety section on this field first.
//
// --- Never ------------------------------------------------------------------
//
// This file never reads/references SESSION_API_KEY, never calls anything
// under /internal/*, and never accepts `organizationId` from any
// client-supplied field — every business-data route below starts with
// `const { organizationId } = await requireOrgSession(request);`, exactly
// like every other route in this package.

import {
  AppConversationPageSchema,
  AppConversationSchema,
  OpenHandsEventPageSchema,
  OpenHandsExecutionStatusSchema,
  OpenHandsServerInfoResponseSchema,
  OpenHandsSettingsResponseSchema,
  PatchOpenHandsSettingsRequestSchema,
  serializeAtherNullTags,
  type AppConversation,
  type AtherNullVerificationOutcome,
  type OpenHandsEvent,
  type OpenHandsGitProvider,
  type TaskStatus,
} from "@athernull/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { db } from "../db.js";
import { requireOrgSession, sendHttpError } from "../session.js";

// --- Field-mapping helpers (logic ported from, not copy-pasted verbatim out
// of, prototypes/openhands-integration/spike-c-full-shell-adapter/adapter-server/
// src/mapping.ts — that file is read-only reference for this phase, never
// imported) ------------------------------------------------------------------

// AtherNull's 16-value task FSM (packages/contracts/src/tasks.ts) has no 1:1
// counterpart in OpenHands' 7-value agent execution_status enum — a
// deliberate many-to-one collapse, not a precise translation. See the
// prototype's mapping.ts / service-contract.md for the same table with its
// original row-by-row rationale.
const TASK_STATUS_TO_EXECUTION_STATUS: Record<TaskStatus, z.infer<typeof OpenHandsExecutionStatusSchema>> = {
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

function taskStatusToExecutionStatus(status: TaskStatus): z.infer<typeof OpenHandsExecutionStatusSchema> {
  return TASK_STATUS_TO_EXECUTION_STATUS[status] ?? "idle";
}

// AtherNull's permittedRepository is a bare "host/owner/repo" string;
// OpenHands' selected_repository is provider-relative ("owner/repo"). An
// unrecognized host falls back to a null git_provider, never guessed.
function splitRepository(permittedRepository: string | null | undefined): {
  selectedRepository: string | null;
  gitProvider: OpenHandsGitProvider | null;
} {
  if (!permittedRepository) return { selectedRepository: null, gitProvider: null };
  const parts = permittedRepository.split("/");
  if (parts.length < 3) return { selectedRepository: permittedRepository, gitProvider: null };
  const [host, ...rest] = parts;
  const gitProvider: OpenHandsGitProvider | null =
    host === "github.com"
      ? "github"
      : host === "gitlab.com"
        ? "gitlab"
        : host === "bitbucket.org"
          ? "bitbucket"
          : null;
  return { selectedRepository: rest.join("/"), gitProvider };
}

// Every id this codebase generates for `tasks`/`executions` is a Postgres
// `uuid` column value (see packages/database/schema.ts's `Generated<string>`
// id fields) — used to pre-filter the task-id fallback lookup below so an
// opaque, non-UUID requestedId (a real conversation_id that matched no
// execution) fails fast as "not found" instead of a raw driver-level cast
// error.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TaskRow = Awaited<ReturnType<typeof loadOrgTask>>;
type ExecutionRow = NonNullable<Awaited<ReturnType<typeof loadExecutionById>>>;

async function loadOrgTask(taskId: string, organizationId: string) {
  return db
    .selectFrom("tasks")
    .selectAll()
    .where("id", "=", taskId)
    .where("organization_id", "=", organizationId)
    .executeTakeFirst();
}

async function loadExecutionById(executionId: string) {
  return db.selectFrom("executions").selectAll().where("id", "=", executionId).executeTakeFirst();
}

export type ConversationResolution = {
  task: NonNullable<TaskRow>;
  execution: ExecutionRow | null;
  resolutionMethod: "conversation_id" | "task_id_fallback";
};

// See this file's header comment for the full resolution contract.
export async function resolveConversationTarget(
  requestedId: string,
  organizationId: string,
): Promise<ConversationResolution | null> {
  // Try requestedId as an execution's own conversation_id first — a real,
  // indexed, org-scoped join, never a linear scan. See the TODO above about
  // the not-yet-created partial unique index on conversation_id.
  const byConversationId = await db
    .selectFrom("executions")
    .innerJoin("tasks", "tasks.id", "executions.task_id")
    .select(["executions.id as executionId", "tasks.id as taskId"])
    .where("executions.conversation_id", "=", requestedId)
    .where("tasks.organization_id", "=", organizationId)
    .executeTakeFirst();

  if (byConversationId) {
    const [task, execution] = await Promise.all([
      loadOrgTask(byConversationId.taskId, organizationId),
      loadExecutionById(byConversationId.executionId),
    ]);
    if (!task || !execution) {
      // Should not happen (the join just proved both rows exist) short of a
      // concurrent delete between queries — treat as unresolved rather than
      // throwing.
      return null;
    }
    return { task, execution, resolutionMethod: "conversation_id" };
  }

  // Fallback: treat requestedId as a task id, org-scoped (same pattern as
  // jobs.ts's loadOwnedTask). `tasks.id` is a uuid column — a requestedId
  // that isn't UUID-shaped (a real, opaque OpenHands conversation_id that
  // simply matched no execution above, e.g. a live Agent Server's own id
  // format) must resolve to "not found," not a raw Postgres 22P02
  // (invalid input syntax for type uuid) surfacing as an uncaught 500. This
  // check is a pre-filter, not a security boundary — the query below is
  // still org-scoped regardless.
  if (!UUID_PATTERN.test(requestedId)) return null;
  const task = await loadOrgTask(requestedId, organizationId);
  if (!task) return null;

  const execution = await db
    .selectFrom("executions")
    .selectAll()
    .where("task_id", "=", task.id)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();

  return { task, execution: execution ?? null, resolutionMethod: "task_id_fallback" };
}

async function loadLatestVerificationOutcome(executionId: string): Promise<AtherNullVerificationOutcome | null> {
  const run = await db
    .selectFrom("verification_runs")
    .select(["outcome"])
    .where("execution_id", "=", executionId)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return run?.outcome === "PASS" || run?.outcome === "FAIL" ? run.outcome : null;
}

async function loadProjectRepository(projectId: string): Promise<string | null> {
  const project = await db
    .selectFrom("projects")
    .select(["permitted_repository"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  return project?.permitted_repository ?? null;
}

// One AtherNull EXECUTION maps to one AppConversation, keyed on
// `execution.conversationId ?? execution.id` (mirrors the prototype's Spike F
// mapExecutionToAppConversation — lets a real OpenHands sidebar list every
// retry attempt as its own card). A task with no executions yet maps to one
// task-keyed AppConversation instead (`execution: null` branch), matching
// resolveConversationTarget's own "not started" outcome.
async function buildAppConversation(task: NonNullable<TaskRow>, execution: ExecutionRow | null): Promise<AppConversation> {
  const permittedRepository = await loadProjectRepository(task.project_id);
  const { selectedRepository, gitProvider } = splitRepository(permittedRepository);
  const taskStatus = task.status as TaskStatus;

  if (!execution) {
    return {
      id: task.id,
      created_by_user_id: null,
      selected_repository: selectedRepository,
      selected_branch: task.repository_revision || null,
      git_provider: gitProvider,
      title: task.requirements,
      trigger: null,
      pr_number: [],
      agent_kind: "openhands",
      tags: serializeAtherNullTags(taskStatus, null),
      llm_model: null,
      metrics: null,
      created_at: task.created_at.toISOString(),
      updated_at: task.updated_at.toISOString(),
      execution_status: taskStatusToExecutionStatus(taskStatus),
      conversation_url: null,
      // Always null from this route layer — see this file's header comment.
      session_api_key: null,
      sandbox_id: null,
      workspace: null,
      sub_conversation_ids: [],
      public: false,
    };
  }

  const [siblings, verificationOutcome] = await Promise.all([
    db
      .selectFrom("executions")
      .select(["id", "created_at"])
      .where("task_id", "=", task.id)
      .orderBy("created_at", "asc")
      .execute(),
    loadLatestVerificationOutcome(execution.id),
  ]);
  const attemptCount = siblings.length;
  const attemptIndex = siblings.findIndex((s) => s.id === execution.id);
  const attemptNumber = attemptIndex === -1 ? attemptCount : attemptIndex + 1;

  return {
    id: execution.conversation_id ?? execution.id,
    created_by_user_id: null,
    selected_repository: selectedRepository,
    selected_branch: task.repository_revision || null,
    git_provider: gitProvider,
    title: attemptCount > 1 ? `${task.requirements} (attempt ${attemptNumber} of ${attemptCount})` : task.requirements,
    trigger: null,
    pr_number: [],
    agent_kind: "openhands",
    tags: serializeAtherNullTags(taskStatus, verificationOutcome),
    llm_model: execution.resolved_model,
    metrics: null,
    created_at: execution.created_at.toISOString(),
    updated_at: (execution.ended_at ?? execution.created_at).toISOString(),
    execution_status: taskStatusToExecutionStatus(taskStatus),
    conversation_url: null,
    // Always null from this route layer — see this file's header comment.
    session_api_key: null,
    sandbox_id: execution.sandbox_id,
    workspace: null,
    sub_conversation_ids: [],
    public: false,
  };
}

// --- ExecutionEvent -> OpenHandsEvent (logic ported from the prototype's
// mapping.ts, same three known kinds; anything else passes through as
// dropped-not-fabricated) ----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type ExecutionEventRow = { id: string; kind: string; payload: unknown; occurred_at: Date };

function extractFileEditorActionFields(
  actionRow: Pick<ExecutionEventRow, "payload">,
): { command: string | null; oldStr: string | null; newStr: string | null; fileText: string | null } | null {
  if (!isRecord(actionRow.payload)) return null;
  const actionBody = actionRow.payload.action;
  if (!isRecord(actionBody) || actionBody.kind !== "FileEditorAction") return null;
  return {
    command: typeof actionBody.command === "string" ? actionBody.command : null,
    oldStr: typeof actionBody.old_str === "string" ? actionBody.old_str : null,
    newStr: typeof actionBody.new_str === "string" ? actionBody.new_str : null,
    fileText: typeof actionBody.file_text === "string" ? actionBody.file_text : null,
  };
}

function mapExecutionEventRow(
  row: ExecutionEventRow,
  actionsById: Map<string, ExecutionEventRow>,
): OpenHandsEvent | null {
  if (!isRecord(row.payload)) return null;
  const payload = row.payload;
  const timestamp = row.occurred_at.toISOString();

  if (row.kind === "MessageEvent") {
    const source = payload.source === "user" ? "user" : "agent";
    return {
      id: row.id,
      timestamp,
      source,
      llm_message: payload.llm_message,
      activated_skills: payload.activated_skills ?? [],
      extended_content: payload.extended_content ?? [],
      ...(typeof payload.reasoning_content === "string" ? { reasoning_content: payload.reasoning_content } : {}),
    };
  }

  if (row.kind === "ActionEvent") {
    const actionBody = payload.action;
    const fileEditorFields = extractFileEditorActionFields(row);
    const enrichedAction =
      fileEditorFields && isRecord(actionBody)
        ? { ...actionBody, old_str: fileEditorFields.oldStr, new_str: fileEditorFields.newStr }
        : actionBody;
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
    return {
      id: row.id,
      timestamp,
      source: "agent",
      thought: payload.thought ?? [],
      reasoning_content: typeof payload.reasoning_content === "string" ? payload.reasoning_content : null,
      thinking_blocks: [],
      action: enrichedAction,
      tool_name: toolName,
      tool_call_id: `stub-${row.id}`,
      tool_call: { id: `stub-${row.id}`, type: "function", function: { name: toolName, arguments: "{}" } },
      llm_response_id: row.id,
      security_risk: "UNKNOWN",
    };
  }

  if (row.kind === "ObservationEvent") {
    const observation = isRecord(payload.observation) ? payload.observation : {};
    const observationKind = typeof observation.kind === "string" ? observation.kind : "";
    const toolName =
      observationKind === "TerminalObservation"
        ? "terminal"
        : observationKind === "FileEditorObservation"
          ? "file_editor"
          : "unknown";

    let enrichedObservation: Record<string, unknown> = observation;
    if (observationKind === "FileEditorObservation" && typeof payload.action_id === "string") {
      const pairedAction = actionsById.get(payload.action_id);
      const fields = pairedAction ? extractFileEditorActionFields(pairedAction) : null;
      if (fields) {
        const command = typeof observation.command === "string" ? observation.command : fields.command;
        if (fields.newStr !== null) {
          enrichedObservation = { ...observation, old_content: fields.oldStr ?? "", new_content: fields.newStr };
        } else if (command === "create" && fields.fileText !== null) {
          enrichedObservation = { ...observation, new_content: fields.fileText };
        }
      }
    }

    return {
      id: row.id,
      timestamp,
      source: "environment",
      tool_name: toolName,
      tool_call_id: typeof payload.action_id === "string" ? `stub-${payload.action_id}` : `stub-${row.id}`,
      observation: enrichedObservation,
      action_id: payload.action_id,
    };
  }

  // Unmapped kind — dropped, not fabricated into one of the known shapes.
  return null;
}

function logResolution(request: FastifyRequest, route: string, requestedId: string, resolution: ConversationResolution | null) {
  request.log.info(
    { route, requestedId, resolutionMethod: resolution?.resolutionMethod ?? null },
    resolution ? "resolved conversation target" : "no matching conversation in caller's organization",
  );
}

// --- Local-only /api/settings, /server_info stub ---------------------------
//
// Never forwarded to any AtherNull mutation, per the design doc — a
// process-lifetime, in-memory stand-in for OpenHands' own local
// misc_settings.app_preferences store, needed because OpenHands' own health
// probe (validateLocalBackend(), see the prototype's spike-c
// routes/health.ts) requires GET /api/settings + GET /server_info to both
// succeed before it will render its UI at all. Still gated behind
// requireOrgSession — a real signed-in user, even though this payload is
// static/local, not unauthenticated the way the prototype's stub was.
const localSettingsAppPreferences: Record<string, unknown> = {
  language: "en",
  user_consents_to_analytics: false,
  enable_sound_notifications: false,
};

function currentSettingsResponse() {
  return OpenHandsSettingsResponseSchema.parse({
    agent_settings: {},
    conversation_settings: {},
    llm_api_key_is_set: false,
    misc_settings: { app_preferences: localSettingsAppPreferences },
  });
}

const IdsQuerySchema = z.object({
  "ids[]": z.union([z.string(), z.array(z.string())]).optional(),
  ids: z.union([z.string(), z.array(z.string())]).optional(),
});

const EventsSearchQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  sort_order: z.enum(["TIMESTAMP_ASC", "TIMESTAMP_DESC"]).optional(),
});

const SearchQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

export async function openhandsCompatRoutes(app: FastifyInstance) {
  // GET /api/conversations/search -> {items: AppConversation[], next_page_id}
  app.get("/api/conversations/search", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const query = SearchQuerySchema.parse(request.query);

      // Real, indexed, org-scoped join — the id pairs (not full rows, to
      // avoid `executions`/`tasks` column-name collisions like `id`/`status`/
      // `created_at` on a flat selectAll() across both tables) are resolved
      // to full rows just below.
      const owners = await db
        .selectFrom("executions")
        .innerJoin("tasks", "tasks.id", "executions.task_id")
        .select(["executions.id as executionId", "executions.task_id as taskId"])
        .where("tasks.organization_id", "=", organizationId)
        .orderBy("executions.created_at", "desc")
        .execute();

      const limited = query.limit ? owners.slice(0, query.limit) : owners;

      const taskIds = [...new Set(limited.map((o) => o.taskId))];
      const executionIds = limited.map((o) => o.executionId);
      const [tasks, executions] = await Promise.all([
        taskIds.length
          ? db.selectFrom("tasks").selectAll().where("id", "in", taskIds).where("organization_id", "=", organizationId).execute()
          : Promise.resolve([]),
        executionIds.length ? db.selectFrom("executions").selectAll().where("id", "in", executionIds).execute() : Promise.resolve([]),
      ]);
      const tasksById = new Map(tasks.map((t) => [t.id, t]));
      const executionsById = new Map(executions.map((e) => [e.id, e]));

      const items = await Promise.all(
        limited.map(async (owner) => {
          const task = tasksById.get(owner.taskId);
          const execution = executionsById.get(owner.executionId);
          if (!task || !execution) return null;
          return buildAppConversation(task, execution);
        }),
      );

      const page = { items: items.filter((i): i is AppConversation => i !== null), next_page_id: null };
      reply.send(AppConversationPageSchema.parse(page));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/conversations?ids[]=... -> (AppConversation | null)[]
  // Not one of the plan's originally-scoped 4 per-conversation endpoints —
  // the pinned OpenHands frontend's single-conversation detail view mainly
  // resolves conversations through this batch endpoint
  // (AgentServerConversationService.batchGetAppConversations([cid]); see the
  // prototype's routes/conversations.ts header comment for how this was
  // discovered), but a later live-verification pass also observed one call
  // to the singular GET /api/conversations/:id below during that same view —
  // both endpoints are implemented and share the same resolution path.
  app.get("/api/conversations", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const rawQuery = IdsQuerySchema.parse(request.query);
      const idsParam = rawQuery["ids[]"] ?? rawQuery.ids;
      const ids = Array.isArray(idsParam) ? idsParam : idsParam !== undefined ? [idsParam] : [];

      const results = await Promise.all(
        ids.map(async (id) => {
          const resolution = await resolveConversationTarget(id, organizationId);
          logResolution(request, "GET /api/conversations", id, resolution);
          if (!resolution) return null;
          return buildAppConversation(resolution.task, resolution.execution);
        }),
      );

      reply.send(z.array(AppConversationPageSchema.shape.items.element.nullable()).parse(results));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/conversations/:id -> one AppConversation, or a 404 with a null
  // body (matching the prototype's own not-found shape) if resolution fails.
  // Uses the exact same resolveConversationTarget/buildAppConversation path
  // as every other route here — no second resolution implementation.
  app.get("/api/conversations/:id", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const resolution = await resolveConversationTarget(id, organizationId);
      logResolution(request, "GET /api/conversations/:id", id, resolution);
      if (!resolution) {
        reply.status(404).send(null);
        return;
      }

      const conversation = await buildAppConversation(resolution.task, resolution.execution);
      reply.send(AppConversationSchema.parse(conversation));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/conversations/:id/events/count -> bare number
  app.get("/api/conversations/:id/events/count", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const resolution = await resolveConversationTarget(id, organizationId);
      logResolution(request, "GET /api/conversations/:id/events/count", id, resolution);
      if (!resolution || !resolution.execution) {
        reply.send(0);
        return;
      }

      const row = await db
        .selectFrom("execution_events")
        .select(({ fn }) => [fn.countAll<string>().as("count")])
        .where("execution_id", "=", resolution.execution.id)
        .executeTakeFirstOrThrow();
      reply.send(Number(row.count));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/conversations/:id/events/search -> {items: OpenHandsEvent[], next_page_id}
  app.get("/api/conversations/:id/events/search", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const query = EventsSearchQuerySchema.parse(request.query);

      const resolution = await resolveConversationTarget(id, organizationId);
      logResolution(request, "GET /api/conversations/:id/events/search", id, resolution);
      if (!resolution || !resolution.execution) {
        reply.send(OpenHandsEventPageSchema.parse({ items: [], next_page_id: null }));
        return;
      }

      const sortDir = query.sort_order === "TIMESTAMP_DESC" ? "desc" : "asc";
      const rows = await db
        .selectFrom("execution_events")
        .select(["id", "kind", "payload", "occurred_at"])
        .where("execution_id", "=", resolution.execution.id)
        .orderBy("occurred_at", sortDir)
        .orderBy("id", sortDir)
        .execute();

      const actionsById = new Map<string, ExecutionEventRow>();
      for (const row of rows) {
        if (row.kind === "ActionEvent") actionsById.set(row.id, row);
      }
      const mapped = rows
        .map((row) => mapExecutionEventRow(row, actionsById))
        .filter((e): e is OpenHandsEvent => e !== null);
      const limited = query.limit ? mapped.slice(0, query.limit) : mapped;

      reply.send(OpenHandsEventPageSchema.parse({ items: limited, next_page_id: null }));
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /api/settings — local-only, static-ish (mutable only via PATCH
  // below, never persisted against AtherNull). Still requires a real signed-
  // in org session.
  app.get("/api/settings", async (request, reply) => {
    try {
      await requireOrgSession(request);
      reply.send(currentSettingsResponse());
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });

  // PATCH /api/settings — local-only stub. Accepts the real frontend's
  // `{ misc_settings_diff: { app_preferences: {...} } }` shape and merges it
  // into the in-memory store GET reads from; NEVER forwarded to any
  // AtherNull mutation.
  app.patch("/api/settings", async (request, reply) => {
    try {
      await requireOrgSession(request);
      const body = PatchOpenHandsSettingsRequestSchema.parse(request.body ?? {});
      const diff = body.misc_settings_diff?.app_preferences;
      if (diff) {
        Object.assign(localSettingsAppPreferences, diff);
      }
      reply.send(currentSettingsResponse());
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      if (err instanceof z.ZodError) {
        reply.status(400).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // GET /server_info — the other half of OpenHands' backend-health probe
  // (validateLocalBackend() asserts `version` against its own pinned
  // minimum). `version` here is pinned to the same floor the prototype's
  // Spike C stub used, empirically determined against the pinned frontend
  // checkout — an honest "this frontend's own expected floor," not a
  // fabricated real Agent Server build. Still requires a real signed-in org
  // session.
  app.get("/server_info", async (request, reply) => {
    try {
      await requireOrgSession(request);
      reply.send(
        OpenHandsServerInfoResponseSchema.parse({
          uptime: process.uptime(),
          idle_time: 0,
          title: "AtherNull OpenHands Compatibility Layer",
          version: "1.49.2",
        }),
      );
    } catch (err) {
      if (sendHttpError(reply, err)) return;
      throw err;
    }
  });
}
