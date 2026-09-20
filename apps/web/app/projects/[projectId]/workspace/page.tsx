"use client";

import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { WorkspaceHeader } from "@/components/workspace/workspace-header";
import { ConversationPanel } from "@/components/workspace/conversation-panel";
import { LivePreviewPanel } from "@/components/workspace/live-preview-panel";
import { ActivityPanel } from "@/components/workspace/activity-panel";
import { useWorkspaceState } from "@/lib/hooks/use-workspace-state";
import { api } from "@/lib/api";

export default function WorkspacePage() {
  const { projectId } = useParams<{ projectId: string }>();
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
