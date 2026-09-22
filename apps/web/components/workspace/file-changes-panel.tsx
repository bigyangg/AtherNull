import { FileCode } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { pairActionsWithObservations, parseToolCall } from "@/lib/execution-events";
import type { ExecutionEvent } from "@/lib/types";

// Grouped file_editor edits, rendered as before/after blocks. This is the
// only "diff" AtherNull can show for a finished execution — the task's
// Docker container (and the file system inside it) is destroyed the moment
// the run ends, so there's no live checkout to diff against after the fact.
// "view" calls are filtered out — they're reads, not changes.
export function FileChangesPanel({ events }: { events: ExecutionEvent[] }) {
  const edits = pairActionsWithObservations(events)
    .map(({ action, observation }) => parseToolCall(action, observation))
    .filter(
      (call): call is Extract<NonNullable<ReturnType<typeof parseToolCall>>, { tool: "file_editor" }> =>
        call?.tool === "file_editor" && call.command !== "view",
    );

  if (edits.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No file changes recorded for this execution.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full p-4">
      <div className="flex flex-col gap-4">
        {edits.map((edit, index) => (
          <div key={index} className="rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <FileCode className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{edit.path}</span>
              <Badge variant="muted">{edit.command}</Badge>
            </div>
            <div className="flex flex-col gap-2 p-3 font-mono text-xs">
              {edit.oldStr && (
                <pre className="whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-destructive">
                  {edit.oldStr
                    .split("\n")
                    .map((line) => `- ${line}`)
                    .join("\n")}
                </pre>
              )}
              {(edit.newStr || edit.fileText) && (
                <pre className="whitespace-pre-wrap rounded-md bg-success/10 p-2 text-success">
                  {(edit.newStr ?? edit.fileText ?? "")
                    .split("\n")
                    .map((line) => `+ ${line}`)
                    .join("\n")}
                </pre>
              )}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
