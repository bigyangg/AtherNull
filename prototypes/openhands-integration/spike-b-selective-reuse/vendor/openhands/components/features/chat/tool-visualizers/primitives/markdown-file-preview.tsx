/**
 * SPIKE-B UPGRADED FROM PARTIAL VENDOR — Spike F (see MANIFEST.md
 * "markdown-file-preview" row). Spike B originally vendored only the pure
 * path/command-resolution predicates here, since no caller at the time
 * rendered the `MarkdownFilePreview` UI component. Spike F's real,
 * unmodified `file-editor.tsx` imports that component directly (for
 * `create`d `.md` artifacts), so it is now vendored in full, verbatim from
 * upstream except for one blocker-fix icon swap (see below) — same
 * discipline as the rest of this pass: real logic, not a substitute. Not
 * exercised by the seeded str_replace journey fixture (which touches a
 * non-Markdown file), but present so the component compiles and behaves
 * identically to upstream for any `.md` `create` event.
 */
import { useTranslation } from "react-i18next";
import { ArrowUpRight, File as FileIcon } from "lucide-react";
import { I18nKey } from "#/i18n/declaration";
import { MarkdownRenderer } from "#/components/features/markdown/markdown-renderer";
import { planComponents } from "#/components/features/markdown/plan-components";
import { Typography } from "#/ui/typography";
import { isMarkdownFilePath } from "#/utils/is-markdown-file-path";
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

export { isMarkdownFilePath } from "#/utils/is-markdown-file-path";

interface MarkdownFilePreviewProps {
  content: string;
  path: string;
  /** When omitted (e.g. in-flight create), the View affordance is hidden. */
  onView?: () => void;
}

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

/**
 * Height-clipped markdown card with an optional View bar that opens the file.
 */
export function MarkdownFilePreview({
  content,
  path,
  onView,
}: MarkdownFilePreviewProps) {
  const { t } = useTranslation("openhands");
  const fileName = path.split("/").pop() || path;

  return (
    <div
      className="w-full overflow-hidden rounded-xl border border-border bg-surface"
      data-testid="markdown-file-preview"
    >
      <div
        data-testid="markdown-file-preview-content"
        className="max-h-40 overflow-y-auto px-4 py-3 text-white custom-scrollbar-always [--oh-scroll-fade-from:var(--oh-surface)]"
      >
        {/* Deliberately compact: the clipped in-stream card reuses the plan
            preview's small typography; the Files drawer renders the same
            artifact full-size with the default components. */}
        <MarkdownRenderer
          content={content}
          includeStandard
          includeHeadings
          components={planComponents}
        />
      </div>
      <div className="flex h-10 items-center justify-between gap-2 border-t border-border px-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted" />
          <Typography.Text className="truncate font-mono text-[11px] leading-4 tracking-[0.11px] text-muted">
            {fileName}
          </Typography.Text>
        </div>
        {onView ? (
          <button
            type="button"
            onClick={onView}
            className="flex shrink-0 cursor-pointer items-center gap-1 transition-opacity hover:opacity-80"
            data-testid="markdown-file-preview-view"
          >
            <Typography.Text className="text-[11px] leading-4 tracking-[0.11px] text-white">
              {t(I18nKey.COMMON$VIEW)}
            </Typography.Text>
            <ArrowUpRight className="text-white" size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
