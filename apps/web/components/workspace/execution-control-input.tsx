"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CommandStatusEntry } from "@/lib/hooks/use-execution-realtime";

// ADR-0007 Phase 3D — the smallest reasonable frontend affordance for
// realtime:control, added on top of the existing (Phase 3C) read-only
// workspace view without a visual redesign. Rendered ONLY when the gateway's
// own server.hello said this connection holds realtime:control
// (useExecutionRealtime's `canControl`) — this component never decides
// permission itself, and there is no code path here that could show the
// input to an unauthorized user only to have the gateway reject it (though
// the gateway would reject it either way, per ADR-0007's "never trust the
// frontend" requirement).
//
// Required UX distinctions (per the Phase 3D spec): sending, accepted,
// executed/normal response, failed, rejected, uncertain. No automatic retry
// exists anywhere in this component — an "uncertain" or "failed" command
// stays exactly that until the user deliberately submits a new message.
export function ExecutionControlInput({
  onSend,
  latestStatus,
}: {
  onSend: (text: string) => void;
  latestStatus: CommandStatusEntry | null;
}) {
  const [text, setText] = useState("");

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border p-3">
      {latestStatus && <StatusBadge entry={latestStatus} />}
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Send a message to the running agent…"
          aria-label="Message to running agent"
        />
        <Button onClick={submit} disabled={!text.trim()}>
          Send
        </Button>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<CommandStatusEntry["status"], string> = {
  received: "Sending…",
  authorized: "Sending…",
  forwarded: "Sending…",
  accepted: "Delivered",
  executed: "Agent responded",
  failed: "Failed",
  rejected: "Not sent",
  uncertain: "Uncertain — delivery could not be confirmed",
};

function StatusBadge({ entry }: { entry: CommandStatusEntry }) {
  const isTransient = entry.status === "received" || entry.status === "authorized" || entry.status === "forwarded";
  const isBad = entry.status === "failed" || entry.status === "rejected";
  const isUncertain = entry.status === "uncertain";
  return (
    <p
      className={cn(
        "text-xs",
        isTransient && "text-muted-foreground",
        isBad && "text-destructive",
        // Uncertain must never look identical to a plain failure — the
        // system genuinely does not know the outcome, and the spec is
        // explicit that this must never be presented as "it failed."
        isUncertain && "font-medium text-amber-600 dark:text-amber-500",
        entry.status === "accepted" && "text-muted-foreground",
        entry.status === "executed" && "text-emerald-600 dark:text-emerald-500",
      )}
    >
      {STATUS_LABEL[entry.status]}
      {entry.reason ? ` (${entry.reason})` : ""}
    </p>
  );
}
