// Defensive parsers over the OpenHands Agent Server's own event payload
// shapes — confirmed from real captured events this session (see
// docs/adr/0005-agent-server-execution-isolation.md's neighboring work), not
// a contract AtherNull controls. Every parser returns null on an
// unrecognized shape rather than throwing, since a future SDK version could
// change these at any time.
import type { ExecutionEvent } from "@/lib/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const first = content.find((item) => isRecord(item) && typeof item.text === "string");
  return isRecord(first) ? (first.text as string) : null;
}

export interface ParsedMessage {
  role: "user" | "agent";
  text: string;
  reasoning: string | null;
}

// MessageEvent: { source: "user" | "agent", llm_message: { content: [{text}] }, reasoning_content }
// FinishAction (an ActionEvent, tool_name "finish"): the agent's closing
// summary to the user — semantically a message, just not modeled as a
// MessageEvent by the SDK, so it needs its own branch here rather than
// silently dropping out of the conversation feed.
export function parseMessage(event: ExecutionEvent): ParsedMessage | null {
  if (!isRecord(event.payload)) return null;
  const payload = event.payload;

  if (event.kind === "MessageEvent") {
    const llmMessage = payload.llm_message;
    if (!isRecord(llmMessage)) return null;
    const text = firstText(llmMessage.content);
    if (text === null) return null;
    const role = payload.source === "user" ? "user" : "agent";
    const reasoning = typeof payload.reasoning_content === "string" ? payload.reasoning_content : null;
    return { role, text, reasoning };
  }

  if (event.kind === "ActionEvent" && isRecord(payload.action) && payload.action.kind === "FinishAction") {
    const text = typeof payload.action.message === "string" ? payload.action.message : null;
    if (text === null) return null;
    const reasoning = typeof payload.reasoning_content === "string" ? payload.reasoning_content : null;
    return { role: "agent", text, reasoning };
  }

  return null;
}

export interface ParsedTerminalAction {
  tool: "terminal";
  command: string;
  output: string | null;
  exitCode: number | null;
  isError: boolean;
}

export interface ParsedFileEdit {
  tool: "file_editor";
  path: string;
  command: string; // "view" | "str_replace" | "create" | "insert" | "undo_edit" | ...
  oldStr: string | null;
  newStr: string | null;
  fileText: string | null;
  summary: string | null; // the human-readable observation text, once paired
}

export interface ParsedOtherAction {
  tool: "other";
  toolName: string;
  summary: string | null;
}

export type ParsedToolCall = ParsedTerminalAction | ParsedFileEdit | ParsedOtherAction;

// Reads an ActionEvent, optionally paired with the ObservationEvent that
// followed it (matched by action_id === action's own id — see
// pairActionsWithObservations below).
export function parseToolCall(action: ExecutionEvent, observation?: ExecutionEvent): ParsedToolCall | null {
  if (action.kind !== "ActionEvent" || !isRecord(action.payload)) return null;
  const payload = action.payload;
  const actionBody = payload.action;
  if (!isRecord(actionBody)) return null;
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown";

  const obs = observation && isRecord(observation.payload) ? observation.payload.observation : null;
  const obsBody = isRecord(obs) ? obs : null;

  if (actionBody.kind === "TerminalAction" && typeof actionBody.command === "string") {
    return {
      tool: "terminal",
      command: actionBody.command,
      output: obsBody ? firstText(obsBody.content) : null,
      exitCode: obsBody && typeof obsBody.exit_code === "number" ? obsBody.exit_code : null,
      isError: obsBody?.is_error === true,
    };
  }

  if (actionBody.kind === "FileEditorAction" && typeof actionBody.path === "string") {
    return {
      tool: "file_editor",
      path: actionBody.path,
      command: typeof actionBody.command === "string" ? actionBody.command : "unknown",
      oldStr: typeof actionBody.old_str === "string" ? actionBody.old_str : null,
      newStr: typeof actionBody.new_str === "string" ? actionBody.new_str : null,
      fileText: typeof actionBody.file_text === "string" ? actionBody.file_text : null,
      summary: obsBody ? firstText(obsBody.content) : null,
    };
  }

  return {
    tool: "other",
    toolName,
    summary: typeof payload.summary === "string" ? payload.summary : null,
  };
}

// ObservationEvent.action_id points back at the ActionEvent it resulted
// from (confirmed from a real captured pair this session) — this pairs them
// up so a renderer never has to hunt for a match itself.
export function pairActionsWithObservations(
  events: ExecutionEvent[],
): { action: ExecutionEvent; observation: ExecutionEvent | undefined }[] {
  const observationsByActionId = new Map<string, ExecutionEvent>();
  for (const event of events) {
    if (event.kind !== "ObservationEvent" || !isRecord(event.payload)) continue;
    const actionId = event.payload.action_id;
    if (typeof actionId === "string") observationsByActionId.set(actionId, event);
  }
  return events
    .filter((event) => event.kind === "ActionEvent")
    .map((action) => ({ action, observation: observationsByActionId.get(action.id) }));
}
