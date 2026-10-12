// ADR-0016 — pre-funding discussions. Starting a conversation in the Agent
// Canvas never forwards the browser's request: the gateway starts this
// tool-less discussion agent instead (no terminal, files, browser or MCP —
// it can only talk), records it, and caps it. When the scope is clear the
// customer turns the discussion into a plan (estimate) in AtherNull Builds,
// approves it, funds it, and only then does a fully-tooled build run.

import { randomUUID } from "node:crypto";

import { db } from "../db.js";
import { HttpError } from "../session.js";
import { loadOrgServer } from "./org-server.js";

export const MAX_MESSAGES_PER_DISCUSSION = Number(process.env.DISCUSSION_MAX_MESSAGES ?? 40);
export const MAX_DISCUSSIONS_PER_ORG_PER_DAY = Number(process.env.DISCUSSION_MAX_PER_ORG_PER_DAY ?? 30);
const MAX_ITERATIONS = 6;
const MAX_TRANSCRIPT_CHARS = 16_000;

const DISCUSSION_INSTRUCTIONS = `IDENTITY: You are the AtherNull Agent, made by AtherNull. If asked your name or who made you, say you are the AtherNull Agent. Never call yourself OpenHands or any other product name, even if earlier instructions say so.
You are AtherNull's planning assistant, talking with a customer BEFORE any work is paid for.
You have no tools: you cannot run commands, read or edit files, or browse. Never claim to have done so.
NEVER write the solution yourself: no source code, no file contents, no package.json, no setup or install commands, not even a short snippet. Writing, testing and delivering the code is the paid build's job, after the customer approves the plan and pays. If the customer asks you for the code, say so in one sentence and point them to 'Draft plan' on the card below.
Your job is to agree on a clear scope quickly. Lead with a proposal, not a questionnaire:
- in your first reply, propose a concrete plan straight away: deliverables and testable acceptance criteria;
- fill anything unstated with sensible defaults (for example a small web app in plain HTML/CSS/JS or React, started from scratch) and say in one line which defaults you assumed;
- ask at most two short questions, and only about choices that would really change the build; never ask about something you already chose a default for (the customer can simply change it), and never list options for things a reasonable default covers;
- always show the acceptance criteria as a short checklist, even in the first reply;
- the build happens later, after the customer funds it: say "the plan" or "the build will", not "I'll build";
- stick to what the customer actually asked for; do not add goals or features they did not mention;
- keep replies short, and keep the scope small enough to build and verify in one go;
- never estimate time in hours or days of human work: the AtherNull agent builds it in minutes once paid;
- never quote prices or amounts: the bill on the card is the only price.
When the customer agrees (or just says to go ahead), summarize the scope as a short list of deliverables and acceptance criteria, then tell the customer:
"When you're ready, press 'Draft plan' on the card below. You'll get the plan and the bill right here in the chat to approve and pay."
Never send the customer to another page to do this; everything happens in this chat.`;

function discussionLlm() {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) throw new HttpError(503, "Discussions are not configured on this deployment");
  return {
    model: process.env.DISCUSSION_LLM_MODEL ?? "nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
    api_key: apiKey,
    usage_id: "athernull-discussion",
  };
}

// The only thing taken from the browser: the opening message text.
export function openingText(body: unknown): string {
  const message = (body as { initial_message?: { content?: { text?: unknown }[] } } | null)?.initial_message;
  const text = (message?.content ?? [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  return text.slice(0, 8_000);
}

export function buildDiscussionRequest(conversationId: string, text: string) {
  return {
    conversation_id: conversationId,
    workspace: { kind: "LocalWorkspace", working_dir: `/workspace/discussions/${conversationId}` },
    agent: {
      kind: "Agent",
      llm: discussionLlm(),
      tools: [],
      mcp_config: {},
      agent_context: {
        system_message_suffix: DISCUSSION_INSTRUCTIONS,
        load_user_skills: false,
        load_public_skills: false,
        load_project_skills: false,
      },
    },
    ...(text ? { initial_message: { role: "user", content: [{ type: "text", text }], run: true } } : {}),
    max_iterations: MAX_ITERATIONS,
    tags: { athernullmode: "discussion" },
    // Titled by the gateway from the user's own words (discussionTitle):
    // a small model asked for a title tends to answer with its instructions.
    autotitle: false,
  };
}

/** A discussion's title: the first line of its opening message, shortened. */
export function discussionTitle(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  if (!line) return "New discussion";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

export async function startDiscussion(organizationId: string, userId: string, body: unknown) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await db
    .selectFrom("discussion_conversations")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("organization_id", "=", organizationId)
    .where("created_at", ">", since)
    .executeTakeFirstOrThrow();
  if (Number(recent.n) >= MAX_DISCUSSIONS_PER_ORG_PER_DAY) {
    throw new HttpError(429, "Daily discussion limit reached for this organization");
  }
  const conversationId = randomUUID();
  const text = openingText(body);
  // Recorded before the sandbox call so a message can never reach an
  // unrecorded conversation; removed again if the sandbox refuses.
  await db
    .insertInto("discussion_conversations")
    .values({ conversation_id: conversationId, organization_id: organizationId, created_by: userId, message_count: text ? 1 : 0 })
    .execute();
  return { conversationId, title: discussionTitle(text), request: buildDiscussionRequest(conversationId, text) };
}

export async function forgetDiscussion(conversationId: string) {
  await db.deleteFrom("discussion_conversations").where("conversation_id", "=", conversationId).execute();
}

const normalizeId = (id: string) => id.replace(/-/g, "").toLowerCase();

/** This org's discussion row, whichever id form (with or without dashes) the canvas uses. */
export async function findDiscussion(conversationId: string, organizationId: string) {
  const plain = normalizeId(conversationId);
  if (!/^[0-9a-f]{32}$/.test(plain)) return null;
  const dashed = `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`;
  return (
    (await db
      .selectFrom("discussion_conversations")
      .selectAll()
      .where("organization_id", "=", organizationId)
      .where("conversation_id", "in", [plain, dashed])
      .executeTakeFirst()) ?? null
  );
}

/** Lets one chat message into an org's discussion, within its cap. Null when it is not a discussion of this org. */
export async function admitDiscussionMessage(conversationId: string, organizationId: string): Promise<boolean | null> {
  const rows = await db
    .selectFrom("discussion_conversations")
    .select(["conversation_id", "message_count"])
    .where("organization_id", "=", organizationId)
    .execute();
  const row = rows.find((r) => normalizeId(r.conversation_id) === normalizeId(conversationId));
  if (!row) return null;
  const updated = await db
    .updateTable("discussion_conversations")
    .set((eb) => ({ message_count: eb("message_count", "+", 1), last_message_at: new Date() }))
    .where("conversation_id", "=", row.conversation_id)
    .where("message_count", "<", MAX_MESSAGES_PER_DISCUSSION)
    .returning("conversation_id")
    .executeTakeFirst();
  if (!updated) {
    throw new HttpError(429, "This discussion has reached its message limit. Turn it into a build in AtherNull Builds, or start a new one.");
  }
  return true;
}

export interface TranscriptTurn {
  role: "customer" | "agent";
  text: string;
}

/** The discussion's chat turns, oldest first, read from the org sandbox. */
export async function fetchTranscript(server: { baseUrl: string; key: string }, conversationId: string): Promise<TranscriptTurn[]> {
  const turns: TranscriptTurn[] = [];
  let pageId: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${server.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/events/search`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("sort_order", "TIMESTAMP");
    if (pageId) url.searchParams.set("page_id", pageId);
    const res = await fetch(url, { headers: { "X-Session-API-Key": server.key } });
    if (!res.ok) throw new HttpError(502, "Could not read the discussion from the agent sandbox");
    const body = (await res.json()) as { items?: Record<string, unknown>[]; next_page_id?: string | null };
    for (const event of body.items ?? []) {
      if (event.kind !== "MessageEvent") continue;
      const message = event.llm_message as { content?: { text?: unknown }[] } | undefined;
      const text = (message?.content ?? []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n").trim();
      if (text) turns.push({ role: event.source === "user" ? "customer" : "agent", text });
    }
    pageId = body.next_page_id ?? null;
    if (!pageId) break;
  }
  return turns;
}

export const DISCUSSION_PROMPT_MARKER = "[Planned from a canvas discussion]";

/** Planner input built from a discussion: the agreed scope wins over early ideas. */
export function discussionPrompt(turns: TranscriptTurn[]): string {
  const lines = turns.map((t) => `${t.role === "customer" ? "Customer" : "Agent"}: ${t.text}`);
  let transcript = lines.join("\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = `…${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
  return `${DISCUSSION_PROMPT_MARKER}\nPlan the build the customer and the agent agreed on in this discussion. Where they changed their minds, the later agreement wins.\n\n${transcript}`;
}

/**
 * Planner input for "Turn into a build": the transcript of one of this
 * org's discussions, read server-side from the org's sandbox.
 */
export async function discussionPlannerPrompt(discussionId: string, organizationId: string): Promise<string> {
  const row = await db
    .selectFrom("discussion_conversations")
    .select("conversation_id")
    .where("organization_id", "=", organizationId)
    .where("conversation_id", "=", discussionId)
    .executeTakeFirst();
  if (!row) throw new HttpError(404, "Discussion not found");
  const turns = await fetchTranscript(await loadOrgServer(organizationId), row.conversation_id);
  if (!turns.some((t) => t.role === "customer")) throw new HttpError(409, "This discussion has no messages yet");
  return discussionPrompt(turns);
}

export interface DiscussionSummary {
  id: string;
  plannedLineageId: string | null;
  title: string | null;
  messageCount: number;
  createdAt: string;
  lastMessageAt: string;
}

/** The org's recent discussions, titled by the sandbox when it can. */
export async function listDiscussions(organizationId: string): Promise<DiscussionSummary[]> {
  const rows = await db
    .selectFrom("discussion_conversations")
    .selectAll()
    .where("organization_id", "=", organizationId)
    .orderBy("last_message_at", "desc")
    .limit(20)
    .execute();
  let server: Awaited<ReturnType<typeof loadOrgServer>> | null = null;
  try {
    server = await loadOrgServer(organizationId);
  } catch {
    server = null;
  }
  return Promise.all(
    rows.map(async (row) => {
      let title: string | null = null;
      if (server) {
        try {
          const res = await fetch(`${server.baseUrl}/api/conversations/${encodeURIComponent(row.conversation_id)}`, {
            headers: { "X-Session-API-Key": server.key },
          });
          if (res.ok) title = ((await res.json()) as { title?: string | null }).title ?? null;
        } catch {
          title = null;
        }
      }
      return {
        id: row.conversation_id,
        plannedLineageId: row.planned_lineage_id,
        title,
        messageCount: row.message_count,
        createdAt: row.created_at.toISOString(),
        lastMessageAt: row.last_message_at.toISOString(),
      };
    }),
  );
}

/** Records the plan a discussion was turned into (Builds page bookkeeping). */
export async function markDiscussionPlanned(discussionId: string, organizationId: string, lineageId: string) {
  await db
    .updateTable("discussion_conversations")
    .set({ planned_lineage_id: lineageId })
    .where("conversation_id", "=", discussionId)
    .where("organization_id", "=", organizationId)
    .execute();
}
