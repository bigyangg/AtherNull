"use client";

import { useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Hammer, MessagesSquare, Plus } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

import { AgentCanvas } from "@/components/canvas/agent-canvas";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SidePanelContent } from "@/components/ui/dialog";
import { StartBuildDialog } from "@/components/builds/start-build-dialog";
import { useBuilds } from "@/lib/hooks/use-builds";
import { useDiscussions } from "@/lib/hooks/use-discussions";
import { repoLabel } from "@/lib/utils";
import { TASK_STATUS_DISPLAY, type BuildListItem, type Discussion, type TaskStatus } from "@/lib/types";

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const DRAFT_LABEL: Record<string, string> = {
  READY_FOR_REVIEW: "Plan ready",
  APPROVED: "Approved",
  DRAFT: "Draft",
};

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {title}
      </h2>
      <div className="overflow-hidden rounded-xl border border-border bg-panel">{children}</div>
    </section>
  );
}

function Row({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-accent/40"
    >
      {children}
    </Tag>
  );
}

// ADR-0018 — the Builds page inside the canvas: talk in the canvas, then
// every decision about money happens here, one popup or side panel at a time.
export function BuildsHome() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: discussions } = useDiscussions();
  const { data: builds, isLoading } = useBuilds();
  const [dialog, setDialog] = useState<{ discussion: Discussion | null } | null>(null);

  const openProject = searchParams.get("project");

  function openBuild(projectId: string, focus: Record<string, string>) {
    const params = new URLSearchParams({ project: projectId, ...focus });
    router.push(`${pathname}?${params.toString()}`);
  }
  function closePanel() {
    router.push(pathname);
  }

  const readyDiscussions = (discussions ?? []).filter((d) => !d.plannedLineageId);
  const nothingYet = !isLoading && readyDiscussions.length === 0 && (builds ?? []).length === 0;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Builds</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agree on the work in the canvas, then approve, fund and track it here.
          </p>
        </div>
        <Button size="sm" onClick={() => setDialog({ discussion: null })}>
          <Plus /> New build
        </Button>
      </div>

      {nothingYet && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <MessagesSquare className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing here yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Start by{" "}
            <a href="/canvas" target="_top" className="text-foreground underline underline-offset-4">
              talking to the agent
            </a>{" "}
            about what you want built. Nothing is charged until you fund a build.
          </p>
        </div>
      )}

      {readyDiscussions.length > 0 && (
        <Section title="Ready to build" icon={<MessagesSquare />}>
          {readyDiscussions.map((d) => (
            <Row key={d.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{d.title ?? "Untitled discussion"}</p>
                <p className="text-xs text-muted-foreground">
                  {d.messageCount} message{d.messageCount === 1 ? "" : "s"} · {ago(d.lastMessageAt)}
                </p>
              </div>
              <a href={`/canvas/conversations/${d.id}`} target="_top" className="text-xs text-muted-foreground hover:text-foreground">
                Open
              </a>
              <Button size="sm" variant="outline" onClick={() => setDialog({ discussion: d })}>
                Turn into a build
              </Button>
            </Row>
          ))}
        </Section>
      )}

      {(builds ?? []).length > 0 && (
        <Section title="Your builds" icon={<Hammer />}>
          {(builds ?? []).map((b: BuildListItem) => (
            <Row
              key={`${b.kind}:${b.id}`}
              onClick={() => openBuild(b.projectId, b.kind === "build" ? { taskId: b.id } : { lineage: b.id })}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{b.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {repoLabel(b.repository)} · {ago(b.updatedAt)}
                </p>
              </div>
              {b.kind === "build" && b.status in TASK_STATUS_DISPLAY ? (
                <StatusBadge status={b.status as TaskStatus} />
              ) : (
                <Badge variant="muted">{DRAFT_LABEL[b.status] ?? "Draft"}</Badge>
              )}
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Row>
          ))}
        </Section>
      )}

      <StartBuildDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        discussion={dialog?.discussion ?? null}
        onPlanned={(projectId, lineageId) => {
          setDialog(null);
          openBuild(projectId, { lineage: lineageId });
        }}
      />

      <DialogPrimitive.Root open={openProject !== null} onOpenChange={(open) => !open && closePanel()}>
        <SidePanelContent aria-describedby={undefined}>
          <DialogPrimitive.Title className="sr-only">Build</DialogPrimitive.Title>
          {openProject && <AgentCanvas projectId={openProject} compact onClose={closePanel} />}
        </SidePanelContent>
      </DialogPrimitive.Root>
    </main>
  );
}
