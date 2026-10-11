"use client";

import type { ReactNode } from "react";
import {
  devnetExplorerAddressUrl,
  devnetExplorerTxUrl,
  formatDevnetSol,
} from "@athernull/contracts";
import { CheckCircle2, CircleDashed, ExternalLink, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PlanView } from "@/components/projects/scope-estimate-panel";
import { FileChangesPanel } from "@/components/workspace/file-changes-panel";
import { TerminalActivityPanel } from "@/components/workspace/terminal-activity-panel";
import { useProjectFunding } from "@/lib/hooks/use-project-funding";
import { cn } from "@/lib/utils";
import type { ExecutionEvent, ProjectEstimate, TaskDetail } from "@/lib/types";

export type CanvasTab = "plan" | "changes" | "terminal" | "chain" | "checks";

export interface CanvasTabDef {
  value: CanvasTab;
  label: string;
  count?: number;
}

export function canvasTabs(hasTask: boolean, changes: number, commands: number): CanvasTabDef[] {
  const tabs: CanvasTabDef[] = [{ value: "plan", label: "Plan" }];
  if (hasTask) {
    tabs.push(
      { value: "changes", label: "Changes", count: changes },
      { value: "terminal", label: "Terminal", count: commands },
      { value: "chain", label: "On-chain" },
      { value: "checks", label: "Checks" },
    );
  }
  return tabs;
}

export function CanvasTabBar({
  tabs,
  value,
  onChange,
  leading,
}: {
  tabs: CanvasTabDef[];
  value: string;
  onChange: (value: string) => void;
  leading?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2">
      {leading}
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={cn(
            "relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
            value === tab.value &&
              "text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground",
          )}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{tab.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function short(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-6)}`;
}

function ChainPanel({ taskId }: { taskId: string }) {
  const { data: funding, isLoading } = useProjectFunding(taskId);
  if (isLoading) return <Empty>Loading on-chain state…</Empty>;
  if (!funding) return <Empty>No funding account yet. It's created when you fund the build.</Empty>;

  const rows: { label: string; value: ReactNode }[] = [
    { label: "Network", value: "Solana Devnet" },
    {
      label: "Status",
      value: (
        <Badge variant={funding.status === "FUNDED" ? "success" : "warning"}>
          {funding.status.replace(/_/g, " ").toLowerCase()}
        </Badge>
      ),
    },
    {
      label: "Funded",
      value: `${formatDevnetSol(funding.confirmedLamports)} / ${formatDevnetSol(funding.requiredLamports)} SOL`,
    },
    {
      label: "Project account",
      value: (
        <a className="inline-flex items-center gap-1 font-mono hover:underline" href={devnetExplorerAddressUrl(funding.onchainAccount)} target="_blank" rel="noopener noreferrer">
          {short(funding.onchainAccount)} <ExternalLink className="size-3" />
        </a>
      ),
    },
    {
      label: "Program",
      value: (
        <a className="inline-flex items-center gap-1 font-mono hover:underline" href={devnetExplorerAddressUrl(funding.programId)} target="_blank" rel="noopener noreferrer">
          {short(funding.programId)} <ExternalLink className="size-3" />
        </a>
      ),
    },
  ];
  if (funding.customerWallet) {
    rows.push({ label: "Your wallet", value: <span className="font-mono">{short(funding.customerWallet)}</span> });
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-right text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Transactions</p>
          {funding.initSignature && (
            <TxRow label="Account created" signature={funding.initSignature} />
          )}
          {funding.deposits.map((d) => (
            <TxRow key={d.signature} label={`Deposit · ${formatDevnetSol(d.amountLamports)} SOL`} signature={d.signature} />
          ))}
          {funding.settlement?.signature && (
            <TxRow
              label={`${funding.settlement.kind === "SETTLE" ? "Settlement" : "Refund"} · ${funding.settlement.status === "FINALIZED" ? "finalized" : "pending"}`}
              signature={funding.settlement.signature}
            />
          )}
          {!funding.initSignature && funding.deposits.length === 0 && (
            <p className="text-sm text-muted-foreground">None yet.</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Credited only after AtherNull verifies the finalized transaction on-chain.
        </p>
      </div>
    </ScrollArea>
  );
}

function TxRow({ label, signature }: { label: string; signature: string }) {
  return (
    <a
      href={devnetExplorerTxUrl(signature)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent"
    >
      <span>{label}</span>
      <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
        {short(signature)} <ExternalLink className="size-3" />
      </span>
    </a>
  );
}

function ChecksPanel({ task }: { task: TaskDetail }) {
  const latestRun = task.verificationRuns.at(-1);
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-5 p-4">
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Acceptance criteria</p>
          {task.acceptanceCriteria.length === 0 ? (
            <p className="text-sm text-muted-foreground">None specified.</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {task.acceptanceCriteria.map((c) => (
                <li key={c} className="flex gap-2">
                  {latestRun?.outcome === "PASS" ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  )}
                  {c}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Verification runs</p>
          {task.verificationRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not verified yet.</p>
          ) : (
            task.verificationRuns.map((run) => (
              <div key={run.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex items-center justify-between">
                  <Badge variant={run.outcome === "PASS" ? "success" : "destructive"}>{run.outcome}</Badge>
                  <span className="text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</span>
                </div>
                {run.tests.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 font-mono text-xs">
                    {run.tests.map((t) => (
                      <li key={t.name} className="flex items-center gap-2">
                        {t.passed ? <CheckCircle2 className="size-3.5 text-success" /> : <XCircle className="size-3.5 text-destructive" />}
                        {t.name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          )}
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Usage</p>
          <p className="text-sm">
            {task.usage.totalTokens.toLocaleString()} tokens
            <span className="text-muted-foreground">
              {" "}· {task.usage.inputTokens.toLocaleString()} in / {task.usage.outputTokens.toLocaleString()} out
            </span>
          </p>
        </section>
      </div>
    </ScrollArea>
  );
}

export function CanvasPanelContent({
  tab,
  estimate,
  task,
  events,
}: {
  tab: CanvasTab;
  estimate: ProjectEstimate | null;
  task: TaskDetail | null;
  events: ExecutionEvent[];
}) {
  switch (tab) {
    case "plan":
      return estimate ? (
        <ScrollArea className="h-full">
          <div className="p-4">
            <PlanView estimate={estimate} />
          </div>
        </ScrollArea>
      ) : (
        <Empty>Describe what you want built and the agent will draft a plan here.</Empty>
      );
    case "changes":
      return <FileChangesPanel events={events} />;
    case "terminal":
      return <TerminalActivityPanel events={events} />;
    case "chain":
      return task ? <ChainPanel taskId={task.id} /> : <Empty>No build yet.</Empty>;
    case "checks":
      return task ? <ChecksPanel task={task} /> : <Empty>No build yet.</Empty>;
  }
}
