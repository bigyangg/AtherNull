"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, Coins, ExternalLink, Loader2, RotateCcw, XCircle } from "lucide-react";

import {
  AgentTimeline,
  AgentTurn,
  SystemNote,
  UserTurn,
} from "@/components/canvas/agent-timeline";
import { BudgetTurn, PlanTurn, PrepareTurn } from "@/components/canvas/lifecycle-steps";
import { CanvasComposer } from "@/components/canvas/canvas-composer";
import { CanvasHeader, type BuildOption } from "@/components/canvas/canvas-header";
import {
  CanvasPanelContent,
  CanvasTabBar,
  canvasTabs,
  type CanvasTab,
} from "@/components/canvas/canvas-side-panel";
import { Button } from "@/components/ui/button";
import { ProjectFundingPanel } from "@/components/projects/project-funding-panel";
import { PayoutStatus } from "@/components/tasks/payout-status";
import { ReviewPanel } from "@/components/tasks/review-panel";
import { UsageLimitMeter } from "@/components/workspace/usage-limit-meter";
import {
  buildTimeline,
  countCommands,
  countFileEdits,
  lineageStage,
  lineageVersions,
  taskStage,
  type CanvasStage,
} from "@/lib/canvas";
import { useProjectBudgetAuthorizations } from "@/lib/hooks/use-budget-authorizations";
import { useExecutionEvents } from "@/lib/hooks/use-execution-events";
import { useExecutionRealtime } from "@/lib/hooks/use-execution-realtime";
import {
  useGenerateEstimate,
  useProjectEstimates,
  useReviseEstimate,
} from "@/lib/hooks/use-project-estimates";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";
import { useTask } from "@/lib/hooks/use-task";
import { useTasks } from "@/lib/hooks/use-tasks";
import { useEmbeddedInCanvas } from "@/lib/use-embedded";
import { DISCUSSION_PROMPT_MARKER } from "@/lib/types";
import type {
  BudgetAuthorization,
  ExecutionEvent,
  ProjectEstimate,
  RepoProject,
  TaskDetail,
} from "@/lib/types";

// --- Layout ----------------------------------------------------------------

const DESKTOP_QUERY = "(min-width: 1024px)";

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(DESKTOP_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

// Keeps the thread pinned to the newest turn while the reader is already at
// the bottom; leaves them alone once they scroll up to read history.
function Thread({ children, revision }: { children: ReactNode; revision: unknown }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [revision]);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">{children}</div>
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <AgentTurn>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> {label}
      </p>
    </AgentTurn>
  );
}

function CanvasShell({
  header,
  thread,
  composer,
  tabs,
  tab,
  onTab,
  panel,
}: {
  header: ReactNode;
  thread: ReactNode;
  composer: ReactNode;
  tabs: ReturnType<typeof canvasTabs>;
  tab: CanvasTab;
  onTab: (tab: CanvasTab) => void;
  panel: ReactNode;
}) {
  const isDesktop = useIsDesktop();
  const [mobileView, setMobileView] = useState<"agent" | CanvasTab>("agent");

  const chat = (
    <div className="flex min-h-0 flex-1 flex-col">
      {thread}
      {composer}
    </div>
  );

  if (!isDesktop) {
    const active = mobileView === "agent" ? null : mobileView;
    return (
      <div className="flex h-[calc(100dvh-53px)] flex-col">
        {header}
        <CanvasTabBar
          tabs={[{ value: "agent" as CanvasTab, label: "Agent" }, ...tabs]}
          value={mobileView}
          onChange={(v) => {
            setMobileView(v as "agent" | CanvasTab);
            if (v !== "agent") onTab(v as CanvasTab);
          }}
        />
        {active ? <div className="min-h-0 flex-1">{panel}</div> : chat}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {header}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] divide-x divide-border">
        {chat}
        <div className="flex min-h-0 flex-col bg-panel/40">
          <CanvasTabBar tabs={tabs} value={tab} onChange={(v) => onTab(v as CanvasTab)} />
          <div className="min-h-0 flex-1">{panel}</div>
        </div>
      </div>
    </div>
  );
}

// --- Planning thread (shared by both focuses) --------------------------------

// A plan drafted from a canvas discussion: the transcript is the input, shown
// collapsed rather than as one giant chat bubble.
function DiscussionSource({ prompt }: { prompt: string }) {
  const transcript = prompt.slice(prompt.indexOf("\n\n") + 2);
  return (
    <div className="flex justify-end">
      <details className="group max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-sm text-primary-foreground">
        <summary className="cursor-pointer list-none select-none">Plan what we agreed in our discussion</summary>
        <p className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs opacity-80">{transcript}</p>
      </details>
    </div>
  );
}

function PlanningThread({
  projectId,
  versions,
  authorization,
  onOpenPlan,
}: {
  projectId: string;
  versions: ProjectEstimate[];
  authorization: BudgetAuthorization | null;
  onOpenPlan: () => void;
}) {
  const head = versions.at(-1) ?? null;
  return (
    <>
      {versions.map((estimate) => (
        <div key={estimate.id} className="flex flex-col gap-4">
          {estimate.sourcePrompt.startsWith(DISCUSSION_PROMPT_MARKER) ? (
            <DiscussionSource prompt={estimate.sourcePrompt} />
          ) : (
            <UserTurn text={estimate.sourcePrompt} />
          )}
          <PlanTurn projectId={projectId} estimate={estimate} isHead={estimate === head} onOpenPlan={onOpenPlan} />
        </div>
      ))}
      {head?.status === "APPROVED" && (
        <BudgetTurn projectId={projectId} estimate={head} authorization={authorization} />
      )}
    </>
  );
}

// --- Focus: a planning lineage with no task yet --------------------------------

function LineageCanvas({
  project,
  header,
  lineageId,
  estimates,
  authorizations,
  initialPrompt,
  onLineage,
  onTask,
}: {
  project: RepoProject;
  header: (stage: CanvasStage) => ReactNode;
  lineageId: string | null;
  estimates: ProjectEstimate[];
  authorizations: BudgetAuthorization[];
  initialPrompt: string | null;
  onLineage: (lineageId: string) => void;
  onTask: (taskId: string) => void;
}) {
  const generate = useGenerateEstimate(project.id);
  const revise = useReviseEstimate(project.id);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ prompt: string; error: string } | null>(null);
  const [tab, setTab] = useState<CanvasTab>("plan");

  const versions = lineageVersions(estimates, lineageId);
  const head = versions.at(-1) ?? null;
  const headAuthorizations = head ? authorizations.filter((a) => a.estimateId === head.id) : [];
  const activeAuthorization = headAuthorizations.find((a) => a.status === "ACTIVE") ?? null;
  const planning = generate.isPending || revise.isPending;
  const stage = lineageStage(head, authorizations, planning && !head);

  async function describe(prompt: string) {
    setFailed(null);
    setPendingPrompt(prompt);
    try {
      const estimate = head
        ? await revise.mutateAsync({ estimateId: head.id, prompt })
        : await generate.mutateAsync(prompt);
      onLineage(estimate.lineageId);
    } catch (err) {
      setFailed({ prompt, error: err instanceof Error ? err.message : "Planning failed." });
    } finally {
      setPendingPrompt(null);
    }
  }

  // Dashboard hand-off: the prompt was already submitted there.
  const started = useRef(false);
  useEffect(() => {
    if (initialPrompt && !lineageId && !started.current) {
      started.current = true;
      void describe(initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, lineageId]);

  const composer =
    stage === "describe" || stage === "planning" ? (
      <CanvasComposer
        autoFocus
        placeholder="Describe what you want the agent to build…"
        onSubmit={describe}
        busy={planning}
      />
    ) : stage === "plan-review" ? (
      <CanvasComposer placeholder="Ask for changes to the plan…" onSubmit={describe} busy={planning} />
    ) : (
      <CanvasComposer
        placeholder=""
        hint={stage === "authorize" ? "Authorize a budget above to continue." : "Prepare the build above to continue."}
        onSubmit={null}
      />
    );

  const tabs = canvasTabs(false, 0, 0);

  return (
    <CanvasShell
      header={header(stage)}
      tab={tab}
      onTab={setTab}
      tabs={tabs}
      panel={<CanvasPanelContent tab={tab} estimate={head} task={null} events={[]} />}
      composer={composer}
      thread={
        <Thread revision={`${versions.length}:${head?.status}:${pendingPrompt}:${headAuthorizations.length}`}>
          {versions.length === 0 && !pendingPrompt && !failed && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-lg font-medium">What should the agent build?</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Describe a feature or fix for <span className="font-mono">{project.permittedRepository}</span>. The
                agent drafts a plan, you approve a budget and fund it on Solana devnet, then watch it build.
              </p>
            </div>
          )}
          <PlanningThread
            projectId={project.id}
            versions={versions}
            authorization={activeAuthorization}
            onOpenPlan={() => setTab("plan")}
          />
          {pendingPrompt && (
            <>
              <UserTurn text={pendingPrompt} />
              <Working label={head ? "Revising the plan…" : "Drafting a plan…"} />
            </>
          )}
          {failed && (
            <>
              <UserTurn text={failed.prompt} />
              <AgentTurn>
                <p className="text-sm text-destructive">I couldn&apos;t draft a plan: {failed.error}</p>
                <div>
                  <Button size="sm" variant="outline" onClick={() => void describe(failed.prompt)}>
                    <RotateCcw /> Retry
                  </Button>
                </div>
              </AgentTurn>
            </>
          )}
          {head?.status === "APPROVED" && activeAuthorization && (
            <PrepareTurn
              projectId={project.id}
              authorization={activeAuthorization}
              defaultRevision={project.revision ?? ""}
              onPrepared={onTask}
            />
          )}
        </Thread>
      }
    />
  );
}

// --- Focus: a task (build) -----------------------------------------------------

function OutcomeNote({ status }: { status: TaskDetail["status"] }) {
  if (status === "SETTLED") {
    return <SystemNote tone="success" icon={<CheckCircle2 />}>Accepted and settled on-chain</SystemNote>;
  }
  if (status === "REFUNDED") {
    return <SystemNote tone="warning" icon={<RotateCcw />}>Refunded on-chain</SystemNote>;
  }
  if (status === "FAILED" || status === "CANCELLED") {
    return <SystemNote tone="destructive" icon={<XCircle />}>Build failed</SystemNote>;
  }
  return null;
}

function TaskCanvas({
  project,
  header,
  taskId,
  estimates,
  authorizations,
  onLineage,
}: {
  project: RepoProject;
  header: (stage: CanvasStage, task: TaskDetail | null) => ReactNode;
  taskId: string;
  estimates: ProjectEstimate[];
  authorizations: BudgetAuthorization[];
  onLineage: (lineageId: string) => void;
}) {
  const { data: task, isLoading, isError } = useTask(taskId);
  const generate = useGenerateEstimate(project.id);
  const execution = task?.executions.at(-1);
  const running = execution?.status === "RUNNING";
  const { data: polledEvents } = useExecutionEvents(taskId, execution?.id, running);
  const realtime = useExecutionRealtime(taskId, execution?.id, running);
  const [tab, setTab] = useState<CanvasTab | null>(null);
  // Inside the OpenHands Agent Canvas, the build's agent conversation lives
  // in the org sandbox and can be opened (and steered) natively there.
  const embedded = useEmbeddedInCanvas();

  const events: ExecutionEvent[] = useMemo(
    () =>
      realtime.events?.map((e) => ({
        id: e.id,
        executionId: execution?.id ?? "",
        kind: e.kind,
        payload: e.payload,
        occurredAt: e.occurredAt,
        createdAt: e.occurredAt,
      })) ??
      polledEvents ??
      [],
    [realtime.events, polledEvents, execution?.id],
  );
  const timeline = useMemo(() => buildTimeline(events), [events]);

  if (isLoading || isError || !task) {
    return (
      <div className="flex h-screen flex-col">
        {header("queued", null)}
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {isLoading ? <Loader2 className="size-4 animate-spin" /> : "Build not found."}
        </div>
      </div>
    );
  }

  const stage = taskStage(task.status);
  const sourceEstimate = estimates.find((e) => e.id === task.sourceEstimateId) ?? null;
  const versions = sourceEstimate
    ? lineageVersions(estimates, sourceEstimate.lineageId).filter((v) => v.version <= sourceEstimate.version)
    : [];
  const authorization = authorizations.find((a) => a.id === task.sourceBudgetAuthorizationId) ?? null;

  const defaultTab: CanvasTab =
    stage === "fund" ? "chain" : stage === "queued" ? "plan" : stage === "verifying" || stage === "review" ? "checks" : "changes";
  const activeTab = tab ?? defaultTab;
  const terminal = stage === "settled" || stage === "refunded" || stage === "failed";
  const latestCommand = realtime.commandStatuses.at(-1) ?? null;

  const composer =
    stage === "building" && realtime.canControl ? (
      <CanvasComposer
        placeholder="Message the agent…"
        onSubmit={realtime.sendMessage}
        status={
          latestCommand && (
            <span className={latestCommand.status === "uncertain" ? "text-warning" : latestCommand.status === "failed" || latestCommand.status === "rejected" ? "text-destructive" : "text-muted-foreground"}>
              {latestCommand.status === "uncertain"
                ? "Delivery could not be confirmed"
                : latestCommand.status === "executed"
                  ? "Agent responded"
                  : latestCommand.status === "accepted"
                    ? "Delivered"
                    : latestCommand.status === "failed" || latestCommand.status === "rejected"
                      ? `Not delivered${latestCommand.reason ? ` (${latestCommand.reason})` : ""}`
                      : "Sending…"}
            </span>
          )
        }
      />
    ) : terminal && task.status !== "SETTLING" && task.status !== "REFUNDING" ? (
      <CanvasComposer
        placeholder="Describe the next change…"
        busy={generate.isPending}
        onSubmit={async (prompt) => {
          const estimate = await generate.mutateAsync(prompt);
          onLineage(estimate.lineageId);
        }}
      />
    ) : (
      <CanvasComposer
        placeholder=""
        onSubmit={null}
        hint={
          stage === "fund"
            ? "Fund the build above to start the agent."
            : stage === "building"
              ? "The agent is working. Only org owners and admins can message it."
              : stage === "review"
                ? "Review the result above."
                : stage === "verifying"
                  ? "Waiting on verification."
                  : stage === "paused"
                    ? "Paused at the usage limit. Raise it above to resume."
                    : task.status === "SETTLING" || task.status === "REFUNDING"
                      ? "Waiting for the payout to finalize on Solana devnet…"
                      : "Waiting for an agent worker…"
        }
      />
    );

  return (
    <CanvasShell
      header={header(stage, task)}
      tab={activeTab}
      onTab={setTab}
      tabs={canvasTabs(true, countFileEdits(events), countCommands(events))}
      panel={<CanvasPanelContent tab={activeTab} estimate={sourceEstimate} task={task} events={events} />}
      composer={composer}
      thread={
        <Thread revision={`${task.status}:${timeline.length}`}>
          {versions.length > 0 ? (
            <PlanningThread
              projectId={project.id}
              versions={versions}
              authorization={authorization}
              onOpenPlan={() => setTab("plan")}
            />
          ) : (
            <UserTurn text={task.requirements} />
          )}

          <SystemNote>Build prepared at {task.repositoryRevision}</SystemNote>

          {stage === "fund" ? (
            <AgentTurn>
              <p className="text-sm text-foreground">
                Fund this build on Solana devnet and I&apos;ll start. Funds are credited only once the deposit is
                finalized on-chain.
              </p>
              <ProjectFundingPanel taskId={task.id} />
            </AgentTurn>
          ) : (
            <SystemNote tone="success" icon={<Coins />}>Funded on Solana devnet</SystemNote>
          )}

          {embedded && execution?.conversationId && (
            <a
              href={`/canvas/conversations/${execution.conversationId}`}
              target="_top"
              className="ml-10 inline-flex w-fit items-center gap-1.5 rounded-lg border border-border bg-panel px-3 py-1.5 text-xs text-foreground hover:bg-accent"
            >
              <ExternalLink className="size-3.5" />
              {running ? "Watch and steer the agent live in the canvas" : "Open the agent conversation in the canvas"}
            </a>
          )}
          {task.executions.length > 1 && (
            <SystemNote>Attempt {task.executions.length} of {task.executions.length}</SystemNote>
          )}
          <AgentTimeline items={timeline} />

          {stage === "queued" && <Working label="Waiting for an agent worker to pick this up…" />}
          {stage === "building" && <Working label="Working…" />}
          {stage === "paused" && task.usageLimit && (
            <AgentTurn>
              <p className="text-sm text-foreground">I paused at the usage limit. Raise it to let me continue.</p>
              <div className="rounded-xl border border-border bg-panel p-3.5">
                <UsageLimitMeter projectId={project.id} taskId={task.id} taskStatus={task.status} usageLimit={task.usageLimit} />
              </div>
            </AgentTurn>
          )}
          {(stage === "verifying" || stage === "review" || task.verificationRuns.length > 0) && (
            <AgentTurn>
              <p className="text-sm text-foreground">
                {stage === "verifying"
                  ? "I'm done. An independent verifier now applies my change to a fresh checkout and runs the tests."
                  : stage === "review"
                    ? "Verification passed. Accept to release payment, or reject for a refund."
                    : "Verification record:"}
              </p>
              <ReviewPanel task={task} />
            </AgentTurn>
          )}
          {(stage === "settled" || stage === "refunded" || stage === "failed") && (
            <div className="ml-10">
              <PayoutStatus task={task} />
            </div>
          )}
          <OutcomeNote status={task.status} />
        </Thread>
      }
    />
  );
}

// --- Entry -----------------------------------------------------------------------

export function AgentCanvas({ projectId }: { projectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: projects, isLoading: projectsLoading } = useRepoProjects();
  const { data: tasks } = useTasks(projectId);
  const { data: estimates } = useProjectEstimates(projectId);
  const { data: authorizations } = useProjectBudgetAuthorizations(projectId);

  const project = projects?.find((p) => p.id === projectId);

  const builds: BuildOption[] = useMemo(() => {
    const options: BuildOption[] = (tasks ?? []).map((task) => ({
      key: `task:${task.id}`,
      label: task.requirements,
      task,
      createdAt: task.createdAt,
    }));
    const builtEstimateIds = new Set((tasks ?? []).map((t) => t.sourceEstimateId).filter(Boolean));
    const lineages = new Map<string, ProjectEstimate[]>();
    for (const e of estimates ?? []) lineages.set(e.lineageId, [...(lineages.get(e.lineageId) ?? []), e]);
    for (const [lineageId, versions] of lineages) {
      if (versions.some((v) => builtEstimateIds.has(v.id))) continue;
      const first = versions.reduce((a, b) => (a.version < b.version ? a : b));
      options.push({
        key: `lineage:${lineageId}`,
        label: `Draft · ${first.sourcePrompt.startsWith(DISCUSSION_PROMPT_MARKER) ? first.plannerOutput.goal : first.sourcePrompt}`,
        task: null,
        createdAt: first.createdAt,
      });
    }
    return options.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [tasks, estimates]);

  const paramTask = searchParams.get("taskId");
  const paramLineage = searchParams.get("lineage");
  const isNew = searchParams.get("new") === "1";
  const prompt = searchParams.get("prompt");
  const selectedKey = paramTask
    ? `task:${paramTask}`
    : paramLineage
      ? `lineage:${paramLineage}`
      : isNew
        ? null
        : (builds[0]?.key ?? null);

  function navigate(params: Record<string, string>) {
    router.replace(`${pathname}?${new URLSearchParams(params).toString()}`);
  }
  const focusTask = (id: string) => navigate({ taskId: id });
  const focusLineage = (id: string) => navigate({ lineage: id });
  const focusNew = () => navigate({ new: "1" });
  const select = (key: string) => {
    const [kind, id] = key.split(":") as ["task" | "lineage", string];
    if (kind === "task") focusTask(id);
    else focusLineage(id);
  };

  // Wait for the build list before choosing a default focus, so a project
  // with history doesn't flash the empty "describe" state first.
  const listsReady = tasks !== undefined && estimates !== undefined && authorizations !== undefined;

  if (projectsLoading || !listsReady) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Project not found.</div>
    );
  }

  const header = (stage: CanvasStage, task: TaskDetail | null = null) => (
    <CanvasHeader
      project={project}
      stage={stage}
      task={task}
      builds={builds}
      selectedKey={selectedKey}
      onSelect={select}
      onNew={focusNew}
    />
  );

  if (selectedKey?.startsWith("task:")) {
    return (
      <TaskCanvas
        key={selectedKey}
        project={project}
        header={header}
        taskId={selectedKey.slice("task:".length)}
        estimates={estimates}
        authorizations={authorizations}
        onLineage={focusLineage}
      />
    );
  }

  return (
    <LineageCanvas
      key={selectedKey ?? "new"}
      project={project}
      header={(stage) => header(stage)}
      lineageId={selectedKey ? selectedKey.slice("lineage:".length) : null}
      estimates={estimates}
      authorizations={authorizations}
      initialPrompt={prompt}
      onLineage={focusLineage}
      onTask={focusTask}
    />
  );
}
