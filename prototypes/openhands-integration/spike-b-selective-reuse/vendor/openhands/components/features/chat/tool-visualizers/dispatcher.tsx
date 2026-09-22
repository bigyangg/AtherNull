import type { ReactNode } from "react";
import type { ActionEvent, OpenHandsEvent } from "#/types/agent-server/core";

/**
 * SPIKE-B STUB (see MANIFEST.md "tool-visualizers dispatcher" row).
 *
 * Upstream's `resolveVisualizerBody` looks up a per-tool-kind React
 * visualizer registered in `./index` (`actionVisualizers` /
 * `observationVisualizers`), which fans out into `./bash/`, `./file-editor/`,
 * `./search/`, `./task/` — each its own multi-file directory with its own
 * icons/i18n/utils. That subtree renders the specialized diff/terminal-style
 * bodies for bash + file-editor tool calls (exactly the fixtures this spike
 * needs — terminal + file-editor actions), but vendoring it would roughly
 * double the file count pulled in by this "2 components" reuse attempt.
 *
 * Upstream's own dispatcher.tsx already documents the fallback this stub
 * exercises unconditionally: "Returns ... `null` to tell the caller to fall
 * back to the markdown pipeline." Every caller in this harness
 * (`get-action-content.ts`, `get-observation-content.ts`) already handles a
 * null return by rendering the observation/action content as markdown
 * instead, so this is a real, upstream-intended degradation path, not a
 * hack — it just means terminal/file-editor bodies in this harness render as
 * plain text instead of the specialized diff/ANSI-aware visualizer.
 */
export function resolveVisualizerBody(
  _event: OpenHandsEvent,
  _correspondingAction?: ActionEvent,
): ReactNode | null {
  return null;
}
