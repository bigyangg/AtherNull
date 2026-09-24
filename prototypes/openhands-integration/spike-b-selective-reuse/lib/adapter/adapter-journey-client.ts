/**
 * SPIKE F: fetch module for `/harness-journey`. Talks ONLY to Spike C's
 * adapter-server (read-only itself against `apps/api`), same trust boundary
 * as `adapter-live-client.ts` (Spike D) — never AtherNull's real API
 * directly, never writes anything anywhere.
 *
 * Deliberately a SEPARATE file from `adapter-live-client.ts` rather than an
 * edit to it: `/harness-live` and its smoke test are frozen, already-
 * verified artifacts from Spikes D/E (see this spike's task brief) and stay
 * untouched. This module talks to the Phase-1 adapter endpoints that changed
 * for Spike F specifically:
 *   - `GET /api/conversations/search` now returns one `AppConversation` per
 *     EXECUTION ATTEMPT (`execution.conversationId ?? execution.id`), not
 *     one per task — see adapter-server/src/mapping.ts's
 *     `mapExecutionToAppConversation`.
 *   - `GET /api/conversations/:id/events/search` now resolves `:id` against
 *     a specific requested execution instead of always the task's latest
 *     (`executions[0]`) — see adapter-server/src/routes/events.ts's
 *     `resolveConversationTarget`.
 *
 * DATA PROVENANCE (same as adapter-live-client.ts): every byte fetched here
 * is a real AtherNull API response read from a seeded LOCAL DEVELOPMENT
 * DATABASE (`spike-f-execution-review-journey/seed-journey-data.mjs`, run
 * through the same zero-cost, zero-LLM, zero-Solana internal/test-only
 * endpoints `apps/api/test/job-lifecycle.test.ts` uses, plus the real
 * `/verify`/`/accept` endpoints — also confirmed pure DB transitions). NOT
 * the output of a paid coding-agent execution.
 */
import {
  isActionEvent,
  isObservationEvent,
} from "#/types/agent-server/type-guards";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import type { Command } from "#/stores/command-store";

/** Local transcription of the fields this page reads off adapter-server's
 * `AppConversation` (mapping.ts) — not the full shape, just what's used. */
export interface JourneyConversationSummary {
  id: string;
  title: string;
  tags: Record<string, string> | null;
  execution_status: string;
  created_at: string;
  updated_at: string;
}

interface AppConversationPage {
  items: JourneyConversationSummary[];
  next_page_id: string | null;
}

/**
 * Fetches every `AppConversation` the adapter's `/search` endpoint returns
 * (one per execution attempt across every seeded task in the org — see
 * conversations.ts's `mapTaskExecutionsToAppConversationPage`), then narrows
 * to the ones belonging to THIS spike's seeded journey task by matching the
 * distinctive marker text `seed-journey-data.mjs` embeds in the task's real
 * `requirements` field (which `mapExecutionToAppConversation` copies
 * verbatim into `title`, before appending "(attempt N of M)"). This is a
 * client-side filter, not a new adapter query param — the adapter has no
 * per-task filter on `/search` (out of this phase's scope to add one), and
 * at this prototype's scale (1-2 seeded tasks) filtering client-side after
 * one fetch is negligible. Falls back to returning every item unfiltered if
 * the marker matches nothing (e.g. a differently-seeded environment), so the
 * page still shows *something* rather than silently rendering empty.
 */
export async function fetchJourneyConversations(
  adapterBase: string,
  titleFilter: string,
): Promise<JourneyConversationSummary[]> {
  const url = `${adapterBase}/api/conversations/search`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  const page = (await res.json()) as AppConversationPage;
  const items = page.items ?? [];
  if (!titleFilter) return items;
  const filtered = items.filter((item) => item.title?.includes(titleFilter));
  return filtered.length > 0 ? filtered : items;
}

/**
 * Same `TerminalObservation.metadata` synthesis as
 * `adapter-live-client.ts`'s `normalizeEvent` (duplicated rather than
 * imported — that module is frozen for this spike, same "don't touch
 * Spike D/E's stable artifacts" rule that keeps `/harness-live` untouched).
 * See that file's header comment for the full field-by-field justification;
 * unchanged here.
 */
function normalizeEvent(raw: unknown): OpenHandsEvent {
  const event = raw as OpenHandsEvent;
  if (isObservationEvent(event)) {
    const observation = event.observation as unknown as Record<string, unknown>;
    if (
      observation &&
      observation.kind === "TerminalObservation" &&
      observation.metadata === undefined
    ) {
      observation.metadata = {
        exit_code:
          typeof observation.exit_code === "number"
            ? observation.exit_code
            : -1,
        pid: -1,
        username: null,
        hostname: null,
        working_dir: null,
        py_interpreter_path: null,
        prefix: "",
        suffix: "",
      };
    }
  }
  return event;
}

/** Fetches one execution attempt's real `OpenHandsEvent[]`, normalized. */
export async function fetchJourneyEvents(
  adapterBase: string,
  conversationId: string,
): Promise<OpenHandsEvent[]> {
  const url = `${adapterBase}/api/conversations/${encodeURIComponent(conversationId)}/events/search`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { items: unknown[]; next_page_id: string | null };
  return body.items.map(normalizeEvent);
}

/** Same action/observation pairing as `adapter-live-client.ts` (duplicated
 * for the same "don't touch the frozen Spike D module" reason above). */
function pairActionsWithObservations(
  events: OpenHandsEvent[],
): { action: OpenHandsEvent; observation: OpenHandsEvent | undefined }[] {
  const observationsByActionId = new Map<string, OpenHandsEvent>();
  for (const event of events) {
    if (isObservationEvent(event)) {
      observationsByActionId.set(event.action_id, event);
    }
  }
  return events
    .filter(isActionEvent)
    .map((action) => ({
      action,
      observation: observationsByActionId.get(action.id),
    }));
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const first = content.find(
    (item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string",
  ) as Record<string, unknown> | undefined;
  return first ? (first.text as string) : null;
}

/** Builds the `useCommandStore` seed list for the selected attempt's
 * terminal events — same replay-only fidelity as `/harness-live`. */
export function buildJourneyTerminalCommands(events: OpenHandsEvent[]): Command[] {
  const commands: Command[] = [];
  for (const { action, observation } of pairActionsWithObservations(events)) {
    if (!isActionEvent(action)) continue;
    if (action.action.kind !== "TerminalAction" && action.action.kind !== "ExecuteBashAction") {
      continue;
    }
    const command = (action.action as { command?: unknown }).command;
    if (typeof command !== "string") continue;
    commands.push({ type: "input", content: command });

    if (observation && isObservationEvent(observation)) {
      const outputText = firstText(
        (observation.observation as { content?: unknown }).content,
      );
      commands.push({ type: "output", content: outputText ?? "" });
    }
  }
  return commands;
}
