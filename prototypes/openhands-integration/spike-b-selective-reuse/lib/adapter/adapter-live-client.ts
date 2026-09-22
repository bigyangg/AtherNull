/**
 * SPIKE D: fetch module for `/harness-live`. Talks ONLY to Spike C's
 * already-working, already-verified adapter-server (read-only itself
 * against `apps/api`) — never to AtherNull's real API directly, and never
 * writes anything anywhere. See `../../README.md`'s "Spike D" section for
 * the full writeup this module implements.
 *
 * DATA PROVENANCE (repeated here deliberately, not just in README): every
 * byte this module fetches is a real AtherNull API response read from a
 * seeded LOCAL DEVELOPMENT DATABASE (`spike-c-full-shell-adapter/seed/seed.ts`,
 * run through the same zero-cost, zero-LLM, zero-Solana internal test-only
 * endpoints `apps/api/test/job-lifecycle.test.ts` uses). It is NOT the
 * output of a paid coding-agent execution — nothing here ever ran an LLM or
 * touched a real sandbox. Do not describe it that way in any comment, log
 * line, or UI copy added to this module.
 *
 * Unlike Spike B's fixture-only path (`lib/adapter/execution-event-to-openhands-event.ts`,
 * which translates AtherNull's *raw wire* `ExecutionEvent` shape into
 * `OpenHandsEvent`), this module does NOT re-translate anything: Spike C's
 * adapter-server has already done that server-side, so `GET
 * /api/conversations/:id/events/search`'s response body already IS
 * `OpenHandsEvent[]`. This module fetches that JSON as-is and hands it
 * straight to the same vendored `<Messages>`/`toUiMessages` logic
 * `app/harness/page.tsx` already uses — "reuse it, not rebuild it".
 *
 * NAMING NOTE (verified against seed-output.json + adapter-server source,
 * not assumed): the adapter's `:id` route param is AtherNull's *taskId*,
 * NOT the raw Agent-Server-native `conversationId` field seed-output.json
 * also records on the execution row. `adapter-server/src/mapping.ts` sets
 * `AppConversation.id = task.id` (confirmed by reading `mapping.ts` line
 * 131) — the adapter never routes on `execution.conversation_id` at all.
 * `NEXT_PUBLIC_CONVERSATION_ID` below must therefore be seed-output.json's
 * `taskId`, not its `conversationId`.
 */
import {
  isActionEvent,
  isObservationEvent,
} from "#/types/agent-server/type-guards";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import type { Command } from "#/stores/command-store";

export interface LiveConversationSummary {
  id: string;
  title: string;
}

export interface LiveFetchResult {
  conversation: LiveConversationSummary | null;
  events: OpenHandsEvent[];
}

/**
 * RENDERING-CONTRACT MISMATCH FOUND (verified by curling the adapter's real
 * `/events/search` response for the seeded conversation and comparing
 * field-by-field against `vendor/openhands/types/agent-server/core/base/observation.ts`
 * before wiring this up — not assumed):
 *
 * `TerminalObservation` declares `metadata: CmdOutputMetadata` as a
 * REQUIRED (non-optional) field, but the adapter's real JSON for the
 * seeded terminal pair omits `metadata` entirely (it only sends
 * `{kind, command, content, timeout, is_error, exit_code}` — confirmed via
 * `curl http://localhost:4100/api/conversations/<taskId>/events/search`).
 * This does NOT crash today's render, because the one vendored call site
 * that reads it — `get-observation-result.ts`'s
 * `observation.exit_code ?? observation.metadata.exit_code ?? null` — short
 * circuits on the real `exit_code: 0` before ever touching `.metadata`
 * (`??` only falls through on null/undefined, and `0` is neither). But it
 * IS a genuine, real gap against the declared type contract: if a future
 * seeded event ever had a null/undefined `exit_code`, that same line would
 * throw (`Cannot read properties of undefined (reading 'exit_code')`).
 *
 * Fixed HERE, in Spike B's new fetch layer — never by patching the vendored
 * `get-observation-result.ts`, and never by loosening what the smoke test
 * asserts — by synthesizing a default `CmdOutputMetadata` object whenever
 * the adapter's real payload omits it, the same "document what's
 * synthesized, don't silently invent it" approach
 * `execution-event-to-openhands-event.ts`'s own header comment already
 * uses for the fixture path.
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

/**
 * Fetches the seeded conversation's title via the adapter's plural,
 * `ids[]=`-keyed endpoint (`GET /api/conversations?ids[]=<id>` ->
 * `(AppConversation | null)[]`) — the same endpoint Spike C's own
 * `use-user-conversation.ts`-driven detail view uses, not the singular
 * `GET /api/conversations/:id`, so this exercises the identical real
 * endpoint contract Spike C already proved rather than a different one.
 */
export async function fetchLiveConversation(
  adapterBase: string,
  conversationId: string,
): Promise<LiveConversationSummary | null> {
  const url = `${adapterBase}/api/conversations?ids[]=${encodeURIComponent(conversationId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as (Record<string, unknown> | null)[];
  const first = body[0];
  if (!first || typeof first.id !== "string" || typeof first.title !== "string") {
    return null;
  }
  return { id: first.id, title: first.title };
}

/** Fetches the seeded conversation's real `OpenHandsEvent[]`, normalized. */
export async function fetchLiveEvents(
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

export async function fetchLiveConversationAndEvents(
  adapterBase: string,
  conversationId: string,
): Promise<LiveFetchResult> {
  const [conversation, events] = await Promise.all([
    fetchLiveConversation(adapterBase, conversationId),
    fetchLiveEvents(adapterBase, conversationId),
  ]);
  return { conversation, events };
}

/**
 * Pairs `ActionEvent`s with the `ObservationEvent` that answers them by
 * their REAL `action_id` relationship (`ObservationEvent.action_id ===
 * ActionEvent.id`) — mirroring `apps/web/lib/execution-events.ts`'s
 * `pairActionsWithObservations` (build a Map keyed by `action_id`, then
 * look each action up in it), never by assuming array order/adjacency.
 * Operates on already-`OpenHandsEvent`-shaped data (this spike's live
 * path), where `apps/web`'s version operates on raw `ExecutionEvent` rows
 * — same pairing relationship, different input shape.
 */
export function pairActionsWithObservations(
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

/**
 * Builds the `useCommandStore` seed list (real fetched command/output text,
 * REPLAYED — not a live PTY, same fidelity label `app/harness/page.tsx`
 * already uses for its fixture terminal) from every real
 * TerminalAction/TerminalObservation pair found via `action_id`, in event
 * order. An action/observation kind other than terminal is skipped here —
 * this function only feeds the terminal panel.
 */
export function buildLiveTerminalCommands(events: OpenHandsEvent[]): Command[] {
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
