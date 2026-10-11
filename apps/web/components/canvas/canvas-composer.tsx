"use client";

import { useState, type ReactNode } from "react";
import { ArrowUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// One input for the whole lifecycle; what it does depends on the stage
// (describe a build, revise the plan, message the running agent). When the
// stage takes no free-text input, `onSubmit` is null and `hint` explains
// what the agent is waiting for instead.
export function CanvasComposer({
  placeholder,
  hint,
  onSubmit,
  busy,
  status,
  autoFocus,
}: {
  placeholder: string;
  hint?: string | null;
  onSubmit: ((text: string) => void | Promise<void>) | null;
  busy?: boolean;
  status?: ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const disabled = !onSubmit || busy;

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || disabled || !onSubmit) return;
    setText("");
    await onSubmit(trimmed);
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-2">
      {status && <div className="mb-1.5 px-1 text-xs">{status}</div>}
      <div
        className={cn(
          "flex items-end gap-2 rounded-2xl border border-border bg-panel p-2 pl-3.5 transition-colors focus-within:border-muted-foreground/50",
          disabled && "opacity-70",
        )}
      >
        <textarea
          rows={1}
          value={text}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={onSubmit ? placeholder : (hint ?? placeholder)}
          aria-label={placeholder}
          className="field-sizing-content max-h-48 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <Button
          size="icon"
          className="size-8 shrink-0 rounded-full"
          disabled={disabled || text.trim() === ""}
          onClick={() => void submit()}
          aria-label="Send"
        >
          {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </div>
  );
}
