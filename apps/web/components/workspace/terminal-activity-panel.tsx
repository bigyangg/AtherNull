import { XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { pairActionsWithObservations, parseToolCall } from "@/lib/execution-events";
import type { ExecutionEvent } from "@/lib/types";

// Read-only history of terminal commands the agent ran — no input, matching
// the approved scope's "interactive terminal access deferred until its
// authorization is implemented."
export function TerminalActivityPanel({ events }: { events: ExecutionEvent[] }) {
  const commands = pairActionsWithObservations(events)
    .map(({ action, observation }) => parseToolCall(action, observation))
    .filter((call): call is Extract<NonNullable<ReturnType<typeof parseToolCall>>, { tool: "terminal" }> =>
      call?.tool === "terminal",
    );

  if (commands.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No terminal activity yet.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full p-4">
      <div className="flex flex-col gap-3 font-mono text-xs">
        {commands.map((command, index) => (
          <div key={index} className="rounded-lg border border-border bg-panel p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-foreground">
                <span className="text-muted-foreground">$ </span>
                {command.command}
              </span>
              {command.isError && (
                <Badge variant="destructive" className="shrink-0">
                  <XCircle className="size-3" /> error
                </Badge>
              )}
            </div>
            {command.output !== null && (
              <pre className="mt-2 whitespace-pre-wrap text-muted-foreground">{command.output}</pre>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
