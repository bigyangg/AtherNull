"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { WorkspaceHeader, TaskWorkspaceHeader } from "@/components/workspace/workspace-header";
import { ConversationPanel } from "@/components/workspace/conversation-panel";
import { LiveConversationPanel } from "@/components/workspace/live-conversation-panel";
import { LivePreviewPanel } from "@/components/workspace/live-preview-panel";
import { ActivityPanel } from "@/components/workspace/activity-panel";
import { TerminalActivityPanel } from "@/components/workspace/terminal-activity-panel";
import { FileChangesPanel } from "@/components/workspace/file-changes-panel";
import { useWorkspaceState } from "@/lib/hooks/use-workspace-state";
import { useTask } from "@/lib/hooks/use-task";
import { useExecutionEvents } from "@/lib/hooks/use-execution-events";
import { api } from "@/lib/api";

// Phase 2's real live-agent-workspace view — a task + one of its executions,
// read from apps/api's real event feed. Kept entirely separate from
// MockWorkspaceView below: this only renders when both ?taskId and
// ?executionId are present, which the mock "Create New" flow's redirect
// (components/projects/new-project-form.tsx) never sends, so that flow is
// unaffected by anything in this branch.
function RealWorkspaceView({
  projectId,
  taskId,
  executionId,
}: {
  projectId: string;
  taskId: string;
  executionId: string;
}) {
  const { data: task, isLoading, isError } = useTask(taskId);
  const execution = task?.executions.find((e) => e.id === executionId);
  const isExecutionRunning = execution?.status === "RUNNING";
  const { data: events } = useExecutionEvents(taskId, executionId, isExecutionRunning);

  if (isLoading) {
    return (
      <main className="flex h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading workspace…</p>
      </main>
    );
  }

  if (isError || !task || !execution) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-2">
        <p className="text-sm text-foreground">Execution not found.</p>
      </main>
    );
  }

  const eventList = events ?? [];
  const conversation = <LiveConversationPanel events={eventList} />;
  const terminal = <TerminalActivityPanel events={eventList} />;
  const files = <FileChangesPanel events={eventList} />;

  return (
    <div className="flex h-screen flex-col">
      <TaskWorkspaceHeader
        backHref={`/projects/${projectId}/tasks/${taskId}`}
        title={task.requirements}
        status={task.status}
      />

      {/* Desktop: conversation + tabbed terminal/files side by side. */}
      <div className="hidden flex-1 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] divide-x divide-border overflow-hidden lg:grid">
        {conversation}
        <Tabs defaultValue="terminal" className="flex h-full flex-col overflow-hidden">
          <TabsList className="m-3 w-fit">
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
          <TabsContent value="terminal" className="flex-1 overflow-hidden">
            {terminal}
          </TabsContent>
          <TabsContent value="files" className="flex-1 overflow-hidden">
            {files}
          </TabsContent>
        </Tabs>
      </div>

      {/* Mobile/tablet: all three as tabs. */}
      <Tabs defaultValue="conversation" className="flex-1 overflow-hidden lg:hidden">
        <TabsList className="m-3">
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="h-full overflow-hidden">
          {conversation}
        </TabsContent>
        <TabsContent value="terminal" className="h-full overflow-hidden">
          {terminal}
        </TabsContent>
        <TabsContent value="files" className="h-full overflow-hidden">
          {files}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// Unchanged from before Phase 2 — the mock "Create New" flow's own
// chat/preview/activity view, backed entirely by lib/api/mock.ts.
function MockWorkspaceView({ projectId }: { projectId: string }) {
  const { data, isLoading, isError } = useWorkspaceState(projectId);
  const queryClient = useQueryClient();

  const sendMessage = useMutation({
    mutationFn: (text: string) => api.sendChatMessage(projectId, text),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["workspace-state", projectId],
      });
    },
  });

  if (isLoading) {
    return (
      <main className="flex h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading workspace…</p>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="flex h-screen flex-col items-center justify-center gap-2">
        <p className="text-sm text-foreground">Project not found.</p>
        <p className="text-xs text-muted-foreground">
          It may have been created in a different browser session — this
          milestone's data lives in memory only.
        </p>
      </main>
    );
  }

  const conversation = (
    <ConversationPanel
      messages={data.messages}
      onSend={(text) => sendMessage.mutate(text)}
      sending={sendMessage.isPending}
    />
  );
  const preview = <LivePreviewPanel previewUrl={data.previewUrl} />;
  const activity = (
    <ActivityPanel
      buildSteps={data.buildSteps}
      budgetSpentMinor={data.budgetSpentMinor}
      budgetMaxMinor={data.budgetMaxMinor}
      currency={data.currency}
    />
  );

  return (
    <div className="flex h-screen flex-col">
      <WorkspaceHeader project={data.project} />

      {/* Desktop: three fixed panels side by side. */}
      <div className="hidden flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] divide-x divide-border overflow-hidden lg:grid">
        {conversation}
        {preview}
        {activity}
      </div>

      {/* Mobile/tablet: the same three panels as tabs. */}
      <Tabs defaultValue="conversation" className="flex-1 overflow-hidden lg:hidden">
        <TabsList className="m-3">
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="h-full overflow-hidden">
          {conversation}
        </TabsContent>
        <TabsContent value="preview" className="h-full overflow-hidden">
          {preview}
        </TabsContent>
        <TabsContent value="activity" className="h-full overflow-hidden">
          {activity}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const taskId = searchParams.get("taskId");
  const executionId = searchParams.get("executionId");

  if (taskId && executionId) {
    return <RealWorkspaceView projectId={projectId} taskId={taskId} executionId={executionId} />;
  }

  return <MockWorkspaceView projectId={projectId} />;
}
