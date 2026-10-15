"use client";

import { useState, useEffect } from "react";
import { ChevronRight, MessageSquare, X, RotateCcw, CheckCircle2, AlertCircle, Clock, GitBranch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ThreadMeta, ThreadType, ThreadStatus } from "@athernull/contracts";

interface ThreadNavigatorProps {
  projectId: string;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: (type: ThreadType, parentThreadId?: string) => void;
  onCloseThread: (threadId: string) => void;
}

const THREAD_TYPE_ICONS: Record<ThreadType, React.ReactNode> = {
  planning: <MessageSquare className="size-4 text-blue-500" />,
  build: <GitBranch className="size-4 text-green-500" />,
  fix: <RotateCcw className="size-4 text-orange-500" />,
  review: <CheckCircle2 className="size-4 text-purple-500" />,
  discussion: <MessageSquare className="size-4 text-gray-500" />,
  change_request: <AlertCircle className="size-4 text-red-500" />,
};

const THREAD_TYPE_LABELS: Record<ThreadType, string> = {
  planning: "Planning",
  build: "Build",
  fix: "Fix",
  review: "Review",
  discussion: "Discussion",
  change_request: "Change Request",
};

const THREAD_STATUS_BADGES: Record<ThreadStatus, string> = {
  open: "bg-green-500/20 text-green-400",
  resolved: "bg-blue-500/20 text-blue-400",
  archived: "bg-gray-500/20 text-gray-400",
  blocked: "bg-orange-500/20 text-orange-400",
};

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ThreadNavigator({
  projectId,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onCloseThread,
}: ThreadNavigatorProps) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch threads for this project
  const fetchThreads = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/v1/projects/${projectId}/threads`);
      if (!res.ok) throw new Error("Failed to fetch threads");
      const data = await res.json();
      setThreads(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchThreads();
  }, [projectId]);

  // Group threads by type for organized display
  const groupedThreads = threads.reduce(
    (acc, thread) => {
      if (!acc[thread.type]) acc[thread.type] = [];
      acc[thread.type].push(thread);
      return acc;
    },
    {} as Record<ThreadType, ThreadMeta[]>
  );

  const typeOrder: ThreadType[] = ["planning", "build", "fix", "review", "discussion"];

  const handleCreateFixThread = (parentThreadId: string) => {
    onCreateThread("fix", parentThreadId);
  };

  const handleCreateReviewThread = (parentThreadId: string) => {
    onCreateThread("review", parentThreadId);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Clock className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-6">
        {/* Thread creation actions */}
        <div className="flex flex-col gap-2 border-b border-border pb-4">
          <Button
            variant="outline"
            size="sm"
            className="justify-start gap-2"
            onClick={() => onCreateThread("planning")}
          >
            <MessageSquare className="size-3.5" />
            New Planning Thread
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="justify-start gap-2"
            onClick={() => onCreateThread("discussion")}
          >
            <MessageSquare className="size-3.5" />
            New Discussion
          </Button>
        </div>

        {/* Threads grouped by type */}
        {typeOrder.map((type) => {
          const typeThreads = groupedThreads[type];
          if (!typeThreads || typeThreads.length === 0) return null;

          return (
            <div key={type} className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                {THREAD_TYPE_ICONS[type]}
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {THREAD_TYPE_LABELS[type]}
                </span>
                <span className="ml-auto text-xs text-muted-foreground">{typeThreads.length}</span>
              </div>
              <div className="space-y-1">
                {typeThreads
                  .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                  .map((thread) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isActive={thread.id === activeThreadId}
                      onSelect={() => onSelectThread(thread.id)}
                      onClose={() => onCloseThread(thread.id)}
                      onCreateFix={handleCreateFixThread}
                      onCreateReview={handleCreateReviewThread}
                    />
                  ))}
              </div>
            </div>
          );
        })}

        {/* Empty state */}
        {threads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-muted-foreground">
            <MessageSquare className="size-8 mb-2 opacity-50" />
            <p>No threads yet</p>
            <p className="text-xs">Create a planning thread to start</p>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

interface ThreadItemProps {
  thread: ThreadMeta;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onCreateFix: (parentThreadId: string) => void;
  onCreateReview: (parentThreadId: string) => void;
}

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onClose,
  onCreateFix,
  onCreateReview,
}: ThreadItemProps) {
  const isBuildThread = thread.type === "build";
  const canCreateFix = isBuildThread && thread.status === "open";
  const canCreateReview = isBuildThread && thread.status === "resolved";

  return (
    <div
      className={cn(
        "group relative rounded-lg border p-2 transition-colors cursor-pointer",
        isActive
          ? "bg-primary/10 border-primary/50"
          : "border-transparent hover:bg-accent/50 hover:border-border"
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={cn("text-xs font-medium truncate", isActive ? "text-primary" : "text-foreground")}>
              {thread.id.split("-").slice(0, 2).join("-")}…
            </span>
            <span
              className={cn(
                "flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium",
                THREAD_STATUS_BADGES[thread.status]
              )}
            >
              {thread.status}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{thread.messageCount} messages</span>
            <span>{formatRelativeTime(thread.updatedAt)}</span>
          </div>
          {thread.parentThreadId && (
            <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <ChevronRight className="size-3" />
              <span>Child of {thread.parentThreadId.slice(0, 8)}…</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {canCreateFix && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation();
                onCreateFix(thread.id);
              }}
              title="Create fix thread"
            >
              <RotateCcw className="size-3.5 text-orange-500" />
            </Button>
          )}
          {canCreateReview && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={(e) => {
                e.stopPropagation();
                onCreateReview(thread.id);
              }}
              title="Create review thread"
            >
              <CheckCircle2 className="size-3.5 text-purple-500" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            title="Close thread"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}