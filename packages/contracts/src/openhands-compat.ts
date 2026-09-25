import { z } from "zod";

import { TaskStatusSchema, type TaskStatus } from "./tasks.js";

// Production typed contract for the OpenHands-compatible read surface
// (apps/api/src/routes/openhands-compat.ts), per
// docs/openhands-workspace-integration-phase1-design.md §3/§4. Shapes here
// mirror OpenHands' own AppConversation/OpenHandsEvent wire types (transcribed,
// not imported — see the prototype's spike-c-full-shell-adapter/adapter-server/
// src/mapping.ts header comment for why upstream/ isn't importable), but this
// module is this package's own typed contract, following the same
// `XSchema` + `type X = z.infer<typeof XSchema>` convention as jobs.ts/tasks.ts.

// --- Status/verification tag grammar (design doc §4 "Exact typed
// status/verification transport") ------------------------------------------
//
// The prototype used a free-form, unparseable string tag. Production instead
// rides on AppConversation.tags (a Record<string,string> — the one OpenHands
// field confirmed to render arbitrary AtherNull-originated values as chips)
// with a strict, versioned, round-trippable grammar:
//   athernull:task-status:${TaskStatus}
//   athernull:verification:${"PASS"|"FAIL"}
// A conversation carries at most one of each. Parsing is strict: anything not
// matching exactly is ignored (not coerced, not thrown) — other tags present
// in the array may be legitimate OpenHands-native ones this parser has no
// business touching.

const TASK_STATUS_TAG_PREFIX = "athernull:task-status:";
const VERIFICATION_TAG_PREFIX = "athernull:verification:";

export type AtherNullVerificationOutcome = "PASS" | "FAIL";

export function serializeAtherNullTags(
  taskStatus: TaskStatus,
  verificationOutcome?: AtherNullVerificationOutcome | null,
): string[] {
  const tags = [`${TASK_STATUS_TAG_PREFIX}${taskStatus}`];
  if (verificationOutcome) {
    tags.push(`${VERIFICATION_TAG_PREFIX}${verificationOutcome}`);
  }
  return tags;
}

export function parseAtherNullTags(tags: string[]): {
  taskStatus: TaskStatus | null;
  verificationOutcome: AtherNullVerificationOutcome | null;
} {
  let taskStatus: TaskStatus | null = null;
  let verificationOutcome: AtherNullVerificationOutcome | null = null;

  for (const tag of tags) {
    if (tag.startsWith(TASK_STATUS_TAG_PREFIX)) {
      const suffix = tag.slice(TASK_STATUS_TAG_PREFIX.length);
      const parsed = TaskStatusSchema.safeParse(suffix);
      // An unrecognized suffix (e.g. "BOGUS") is a parse failure, not a
      // guessed/coerced status — leave taskStatus as-is (null, or whatever a
      // prior valid tag already set) rather than accepting it.
      if (parsed.success) {
        taskStatus = parsed.data;
      }
      continue;
    }
    if (tag.startsWith(VERIFICATION_TAG_PREFIX)) {
      const suffix = tag.slice(VERIFICATION_TAG_PREFIX.length);
      if (suffix === "PASS" || suffix === "FAIL") {
        verificationOutcome = suffix;
      }
      continue;
    }
    // Anything else may be a legitimate OpenHands-native tag — ignored, not
    // an error.
  }

  return { taskStatus, verificationOutcome };
}

// --- AppConversation (OpenHands wire shape, transcribed) -------------------

export const OpenHandsGitProviderSchema = z.enum(["github", "gitlab", "bitbucket"]);
export type OpenHandsGitProvider = z.infer<typeof OpenHandsGitProviderSchema>;

export const OpenHandsExecutionStatusSchema = z.enum([
  "idle",
  "running",
  "paused",
  "waiting_for_confirmation",
  "finished",
  "error",
  "stuck",
]);
export type OpenHandsExecutionStatus = z.infer<typeof OpenHandsExecutionStatusSchema>;

export const AppConversationSchema = z.object({
  id: z.string(),
  created_by_user_id: z.string().nullable(),
  selected_repository: z.string().nullable(),
  selected_branch: z.string().nullable(),
  git_provider: OpenHandsGitProviderSchema.nullable(),
  title: z.string().nullable(),
  trigger: z.string().nullable(),
  pr_number: z.array(z.number()),
  agent_kind: z.enum(["openhands", "acp"]).nullable(),
  // A tags array OpenHands' own UI renders generically as chips (design doc
  // §4 "Exact typed status/verification transport" — this supersedes an
  // earlier, incorrect Record<string,string> assumption from the
  // prototype). Populated via serializeAtherNullTags/parseAtherNullTags
  // above, using the `athernull:task-status:*` / `athernull:verification:*`
  // grammar.
  tags: z.array(z.string()).optional(),
  llm_model: z.string().nullable(),
  metrics: z.null(),
  created_at: z.string(),
  updated_at: z.string(),
  execution_status: OpenHandsExecutionStatusSchema,
  conversation_url: z.string().nullable(),
  // NEVER populated with a real value by this route layer — see
  // apps/api/src/routes/openhands-compat.ts's header comment. Always null.
  session_api_key: z.string().nullable(),
  sandbox_id: z.string().nullable(),
  workspace: z.object({ working_dir: z.string().nullable() }).nullable(),
  sub_conversation_ids: z.array(z.string()),
  public: z.boolean(),
});
export type AppConversation = z.infer<typeof AppConversationSchema>;

export const AppConversationPageSchema = z.object({
  items: z.array(AppConversationSchema),
  next_page_id: z.string().nullable(),
});
export type AppConversationPage = z.infer<typeof AppConversationPageSchema>;

// --- OpenHandsEvent (loosely typed passthrough, transcribed) ---------------

export const OpenHandsEventSourceSchema = z.enum(["agent", "user", "environment", "hook"]);
export type OpenHandsEventSource = z.infer<typeof OpenHandsEventSourceSchema>;

// OpenHands' real event union has many kind-specific shapes (MessageEvent,
// ActionEvent, ObservationEvent, CondensationEvent, ...) beyond the base
// {id, timestamp, source} fields every kind shares — modeled here as a
// passthrough object rather than re-deriving the full union, matching the
// prototype's own `OpenHandsEventBase & Record<string, unknown>` shape.
export const OpenHandsEventSchema = z
  .object({
    id: z.string(),
    timestamp: z.string(),
    source: OpenHandsEventSourceSchema,
  })
  .passthrough();
export type OpenHandsEvent = z.infer<typeof OpenHandsEventSchema>;

export const OpenHandsEventPageSchema = z.object({
  items: z.array(OpenHandsEventSchema),
  next_page_id: z.string().nullable(),
});
export type OpenHandsEventPage = z.infer<typeof OpenHandsEventPageSchema>;

// --- /api/settings, /server_info (static/local-only, design doc §4) --------

export const OpenHandsSettingsResponseSchema = z.object({
  agent_settings: z.record(z.string(), z.unknown()),
  conversation_settings: z.record(z.string(), z.unknown()),
  llm_api_key_is_set: z.boolean(),
  misc_settings: z.object({
    app_preferences: z.record(z.string(), z.unknown()),
  }),
});
export type OpenHandsSettingsResponse = z.infer<typeof OpenHandsSettingsResponseSchema>;

// PATCH /api/settings request body (settings-service.api.ts's updateSettings()
// shape) — local-only stub, never forwarded to any AtherNull mutation.
export const PatchOpenHandsSettingsRequestSchema = z.object({
  misc_settings_diff: z
    .object({
      app_preferences: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type PatchOpenHandsSettingsRequest = z.infer<typeof PatchOpenHandsSettingsRequestSchema>;

export const OpenHandsServerInfoResponseSchema = z.object({
  uptime: z.number(),
  idle_time: z.number(),
  title: z.string(),
  version: z.string(),
});
export type OpenHandsServerInfoResponse = z.infer<typeof OpenHandsServerInfoResponseSchema>;
