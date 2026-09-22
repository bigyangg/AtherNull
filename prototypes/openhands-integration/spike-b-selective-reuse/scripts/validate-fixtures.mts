/**
 * Throwaway validation script (not part of the Next.js app build — nothing
 * under `app/` imports it, and it lives outside `vendor/openhands/`).
 *
 * Validates that both fixture sets (`lib/fixtures/execution-events.synthetic.ts`
 * and `lib/fixtures/execution-events.upstream-real.ts`) parse the way the
 * REAL AtherNull `apps/web/lib/execution-events.ts` parser expects.
 *
 * Per the task brief's step 4d, this copies `parseMessage` / `parseToolCall`
 * / `pairActionsWithObservations` VERBATIM (byte-for-byte, unmodified logic)
 * from `apps/web/lib/execution-events.ts` rather than importing that file
 * directly — a plain relative import would need `apps/web`'s own
 * `@/lib/types` path alias, which only resolves inside `apps/web`'s own
 * tsconfig/Next build, not from a standalone script in this fully-isolated
 * harness. The real file at `apps/web/lib/execution-events.ts` was NOT
 * edited to make this work — this script is read-only w.r.t. that file, and
 * this comment is the record of the exact copy that was made and when.
 *
 * Run with: `npm run validate-fixtures` (uses `tsx`).
 */
import {
  SYNTHETIC_EXECUTION_EVENTS,
  SYNTHETIC_EXECUTION_EVENTS_LIST,
} from "../lib/fixtures/execution-events.synthetic.ts";
import {
  UPSTREAM_REAL_EVENTS,
  UPSTREAM_REAL_EVENTS_LIST,
} from "../lib/fixtures/execution-events.upstream-real.ts";
import type { ExecutionEvent } from "../lib/fixtures/execution-events.synthetic.ts";

// ---------------------------------------------------------------------------
// BEGIN verbatim copy from apps/web/lib/execution-events.ts (read-only source
// — see file-level comment above). Do not "improve" this copy independently
// of the real file; if the real parser changes, re-copy it here.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const first = content.find((item) => isRecord(item) && typeof item.text === "string");
  return isRecord(first) ? (first.text as string) : null;
}

interface ParsedMessage {
  role: "user" | "agent";
  text: string;
  reasoning: string | null;
}

function parseMessage(event: ExecutionEvent): ParsedMessage | null {
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

interface ParsedTerminalAction {
  tool: "terminal";
  command: string;
  output: string | null;
  exitCode: number | null;
  isError: boolean;
}

interface ParsedFileEdit {
  tool: "file_editor";
  path: string;
  command: string;
  oldStr: string | null;
  newStr: string | null;
  fileText: string | null;
  summary: string | null;
}

interface ParsedOtherAction {
  tool: "other";
  toolName: string;
  summary: string | null;
}

type ParsedToolCall = ParsedTerminalAction | ParsedFileEdit | ParsedOtherAction;

function parseToolCall(action: ExecutionEvent, observation?: ExecutionEvent): ParsedToolCall | null {
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

function pairActionsWithObservations(
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

// ---------------------------------------------------------------------------
// END verbatim copy
// ---------------------------------------------------------------------------

let failures = 0;
let passes = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passes += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}

console.log("=== Synthetic fixtures ===");
{
  const f = SYNTHETIC_EXECUTION_EVENTS;

  const userMsg = parseMessage(f.userMessage);
  check("userMessage parses", userMsg?.role === "user" && userMsg.text.includes("health-check"));

  const agentMsg = parseMessage(f.agentMessageWithReasoning);
  check(
    "agentMessageWithReasoning parses with reasoning",
    agentMsg?.role === "agent" && !!agentMsg.reasoning && agentMsg.reasoning.length > 0,
  );

  const term1 = parseToolCall(f.terminalSuccess, f.terminalSuccessObservation);
  check(
    "terminalSuccess parses exit_code 0, not error",
    term1?.tool === "terminal" && term1.exitCode === 0 && term1.isError === false,
    term1,
  );

  const term2 = parseToolCall(f.terminalError, f.terminalErrorObservation);
  check(
    "terminalError parses exit_code 1, is error",
    term2?.tool === "terminal" && term2.exitCode === 1 && term2.isError === true,
    term2,
  );

  const edit1 = parseToolCall(f.fileEditStrReplace, f.fileEditStrReplaceObservation);
  check(
    "fileEditStrReplace parses str_replace with summary",
    edit1?.tool === "file_editor" && edit1.command === "str_replace" && !!edit1.summary,
    edit1,
  );

  const edit2 = parseToolCall(f.fileEditCreate, f.fileEditCreateObservation);
  check(
    "fileEditCreate parses create with fileText",
    edit2?.tool === "file_editor" && edit2.command === "create" && !!edit2.fileText,
    edit2,
  );

  const other = parseToolCall(f.unrecognizedToolAction);
  check(
    "unrecognizedToolAction falls back to 'other' tool",
    other?.tool === "other" && other.toolName === "deploy_preview_environment",
    other,
  );

  const finish = parseMessage(f.finishAction);
  check(
    "finishAction parses as an agent message",
    finish?.role === "agent" && finish.text.includes("health"),
    finish,
  );

  const malformedMsg = parseMessage(f.malformedUnknownKind);
  const malformedTool = parseToolCall(f.malformedUnknownKind);
  check(
    "malformedUnknownKind parses to null (not throw) for both parsers",
    malformedMsg === null && malformedTool === null,
    { malformedMsg, malformedTool },
  );

  const paired = pairActionsWithObservations(SYNTHETIC_EXECUTION_EVENTS_LIST);
  const pairedTerminal = paired.find((p) => p.action.id === "syn-3-terminal-action");
  check(
    "pairActionsWithObservations pairs terminal action 3 with its observation",
    pairedTerminal?.observation?.id === "syn-3-terminal-observation",
    pairedTerminal,
  );
}

console.log("\n=== Upstream-real fixtures ===");
{
  const f = UPSTREAM_REAL_EVENTS;

  const userMsg = parseMessage(f.canvasDemoUserMessage);
  check(
    "canvasDemoUserMessage (genuine, canvas-demo-conversation.ts) parses",
    userMsg?.role === "user" && userMsg.text.includes("project canvas"),
    userMsg,
  );

  const agentMsg = parseMessage(f.canvasDemoAgentMessage);
  check(
    "canvasDemoAgentMessage (genuine) parses",
    agentMsg?.role === "agent" && agentMsg.text.includes("file chip"),
    agentMsg,
  );

  const fileEdit = parseToolCall(f.canvasDemoFileEditorAction, f.canvasDemoFileEditorObservation);
  check(
    "canvasDemoFileEditorAction+Observation (genuine) parses as file_editor create",
    fileEdit?.tool === "file_editor" && fileEdit.command === "create",
    fileEdit,
  );
  // Documented, not "fixed": real upstream FileEditorObservation has no
  // `content` array (only `output`) for a `create` command, so AtherNull's
  // parser (which reads `content` for `summary`) gets null here even though
  // there IS a human-readable message in `output`. See the fixture file's
  // comment on this entry.
  check(
    "canvasDemoFileEditorObservation's summary is null (parser reads `content`, real payload only sets `output`) — documented gap, not a crash",
    fileEdit?.tool === "file_editor" && fileEdit.summary === null,
    fileEdit,
  );

  const tableMsg = parseMessage(f.tableDemoAgentMessage);
  check(
    "tableDemoAgentMessage (genuine, table-demo-conversation.ts) parses",
    tableMsg?.role === "agent" && tableMsg.text.includes("wide comparison table"),
    tableMsg,
  );

  const partial = parseToolCall(f.partialMalformedAction);
  check(
    "partialMalformedAction (genuine, get-event-content.test.tsx) does not throw, falls back to 'other'",
    partial?.tool === "other",
    partial,
  );

  const term = parseToolCall(f.handConstructedTerminalAction, f.handConstructedTerminalObservation);
  check(
    "handConstructedTerminalAction+Observation parses (ExecuteBashAction falls back to 'other' tool — AtherNull's parser only special-cases TerminalAction, not ExecuteBashAction)",
    term?.tool === "other",
    term,
  );

  const finish = parseMessage(f.handConstructedFinishAction);
  check(
    "handConstructedFinishAction parses as an agent message",
    finish?.role === "agent" && finish.text.includes("comparison table"),
    finish,
  );

  const paired = pairActionsWithObservations(UPSTREAM_REAL_EVENTS_LIST);
  const pairedCanvas = paired.find((p) => p.action.id === "canvas-demo-action");
  check(
    "pairActionsWithObservations pairs the genuine canvas-demo action+observation",
    pairedCanvas?.observation?.id === "canvas-demo-observation",
    pairedCanvas,
  );
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) {
  process.exitCode = 1;
}
