import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { parseMessage } from "@/lib/execution-events";
import type { ExecutionEvent } from "@/lib/types";

// Read-only replay of what already happened — not a live chat input. Reuses
// the exact bubble convention from conversation-panel.tsx (the mock flow's
// chat UI): user right/primary, agent left/muted.
export function LiveConversationPanel({ events }: { events: ExecutionEvent[] }) {
  const messages = events
    .map((event) => ({ event, parsed: parseMessage(event) }))
    .filter((item): item is { event: ExecutionEvent; parsed: NonNullable<ReturnType<typeof parseMessage>> } =>
      item.parsed !== null,
    );

  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No messages yet — they'll appear here as the agent works.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full p-4">
      <div className="flex flex-col gap-3">
        {messages.map(({ event, parsed }) => (
          <div key={event.id} className={cn("flex flex-col gap-1", parsed.role === "user" && "items-end")}>
            {parsed.reasoning && parsed.role === "agent" && (
              <p className="max-w-[85%] text-xs italic text-muted-foreground">{parsed.reasoning}</p>
            )}
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                parsed.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
              )}
            >
              {parsed.text}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
