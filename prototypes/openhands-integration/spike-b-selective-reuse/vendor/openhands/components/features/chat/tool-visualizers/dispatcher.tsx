import type { ReactNode } from "react";
import type { ActionEvent, OpenHandsEvent } from "#/types/agent-server/core";
import {
  isActionEvent,
  isObservationEvent,
} from "#/types/agent-server/type-guards";
import { fileEditorVisualizer } from "./file-editor/file-editor";

/**
 * SPIKE-B MODIFIED (see MANIFEST.md "tool-visualizers dispatcher" row).
 *
 * Upstream's real `resolveVisualizerBody` looks up a per-tool-kind React
 * visualizer registered in `./index` (`actionVisualizers` /
 * `observationVisualizers`), which fans out into `./bash/`, `./file-editor/`,
 * `./search/`, `./task/` — each its own multi-file directory with its own
 * icons/i18n/utils. Spike B originally stubbed this to always return `null`
 * (falling back to the markdown pipeline for every tool call) rather than
 * double the vendored-file count for visualizers no fixture exercised.
 *
 * Spike F needs a real, distinct file-diff view for FileEditorAction/
 * FileEditorObservation/StrReplaceEditorAction/StrReplaceEditorObservation
 * events (populated with real old_content/new_content by the Phase 1 adapter
 * mapping fix), so this dispatcher now special-cases those four kinds and
 * calls the newly-vendored, real, unmodified `fileEditorVisualizer.Body`
 * directly — bypassing upstream's `./index` registry/`bash`/`search`/`task`
 * machinery entirely (per the task brief's explicit "call the Body directly"
 * option) rather than vendoring the full dispatch mechanism for tool kinds
 * this spike doesn't need. Terminal (bash) events are NOT routed through
 * here — Spike B/C both render those via the separate Terminal/xterm panel,
 * not the chat tool-visualizer path, so `bashVisualizer` was never vendored.
 * Every other tool kind still returns `null` and falls back to markdown,
 * exactly as upstream's own doc comment specifies for an unregistered kind.
 */
export function resolveVisualizerBody(
  event: OpenHandsEvent,
  correspondingAction?: ActionEvent,
): ReactNode | null {
  const FILE_EDITOR_ACTION_KINDS = new Set([
    "FileEditorAction",
    "StrReplaceEditorAction",
  ]);
  const FILE_EDITOR_OBSERVATION_KINDS = new Set([
    "FileEditorObservation",
    "StrReplaceEditorObservation",
  ]);

  if (isActionEvent(event) && FILE_EDITOR_ACTION_KINDS.has(event.action.kind)) {
    const Body = fileEditorVisualizer.Body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return <Body action={event as any} />;
  }

  if (
    isObservationEvent(event) &&
    FILE_EDITOR_OBSERVATION_KINDS.has(event.observation.kind)
  ) {
    const Body = fileEditorVisualizer.Body;
    return (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Body action={correspondingAction as any} observation={event as any} />
    );
  }

  return null;
}
