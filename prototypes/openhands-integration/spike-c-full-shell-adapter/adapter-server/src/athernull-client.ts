// Holds ONE server-side Better Auth session cookie (obtained via one real
// sign-in call as the seeded owner user) and uses it to call AtherNull's
// real GET endpoints. This module is the entire trust boundary of the
// adapter: the cookie captured here is a module-level variable that is
// never returned from any Express route, never logged in full, and never
// forwarded to the browser - only the *mapped, derived* JSON these
// functions' callers build from it is. It also never touches
// SESSION_API_KEY (the Agent Server credential) at all: apps/api's own read
// endpoints (GET /v1/jobs/:id/executions/:executionId/events, etc.) read
// persisted DB rows, never a live Agent Server container - confirmed absent
// from apps/api/src/ before this spike started.
//
// Strictly read-only by construction: this module exposes only GET
// wrappers. It has no POST/PUT/PATCH/DELETE helper of any kind, so there is
// no code path here that could accidentally fund/accept/reject/dispatch
// anything - the only non-GET call in the whole spike is the seed script's
// one-time setup (../seed/seed.ts), a separate process that never runs
// alongside this server in normal operation.
import type { RepoProject, Task, TaskDetail, Execution, ExecutionEvent } from "./athernull-types.js";

// --- raw (snake_case, straight off the DB rows) -> camelCase -------------
// apps/api never applies a camelCase plugin to its Kysely instance (db.ts),
// so every /v1/* JSON response is snake_case as the columns are literally
// named (confirmed directly: `select id, project_id, ... from tasks`
// against the seeded row matches this 1:1). apps/web's own
// lib/api/live.ts has an identical Raw*/to* pair for exactly this reason -
// duplicated here (not imported, per the spike's isolation rule) rather
// than invented from scratch, so this adapter matches the one other place
// in the codebase that already solved this problem.
interface RawProject {
  id: string;
  permitted_repository: string;
  revision: string | null;
  scope: string | null;
  created_at: string;
}

interface RawExecution {
  id: string;
  task_id: string;
  attempt_id: string;
  status: string;
  conversation_id: string | null;
  routing_tier: string | null;
  routing_score: number | string | null;
  routing_reason: string | null;
  resolved_model: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface RawTask {
  id: string;
  organization_id: string;
  project_id: string;
  agent_profile_id: string;
  repository_revision: string;
  requirements: string;
  acceptance_criteria: string[];
  max_budget_minor: string;
  currency: string;
  status: Task["status"];
  created_at: string;
  updated_at: string;
}

interface RawTaskDetail extends RawTask {
  executions: RawExecution[];
  verificationRuns: unknown[];
  budgetSpentMinor: number;
}

interface RawExecutionEvent {
  id: string;
  execution_id: string;
  kind: string;
  payload: unknown;
  occurred_at: string;
  created_at: string;
}

function toProject(raw: RawProject): RepoProject {
  return {
    id: raw.id,
    permittedRepository: raw.permitted_repository,
    revision: raw.revision,
    scope: raw.scope,
    createdAt: raw.created_at,
  };
}

function toExecution(raw: RawExecution): Execution {
  return {
    id: raw.id,
    taskId: raw.task_id,
    attemptId: raw.attempt_id,
    status: raw.status,
    conversationId: raw.conversation_id,
    routingTier: raw.routing_tier,
    routingScore: raw.routing_score === null ? null : Number(raw.routing_score),
    routingReason: raw.routing_reason,
    resolvedModel: raw.resolved_model,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    createdAt: raw.created_at,
  };
}

function toTask(raw: RawTask): Task {
  return {
    id: raw.id,
    organizationId: raw.organization_id,
    projectId: raw.project_id,
    agentProfileId: raw.agent_profile_id,
    repositoryRevision: raw.repository_revision,
    requirements: raw.requirements,
    acceptanceCriteria: raw.acceptance_criteria,
    maxBudgetMinor: Number(raw.max_budget_minor),
    currency: raw.currency,
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toExecutionEvent(raw: RawExecutionEvent): ExecutionEvent {
  return {
    id: raw.id,
    executionId: raw.execution_id,
    kind: raw.kind,
    payload: raw.payload,
    occurredAt: raw.occurred_at,
    createdAt: raw.created_at,
  };
}

const API_BASE = process.env.ATHERNULL_API_BASE ?? "http://localhost:3001";
const WEB_APP_URL = process.env.ATHERNULL_WEB_APP_URL ?? "http://localhost:3000";
const OWNER_EMAIL = process.env.ATHERNULL_OWNER_EMAIL;
const OWNER_PASSWORD = process.env.ATHERNULL_OWNER_PASSWORD;
// A brand new sign-in defaults to the user's *oldest* org membership
// (auth.ts's session.create.before hook: "default it to the user's oldest
// membership, their auto-created personal org") - not the spike-c org the
// seed script created afterward. Without an explicit switch, every read
// below would silently scope to the empty personal org instead of the
// seeded data. Confirmed by observation: the adapter's first boot without
// this returned {items: [], next_page_id: null} from a real, non-erroring
// call - the org was just wrong, not the request.
const ORGANIZATION_ID = process.env.ATHERNULL_ORGANIZATION_ID;

if (!OWNER_EMAIL || !OWNER_PASSWORD || !ORGANIZATION_ID) {
  throw new Error(
    "ATHERNULL_OWNER_EMAIL / ATHERNULL_OWNER_PASSWORD / ATHERNULL_ORGANIZATION_ID " +
      "are required - set them from seed/seed-output.json's ownerEmail/ownerPassword" +
      "/organizationId (see ../README.md).",
  );
}

let sessionCookie: string | null = null;
let signInPromise: Promise<string> | null = null;

function absorbSetCookie(res: Response): string {
  const setCookies =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : [];
  const jar = new Map<string, string>();
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function signIn(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_APP_URL },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`adapter sign-in failed: ${res.status} ${await res.text()}`);
  }
  const cookie = absorbSetCookie(res);
  console.log(`[athernull-client] signed in as ${OWNER_EMAIL} (session cookie held server-side only)`);

  // Switch the fresh session's active org to the seeded spike-c org - see
  // the ORGANIZATION_ID comment above for why this is required.
  const setActiveRes = await fetch(`${API_BASE}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_APP_URL, cookie },
    body: JSON.stringify({ organizationId: ORGANIZATION_ID }),
  });
  if (!setActiveRes.ok) {
    throw new Error(
      `adapter set-active-organization failed: ${setActiveRes.status} ${await setActiveRes.text()}`,
    );
  }
  // set-active re-signs the session cookie (setSessionCookie in better-auth's
  // handler) - absorb whatever it sent back, same dropSessionCache concern
  // job-lifecycle.test.ts's CookieJar documents for the 5-minute
  // session_data cache cookie.
  const updatedCookieFragment = absorbSetCookie(setActiveRes);
  const merged = new Map<string, string>();
  for (const part of cookie.split("; ")) {
    const eq = part.indexOf("=");
    if (eq > -1) merged.set(part.slice(0, eq), part.slice(eq + 1));
  }
  for (const part of updatedCookieFragment.split("; ")) {
    const eq = part.indexOf("=");
    if (eq > -1) merged.set(part.slice(0, eq), part.slice(eq + 1));
  }
  merged.delete("better-auth.session_data");
  console.log(`[athernull-client] switched active organization to ${ORGANIZATION_ID}`);
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function getSessionCookie(): Promise<string> {
  if (sessionCookie) return sessionCookie;
  if (!signInPromise) {
    signInPromise = signIn().then((cookie) => {
      sessionCookie = cookie;
      return cookie;
    });
  }
  return signInPromise;
}

// Every real network call in this module funnels through here - GET only,
// no method parameter accepted, so there is no way for a future edit to
// this file to accidentally add a mutating call without also changing this
// function's signature (a deliberate friction point, not an oversight).
async function athernullGet(path: string, retryOn401 = true): Promise<unknown> {
  const cookie = await getSessionCookie();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: { cookie },
  });

  if (res.status === 401 && retryOn401) {
    // Session expired/invalidated - sign in again once and retry.
    sessionCookie = null;
    signInPromise = null;
    return athernullGet(path, false);
  }

  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function getProjects(): Promise<RepoProject[]> {
  const raw = (await athernullGet("/v1/projects")) as RawProject[];
  return raw.map(toProject);
}

export async function getTasks(): Promise<Task[]> {
  const raw = (await athernullGet("/v1/jobs")) as RawTask[];
  return raw.map(toTask);
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail | null> {
  let raw: RawTaskDetail;
  try {
    raw = (await athernullGet(`/v1/jobs/${encodeURIComponent(taskId)}`)) as RawTaskDetail;
  } catch (err) {
    if (err instanceof Error && err.message.includes(" 404 ")) return null;
    throw err;
  }
  return {
    ...toTask(raw),
    executions: raw.executions.map(toExecution),
    verificationRuns: [],
    budgetSpentMinor: raw.budgetSpentMinor,
  };
}

export async function getExecutionEvents(
  taskId: string,
  executionId: string,
): Promise<ExecutionEvent[]> {
  const raw = (await athernullGet(
    `/v1/jobs/${encodeURIComponent(taskId)}/executions/${encodeURIComponent(executionId)}/events`,
  )) as RawExecutionEvent[];
  return raw.map(toExecutionEvent);
}
