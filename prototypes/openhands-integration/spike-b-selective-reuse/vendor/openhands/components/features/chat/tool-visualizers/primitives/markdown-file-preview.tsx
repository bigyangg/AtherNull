/**
 * SPIKE-B PARTIAL VENDOR (see MANIFEST.md "markdown-file-preview predicate"
 * row). Upstream's `markdown-file-preview.tsx` also exports a
 * `MarkdownFilePreview` UI component (206 lines) that pulls in
 * `plan-components.tsx`, `Typography`, `lucide-react`'s `ArrowUpRight`, an
 * `?react` icon import, and i18n. No vendored caller in this harness renders
 * that component (`generic-event-message-wrapper.tsx` only calls
 * `isMarkdownFileEditorEvent`, and `group-events.ts` only needs it too), so
 * only the pure path/command-resolution predicates are reproduced here,
 * verbatim from upstream. `plan-components.tsx` was therefore never vendored.
 */
import type {
  ActionEvent,
  ObservationEvent,
  OpenHandsEvent,
} from "#/types/agent-server/core";
import {
  isActionEvent,
  isObservationEvent,
} from "#/types/agent-server/type-guards";
import type {
  FileEditorAction,
  StrReplaceEditorAction,
} from "#/types/agent-server/core/base/action";
import type {
  FileEditorObservation,
  StrReplaceEditorObservation,
} from "#/types/agent-server/core/base/observation";
import { isMarkdownFilePath } from "#/utils/is-markdown-file-path";

export { isMarkdownFilePath } from "#/utils/is-markdown-file-path";

const FILE_EDITOR_ACTION_KINDS = new Set([
  "FileEditorAction",
  "StrReplaceEditorAction",
]);
const FILE_EDITOR_OBSERVATION_KINDS = new Set([
  "FileEditorObservation",
  "StrReplaceEditorObservation",
]);

function getFileEditorEventPath(
  event: OpenHandsEvent,
  correspondingAction?: ActionEvent,
): string | null {
  if (isActionEvent(event) && FILE_EDITOR_ACTION_KINDS.has(event.action.kind)) {
    return (
      (event as ActionEvent<FileEditorAction | StrReplaceEditorAction>).action
        .path || null
    );
  }

  if (
    isObservationEvent(event) &&
    FILE_EDITOR_OBSERVATION_KINDS.has(event.observation.kind)
  ) {
    const path = (
      event as ObservationEvent<
        FileEditorObservation | StrReplaceEditorObservation
      >
    ).observation.path;
    if (path) return path;
    if (
      correspondingAction &&
      FILE_EDITOR_ACTION_KINDS.has(correspondingAction.action.kind)
    ) {
      return (
        (
          correspondingAction as ActionEvent<
            FileEditorAction | StrReplaceEditorAction
          >
        ).action.path || null
      );
    }
  }

  return null;
}

function getFileEditorEventCommand(
  event: OpenHandsEvent,
  correspondingAction?: ActionEvent,
): string | null {
  if (isActionEvent(event) && FILE_EDITOR_ACTION_KINDS.has(event.action.kind)) {
    return (
      (event as ActionEvent<FileEditorAction | StrReplaceEditorAction>).action
        .command || null
    );
  }

  if (
    isObservationEvent(event) &&
    FILE_EDITOR_OBSERVATION_KINDS.has(event.observation.kind)
  ) {
    const command = (
      event as ObservationEvent<
        FileEditorObservation | StrReplaceEditorObservation
      >
    ).observation.command;
    if (command) return command;
    if (
      correspondingAction &&
      FILE_EDITOR_ACTION_KINDS.has(correspondingAction.action.kind)
    ) {
      return (
        (
          correspondingAction as ActionEvent<
            FileEditorAction | StrReplaceEditorAction
          >
        ).action.command || null
      );
    }
  }

  return null;
}

export function isMarkdownFileEditorEvent(
  event: OpenHandsEvent,
  correspondingAction?: ActionEvent,
): boolean {
  const path = getFileEditorEventPath(event, correspondingAction);
  const command = getFileEditorEventCommand(event, correspondingAction);
  return Boolean(path && command === "create" && isMarkdownFilePath(path));
}
