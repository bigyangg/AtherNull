/**
 * Adapter: AtherNull `ExecutionEvent` (the real Agent Server event-stream row
 * — `apps/web/lib/types.ts`) -> vendored OpenHands `OpenHandsEvent` (the
 * shape `vendor/openhands/components/conversation-events/chat/messages.tsx`
 * and `event-message.tsx` actually read, from `vendor/openhands/types/agent-server/core`).
 *
 * This is the field-by-field bridge the task asked to discover empirically:
 * for a real AtherNull-captured event to render through the vendored
 * components at all, this fills in every field the OpenHands type contract
 * requires that AtherNull's own event stream does not track (or tracks under
 * a different name). Those gaps are listed below — this is the concrete
 * "integration cost" number for this reuse unit.
 *
 * FIELDS SYNTHESIZED (not present in AtherNull's real payload, defaulted
 * here so the vendored types are satisfied):
 *   ActionEvent.thought            -> [] (AtherNull's `ActionEvent` payload
 *                                     sometimes carries `reasoning_content`,
 *                                     never the SDK's separate `thought:
 *                                     TextContent[]` field)
 *   ActionEvent.thinking_blocks    -> []
 *   ActionEvent.tool_call_id       -> falls back to the event's own `id`
 *   ActionEvent.tool_call          -> synthesized `{id, type:"function",
 *                                     function:{name: tool_name, arguments:"{}"}}`
 *   ActionEvent.llm_response_id    -> falls back to the event's own `id`
 *   ActionEvent.security_risk      -> "UNKNOWN" unless present
 *   ObservationEvent.tool_name     -> falls back to "unknown"
 *   ObservationEvent.tool_call_id  -> falls back to "unknown"
 *   MessageEvent.activated_skills  -> []
 *   MessageEvent.extended_content  -> []
 *
 * An event whose `kind` isn't one of AtherNull's 3 known kinds (MessageEvent
 * / ActionEvent / ObservationEvent — see fixture 9 / the malformed-event
 * case) is passed through as a minimal `BaseEvent`-shaped object instead of
 * dropped, so the vendored renderer's own defensive fallback (not this
 * adapter) decides what to show — see `event-message.tsx`'s final
 * `!isActionEvent && !isObservationEvent` branch, which treats it as an
 * (empty) message rather than crashing.
 */
import type { ExecutionEvent } from "../fixtures/execution-events.synthetic";

// Vendored OpenHands types this adapter targets.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import type { OpenHandsEvent } from "#/types/agent-server/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSourceType(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Adapts a single `ExecutionEvent` to a vendored `OpenHandsEvent`. */
export function executionEventToOpenHandsEvent(event: ExecutionEvent): OpenHandsEvent {
  const payload = isRecord(event.payload) ? event.payload : {};

  if (event.kind === "MessageEvent") {
    const llmMessage = isRecord(payload.llm_message) ? payload.llm_message : {};
    return {
      id: event.id,
      timestamp: event.occurredAt,
      source: toSourceType(payload.source, "agent"),
      llm_message: {
        role: (llmMessage.role as string) ?? (payload.source === "user" ? "user" : "assistant"),
        content: Array.isArray(llmMessage.content) ? llmMessage.content : [],
        reasoning_content: typeof payload.reasoning_content === "string" ? payload.reasoning_content : undefined,
      },
      activated_skills: Array.isArray(payload.activated_skills) ? payload.activated_skills : [],
      extended_content: Array.isArray(payload.extended_content) ? payload.extended_content : [],
      critic_result: payload.critic_result ?? undefined,
    } as unknown as OpenHandsEvent;
  }

  if (event.kind === "ActionEvent") {
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";
    const action = isRecord(payload.action) ? payload.action : { kind: "UnknownAction" };
    return {
      id: event.id,
      timestamp: event.occurredAt,
      source: "agent",
      thought: Array.isArray(payload.thought) ? payload.thought : [],
      reasoning_content: typeof payload.reasoning_content === "string" ? payload.reasoning_content : null,
      thinking_blocks: Array.isArray(payload.thinking_blocks) ? payload.thinking_blocks : [],
      action,
      tool_name: toolName,
      tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : event.id,
      tool_call: isRecord(payload.tool_call)
        ? payload.tool_call
        : {
            id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : event.id,
            type: "function",
            function: { name: toolName, arguments: "{}" },
          },
      llm_response_id: typeof payload.llm_response_id === "string" ? payload.llm_response_id : event.id,
      security_risk: typeof payload.security_risk === "string" ? payload.security_risk : "UNKNOWN",
      critic_result: payload.critic_result ?? undefined,
    } as unknown as OpenHandsEvent;
  }

  if (event.kind === "ObservationEvent") {
    const observation = isRecord(payload.observation) ? payload.observation : { kind: "UnknownObservation" };
    return {
      id: event.id,
      timestamp: event.occurredAt,
      source: "environment",
      tool_name: typeof payload.tool_name === "string" ? payload.tool_name : "unknown",
      tool_call_id: typeof payload.tool_call_id === "string" ? payload.tool_call_id : "unknown",
      action_id: typeof payload.action_id === "string" ? payload.action_id : "",
      observation,
    } as unknown as OpenHandsEvent;
  }

  // Unrecognized `kind` (e.g. fixture 9 / a future SDK event AtherNull's own
  // parser doesn't know about yet): pass through as a minimal BaseEvent so
  // `isBaseEvent()` (vendor/openhands/types/agent-server/type-guards.ts)
  // still accepts it, and let the vendored renderer's own fallback path
  // decide what to show, instead of this adapter guessing.
  //
  // GENUINE FINDING (see MANIFEST.md "Adapter discovery: UserAssistantEventMessage
  // is not fully defensive" row): `event-message.tsx`'s final branch
  // (`!isActionEvent(event) && !isObservationEvent(event)`) treats ANY event
  // that isn't structurally an action or observation as a `MessageEvent` and
  // renders it via `UserAssistantEventMessage`, which reads
  // `event.llm_message.content` with NO guard on `llm_message` itself being
  // present (only `parseMessageFromEvent` guards `.content`). A truly
  // unrecognized event with no `llm_message` field at all — which is exactly
  // what a real "future SDK event kind" would look like — crashes that
  // component (`next build` reproduces this as a prerender TypeError; caught
  // while building this harness, not a pre-existing test in the upstream
  // repo). This is a real latent fragility in the unmodified vendored file,
  // not something this spike introduced — worked around here, in the
  // adapter, by always supplying a syntactically-valid empty `llm_message`
  // rather than patching vendor/openhands/... code.
  return {
    id: event.id,
    timestamp: event.occurredAt,
    source: "agent",
    llm_message: { role: "assistant", content: [] },
    activated_skills: [],
    extended_content: [],
    ...payload,
  } as unknown as OpenHandsEvent;
}

export function executionEventsToOpenHandsEvents(events: ExecutionEvent[]): OpenHandsEvent[] {
  return events.map(executionEventToOpenHandsEvent);
}
