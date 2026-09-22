/**
 * Locally-duplicated `ExecutionEvent` type, copied from `apps/web/lib/types.ts`
 * (AtherNull's real Agent Server event-stream row shape) so this harness has
 * no cross-import into the rest of the AtherNull repo (per the spike's
 * isolation rule) and can be built/deployed fully standalone.
 *
 * DO NOT edit `apps/web/lib/types.ts` to keep this in sync — if that shape
 * changes, this file needs a manual update. That drift risk is itself a
 * property of "selective reuse" worth recording: adapter code duplicated
 * across a repo boundary has no compiler-enforced link back to its source
 * of truth.
 */
export interface ExecutionEvent {
  id: string;
  executionId: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
  createdAt: string;
}

const EXEC_ID = "exec-synthetic-0001";
const t = (offsetSeconds: number) =>
  new Date(Date.UTC(2026, 8, 1, 12, 0, 0) + offsetSeconds * 1000).toISOString();

/**
 * 9 synthetic `ExecutionEvent` fixtures, authored to match the real Agent
 * Server payload shapes documented in `apps/web/lib/execution-events.ts`
 * (MessageEvent / ActionEvent / ObservationEvent with SDK-shaped `action`/
 * `observation` bodies) — not copied from anywhere, purpose-built to cover
 * the 9 required cases.
 */
export const SYNTHETIC_EXECUTION_EVENTS: Record<string, ExecutionEvent> = {
  // 1. User message
  userMessage: {
    id: "syn-1-user-message",
    executionId: EXEC_ID,
    kind: "MessageEvent",
    occurredAt: t(0),
    createdAt: t(0),
    payload: {
      source: "user",
      llm_message: {
        role: "user",
        content: [{ type: "text", text: "Add a health-check endpoint to the API." }],
      },
      activated_skills: [],
      extended_content: [],
    },
  },

  // 2. Agent message with reasoning_content set
  agentMessageWithReasoning: {
    id: "syn-2-agent-message-reasoning",
    executionId: EXEC_ID,
    kind: "MessageEvent",
    occurredAt: t(2),
    createdAt: t(2),
    payload: {
      source: "agent",
      llm_message: {
        role: "assistant",
        content: [{ type: "text", text: "I'll add a GET /health route returning 200 OK." }],
      },
      reasoning_content:
        "The task asks for a health-check endpoint; the simplest correct approach is a route with no dependencies so it reflects process liveness, not downstream health.",
      activated_skills: [],
      extended_content: [],
    },
  },

  // 3. Terminal action + success observation (exit_code: 0)
  terminalSuccess: {
    id: "syn-3-terminal-action",
    executionId: EXEC_ID,
    kind: "ActionEvent",
    occurredAt: t(4),
    createdAt: t(4),
    payload: {
      tool_name: "terminal",
      thought: [],
      action: {
        kind: "TerminalAction",
        command: "npm run test -- health.test.ts",
        is_input: false,
        timeout: null,
        reset: false,
      },
    },
  },
  terminalSuccessObservation: {
    id: "syn-3-terminal-observation",
    executionId: EXEC_ID,
    kind: "ObservationEvent",
    occurredAt: t(6),
    createdAt: t(6),
    payload: {
      action_id: "syn-3-terminal-action",
      observation: {
        kind: "TerminalObservation",
        content: [{ type: "text", text: "PASS health.test.ts\n  ✓ GET /health returns 200 (4ms)" }],
        command: "npm run test -- health.test.ts",
        exit_code: 0,
        is_error: false,
        timeout: false,
      },
    },
  },

  // 4. Terminal action + error observation (exit_code: 1, is_error: true)
  terminalError: {
    id: "syn-4-terminal-action",
    executionId: EXEC_ID,
    kind: "ActionEvent",
    occurredAt: t(8),
    createdAt: t(8),
    payload: {
      tool_name: "terminal",
      thought: [],
      action: {
        kind: "TerminalAction",
        command: "npm run lint",
        is_input: false,
        timeout: null,
        reset: false,
      },
    },
  },
  terminalErrorObservation: {
    id: "syn-4-terminal-observation",
    executionId: EXEC_ID,
    kind: "ObservationEvent",
    occurredAt: t(10),
    createdAt: t(10),
    payload: {
      action_id: "syn-4-terminal-action",
      observation: {
        kind: "TerminalObservation",
        content: [{ type: "text", text: "src/health.ts\n  3:1  error  Missing return type  @typescript-eslint/explicit-function-return-type" }],
        command: "npm run lint",
        exit_code: 1,
        is_error: true,
        timeout: false,
      },
    },
  },

  // 5. File-editor str_replace action + observation
  fileEditStrReplace: {
    id: "syn-5-file-editor-action",
    executionId: EXEC_ID,
    kind: "ActionEvent",
    occurredAt: t(12),
    createdAt: t(12),
    payload: {
      tool_name: "file_editor",
      thought: [],
      action: {
        // Deliberately "FileEditorAction", not the real SDK's parallel
        // "StrReplaceEditorAction" kind (see MANIFEST.md "Fixture sourcing /
        // parser gap" row): AtherNull's real `parseToolCall()`
        // (apps/web/lib/execution-events.ts) only special-cases
        // `actionBody.kind === "FileEditorAction"` — a real
        // `StrReplaceEditorAction` event falls through to its generic
        // "other" tool branch instead. This fixture exercises the branch
        // AtherNull's parser actually recognizes for `str_replace`.
        kind: "FileEditorAction",
        command: "str_replace",
        path: "/workspace/project/src/routes.ts",
        old_str: "app.get('/status', statusHandler);",
        new_str: "app.get('/status', statusHandler);\napp.get('/health', healthHandler);",
        file_text: null,
      },
    },
  },
  fileEditStrReplaceObservation: {
    id: "syn-5-file-editor-observation",
    executionId: EXEC_ID,
    kind: "ObservationEvent",
    occurredAt: t(13),
    createdAt: t(13),
    payload: {
      action_id: "syn-5-file-editor-action",
      observation: {
        kind: "FileEditorObservation",
        command: "str_replace",
        content: [{ type: "text", text: "The file /workspace/project/src/routes.ts has been edited." }],
        output: "The file /workspace/project/src/routes.ts has been edited.",
        path: "/workspace/project/src/routes.ts",
        prev_exist: true,
      },
    },
  },

  // 6. File-editor create action + observation
  fileEditCreate: {
    id: "syn-6-file-editor-action",
    executionId: EXEC_ID,
    kind: "ActionEvent",
    occurredAt: t(15),
    createdAt: t(15),
    payload: {
      tool_name: "file_editor",
      thought: [],
      action: {
        kind: "FileEditorAction",
        command: "create",
        path: "/workspace/project/src/health.ts",
        file_text:
          "export function healthHandler(_req, res) {\n  res.status(200).json({ status: \"ok\" });\n}\n",
        old_str: null,
        new_str: null,
      },
    },
  },
  fileEditCreateObservation: {
    id: "syn-6-file-editor-observation",
    executionId: EXEC_ID,
    kind: "ObservationEvent",
    occurredAt: t(16),
    createdAt: t(16),
    payload: {
      action_id: "syn-6-file-editor-action",
      observation: {
        kind: "FileEditorObservation",
        command: "create",
        content: [{ type: "text", text: "Created /workspace/project/src/health.ts" }],
        output: "Created /workspace/project/src/health.ts",
        path: "/workspace/project/src/health.ts",
        prev_exist: false,
      },
    },
  },

  // 7. Action with an unrecognized tool name
  unrecognizedToolAction: {
    id: "syn-7-unrecognized-tool-action",
    executionId: EXEC_ID,
    kind: "ActionEvent",
    occurredAt: t(18),
    createdAt: t(18),
    payload: {
      tool_name: "deploy_preview_environment",
      thought: [],
      action: {
        kind: "DeployPreviewEnvironmentAction",
        environment: "staging",
      },
    },
  },

  // 8. Finish action
  finishAction: {
    id: "syn-8-finish-action",
    executionId: EXEC_ID,
    kind: "ActionEvent",
    occurredAt: t(20),
    createdAt: t(20),
    payload: {
      tool_name: "finish",
      thought: [],
      reasoning_content: "All acceptance criteria are met: tests pass, lint is clean.",
      action: {
        kind: "FinishAction",
        message: "Added the /health endpoint with a passing test and clean lint run.",
      },
    },
  },

  // 9. Malformed / unknown-kind event
  malformedUnknownKind: {
    id: "syn-9-malformed",
    executionId: EXEC_ID,
    kind: "SomeFutureSDKEventKind",
    occurredAt: t(22),
    createdAt: t(22),
    payload: {
      unexpected_field: "this event kind does not exist yet in AtherNull's parser",
      nested: { a: 1, b: [1, 2, 3] },
    },
  },
};

export const SYNTHETIC_EXECUTION_EVENTS_LIST: ExecutionEvent[] = Object.values(
  SYNTHETIC_EXECUTION_EVENTS,
);
