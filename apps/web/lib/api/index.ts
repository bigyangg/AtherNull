import { mockApi } from "@/lib/api/mock";
import type { WorkspaceApi } from "@/lib/api/types";

// Swap this one line for a `fetch`-based client against apps/api once
// Phase 1's job endpoints exist (see PLAN.md). Nothing else in the app
// should import lib/api/mock.ts directly.
export const api: WorkspaceApi = mockApi;

export type { CreateProjectInput, WorkspaceApi } from "@/lib/api/types";
