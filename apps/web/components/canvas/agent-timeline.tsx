import type { ReactNode } from "react";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  FileEdit,
  FileSearch,
  Loader2,
  SquareTerminal,
  Wrench,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { TimelineItem } from "@/lib/canvas";
import type { ParsedToolCall } from "@/lib/execution-events";

export function AgentAvatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-[#1b1a22] to-[#5148e8] text-white",
        className,
      )}
    >
      <Bot className="size-4" />
    </span>
  );
}

export function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}

export function AgentTurn({ children, reasoning }: { children: ReactNode; reasoning?: string | null }) {
  return (
    <div className="flex gap-3">
      <AgentAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
        {reasoning && (
          <details className="group text-xs text-muted-foreground">
            <summary className="flex cursor-pointer list-none items-center gap-1 select-none">
              <ChevronRight className="size-3 transition-transform group-open:rotate-90" /> Thought
            </summary>
            <p className="mt-1 whitespace-pre-wrap border-l border-border pl-3 italic">{reasoning}</p>
          </details>
        )}
        {children}
      </div>
    </div>
  );
}

function toolLabel(call: ParsedToolCall): { icon: ReactNode; verb: string; target: string | null } {
  if (call.tool === "terminal") {
    return { icon: <SquareTerminal />, verb: "Ran", target: call.command };
  }
  if (call.tool === "file_editor") {
    const verb =
      call.command === "view"
        ? "Read"
        : call.command === "create"
          ? "Created"
          : call.command === "undo_edit"
            ? "Reverted"
            : "Edited";
    return { icon: call.command === "view" ? <FileSearch /> : <FileEdit />, verb, target: call.path };
  }
  return { icon: <Wrench />, verb: "Used", target: call.toolName };
}

function ToolDetail({ call }: { call: ParsedToolCall }) {
  if (call.tool === "terminal") {
    return (
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[#0e0e10] p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <span className="text-foreground">$ {call.command}</span>
        {call.output ? `\n${call.output}` : ""}
        {call.exitCode !== null ? `\n[exit ${call.exitCode}]` : ""}
      </pre>
    );
  }
  if (call.tool === "file_editor") {
    if (call.command === "view") {
      return call.summary ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[#0e0e10] p-3 font-mono text-[11px] text-muted-foreground">
          {call.summary}
        </pre>
      ) : null;
    }
    return (
      <div className="flex flex-col gap-1 font-mono text-[11px]">
        {call.oldStr && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-2 text-destructive">
            {call.oldStr.split("\n").map((l) => `- ${l}`).join("\n")}
          </pre>
        )}
        {(call.newStr || call.fileText) && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-success/10 p-2 text-success">
            {(call.newStr ?? call.fileText ?? "").split("\n").map((l) => `+ ${l}`).join("\n")}
          </pre>
        )}
      </div>
    );
  }
  return call.summary ? <p className="text-xs text-muted-foreground">{call.summary}</p> : null;
}

function ToolRow({ call, pending }: { call: ParsedToolCall; pending: boolean }) {
  const { icon, verb, target } = toolLabel(call);
  const failed = call.tool === "terminal" && (call.isError || (call.exitCode !== null && call.exitCode !== 0));
  return (
    <details className="group ml-10 rounded-lg border border-border bg-panel/60">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs select-none [&_svg]:size-3.5">
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="shrink-0 text-muted-foreground">{verb}</span>
        {target && <code className="min-w-0 flex-1 truncate font-mono text-foreground">{target}</code>}
        <span className="ml-auto shrink-0">
          {pending ? (
            <Loader2 className="animate-spin text-info" />
          ) : failed ? (
            <XCircle className="text-destructive" />
          ) : (
            <CheckCircle2 className="text-success" />
          )}
        </span>
        <ChevronRight className="shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-border p-2">
        <ToolDetail call={call} />
      </div>
    </details>
  );
}

export function AgentTimeline({ items }: { items: TimelineItem[] }) {
  return (
    <>
      {items.map((item) => {
        if (item.type === "message") {
          return item.role === "user" ? (
            <UserTurn key={item.id} text={item.text} />
          ) : (
            <AgentTurn key={item.id} reasoning={item.reasoning}>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{item.text}</p>
            </AgentTurn>
          );
        }
        if (item.type === "tool") {
          return <ToolRow key={item.id} call={item.call} pending={item.pending} />;
        }
        return (
          <div
            key={item.id}
            className="ml-10 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="whitespace-pre-wrap">{item.text}</span>
          </div>
        );
      })}
    </>
  );
}

export function SystemNote({ icon, children, tone = "muted" }: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: "muted" | "info" | "success" | "warning" | "destructive";
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-1 text-xs [&_svg]:size-3.5",
        tone === "muted" && "text-muted-foreground",
        tone === "info" && "text-info",
        tone === "success" && "text-success",
        tone === "warning" && "text-warning",
        tone === "destructive" && "text-destructive",
      )}
    >
      <span className="h-px flex-1 bg-border" />
      {icon}
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
