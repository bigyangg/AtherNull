"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { devnetExplorerAddressUrl, devnetExplorerTxUrl, formatDevnetSol } from "@athernull/contracts";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { Connection, Transaction } from "@solana/web3.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  Copy,
  ExternalLink,
  Globe,
  Hammer,
  Loader2,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wallet,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dashboardApi } from "@/lib/api";
import { useBuildPatch } from "@/lib/hooks/use-build-patch";
import { useProjectFunding, useSettlementProgress } from "@/lib/hooks/use-project-funding";
import { useAcceptTask, useRefundTask, useRejectTask } from "@/lib/hooks/use-tasks";
import { useTask } from "@/lib/hooks/use-task";
import { formatMinor, TASK_STATUS_DISPLAY, type ChatBuildState, type ProjectEstimate, type TaskStatus } from "@/lib/types";

// Chat-native builds: the card at the end of a canvas discussion. The whole
// journey happens here — draft the plan, approve it, see the bill, pay with
// a wallet, watch the build, review and accept. Every step calls the same
// guarded apps/api endpoints the Builds page uses; this card decides
// nothing about money itself.

const WALLET_DEVNET_ENDPOINT = "https://api.devnet.solana.com";
const POLL_MS = 3_000;
const POLL_MAX_MS = 3 * 60_000;

const ACTIVE = new Set<TaskStatus>(["AWAITING_FUNDING", "FUNDED", "QUEUED", "RUNNING", "VERIFYING", "SETTLING", "REFUNDING"]);

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");
const key = (discussionId: string) => ["chat-build", discussionId] as const;

export function useChatBuild(discussionId: string) {
  return useQuery({
    queryKey: key(discussionId),
    queryFn: () => dashboardApi.getChatBuild(discussionId),
    refetchInterval: (query) => {
      const status = query.state.data?.task?.status;
      return status && ACTIVE.has(status) ? 4_000 : 15_000;
    },
  });
}

// The whole journey, shown on every step so the customer always knows where
// they are and what comes next.
const JOURNEY = ["Plan", "Bill", "Pay", "Build", "Done"] as const;
type Stage = 0 | 1 | 2 | 3 | 4;

// What the build agent is allowed per run (ORG_SANDBOX_MAX_RUN_SECONDS in the
// worker): the honest time figure, unlike the planner's human-hours estimate.
const AGENT_RUN_CAP = "up to 30 min";

function Journey({ stage, failedAt }: { stage: Stage; failedAt?: number }) {
  return (
    <ol className="flex items-center gap-1.5 px-3.5 pb-2.5 text-[11px]">
      {JOURNEY.map((label, i) => {
        const failed = failedAt !== undefined && i === failedAt;
        const done = !failed && i < (failedAt ?? stage);
        const current = failedAt === undefined && i === stage;
        const tone = failed
          ? "bg-destructive/15 font-medium text-destructive"
          : current
            ? "bg-primary/15 font-medium text-foreground"
            : done
              ? "text-success"
              : "text-muted-foreground";
        return (
          <li key={label} className="flex items-center gap-1.5">
            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 ${tone}`}>
              {failed ? (
                <XCircle className="size-3" />
              ) : done ? (
                <CheckCircle2 className="size-3" />
              ) : (
                <Circle className={`size-2 ${current ? "fill-current text-primary" : ""}`} />
              )}
              {label}
            </span>
            {i < JOURNEY.length - 1 && <span className={`h-px w-3 ${done ? "bg-success/60" : "bg-border"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Step({
  icon,
  title,
  badge,
  stage,
  failedAt,
  children,
  details,
  detailsLabel = "details",
  discussionId,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  stage: Stage;
  /** The journey step that failed (shown with a cross), if any. */
  failedAt?: number;
  children: ReactNode;
  /** Secondary information, folded away in the chat and open on the full page. */
  details?: ReactNode;
  detailsLabel?: string;
  discussionId: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-panel shadow-sm">
      <div className="border-b border-border">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2 text-sm font-medium [&>svg]:size-4 [&>svg]:text-muted-foreground">
          {icon}
          <span className="min-w-0 flex-1 truncate text-base">{title}</span>
          {badge}
        </div>
        <Journey stage={stage} failedAt={failedAt} />
      </div>
      <div className="flex flex-col gap-3.5 p-4 text-sm">{children}</div>
      {details && (
        <div className="flex flex-col gap-3 border-t border-border bg-background/30 p-4 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{detailsLabel}</p>
          {details}
        </div>
      )}
    </div>
  );
}

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

function Checklist({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1 text-muted-foreground">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          {item}
        </li>
      ))}
    </ul>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p className="text-sm text-destructive">{error}</p> : null;
}

/**
 * Approve -> budget -> task -> project account, each step idempotent, so a
 * failure part-way can simply be retried and resumes where it stopped.
 */
async function checkout(state: ChatBuildState) {
  const plan = state.plan;
  if (!plan) throw new Error("There is no plan to approve.");
  if (plan.status === "READY_FOR_REVIEW") await dashboardApi.approveEstimate(plan.projectId, plan.id);

  let taskId = state.task?.id;
  if (!taskId) {
    let authorizationId = state.authorization?.status === "ACTIVE" ? state.authorization.id : null;
    if (!authorizationId) {
      const priced = plan.pricingStatus === "PRICED" && plan.proposedBudgetCapMinor !== null && plan.currency;
      const authorization = await dashboardApi.authorizeBudget(
        plan.projectId,
        plan.id,
        priced
          ? { source: "ESTIMATE_PROPOSED_CAP", currency: plan.currency! }
          : { source: "USER_SET", amountMinor: state.defaultBudget.amountMinor, currency: state.defaultBudget.currency },
      );
      authorizationId = authorization.id;
    }
    const profiles = await dashboardApi.listAgentProfiles();
    if (!profiles[0]) throw new Error("No agent profile is configured for this organization.");
    const task = await dashboardApi.prepareBuild(plan.projectId, {
      budgetAuthorizationId: authorizationId,
      agentProfileId: profiles[0].id,
      repositoryRevision: "main",
    });
    taskId = task.id;
  }
  if (!(await dashboardApi.getProjectFunding(taskId))) await dashboardApi.createProjectFunding(taskId);
}

function DraftStep({ discussionId }: { discussionId: string }) {
  const queryClient = useQueryClient();
  const draft = useMutation({
    mutationFn: () => dashboardApi.draftChatPlan(discussionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key(discussionId) }),
  });
  return (
    <Step icon={<Sparkles />} title="Ready to build?" stage={0} discussionId={discussionId}>
      <p className="text-muted-foreground">
        When the scope looks right, turn this conversation into a plan. You&apos;ll review it, see the bill and pay right
        here.
      </p>
      <div>
        <Button size="sm" disabled={draft.isPending} onClick={() => draft.mutate()}>
          {draft.isPending ? <Loader2 className="animate-spin" /> : <ClipboardList />}
          {draft.isPending ? "Drafting the plan… (up to a minute)" : "Draft plan"}
        </Button>
      </div>
      <ErrorLine error={draft.error ? message(draft.error) : null} />
    </Step>
  );
}

function PlanStep({ state }: { state: ChatBuildState }) {
  const plan = state.plan!;
  const out = plan.plannerOutput;
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: key(state.discussionId) });
  const update = useMutation({ mutationFn: () => dashboardApi.updateChatPlan(state.discussionId), onSuccess: refresh });
  const approve = useMutation({ mutationFn: () => checkout(state), onSettled: refresh });
  const approved = plan.status === "APPROVED";

  return (
    <Step
      icon={<ClipboardList />}
      title={`Plan v${plan.version}`}
      badge={<Badge variant={approved ? "success" : "warning"}>{approved ? "Approved" : "Needs your approval"}</Badge>}
      stage={approved ? 1 : 0}
      discussionId={state.discussionId}
      detailsLabel="The plan"
      details={
        <>
          {out.deliverables.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deliverables</p>
              <Checklist items={out.deliverables} />
            </div>
          )}
          {out.acceptanceCriteria.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Done when</p>
              <Checklist items={out.acceptanceCriteria} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Built by the AtherNull agent ({AGENT_RUN_CAP}), then checked by an independent verifier before any payment is
            released.
          </p>
        </>
      }
    >
      <p className="font-medium text-foreground">{out.goal}</p>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-md bg-background/60 px-2 py-1 text-muted-foreground">
          <span className="font-medium text-foreground">{out.deliverables.length}</span> deliverable{out.deliverables.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-md bg-background/60 px-2 py-1 text-muted-foreground">
          <span className="font-medium text-foreground">{out.acceptanceCriteria.length}</span> acceptance check{out.acceptanceCriteria.length === 1 ? "" : "s"}
        </span>
        <span className="rounded-md bg-background/60 px-2 py-1 text-muted-foreground">Agent build · {AGENT_RUN_CAP}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={approve.isPending || update.isPending} onClick={() => approve.mutate()}>
          {approve.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          {approve.isPending ? "Preparing your bill…" : approved ? "Continue to the bill" : "Approve plan"}
        </Button>
        {!approved && (
          <Button size="sm" variant="outline" disabled={approve.isPending || update.isPending} onClick={() => update.mutate()}>
            {update.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {update.isPending ? "Updating…" : "Update plan from chat"}
          </Button>
        )}
      </div>
      {!approved && (
        <p className="text-xs text-muted-foreground">Want changes? Tell the agent in the chat, then press “Update plan from chat”.</p>
      )}
      <ErrorLine error={approve.error ? message(approve.error) : update.error ? message(update.error) : null} />
    </Step>
  );
}

function InvoiceLine({ label, detail, value }: { label: string; detail?: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="text-foreground">{label}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
      <div className="shrink-0 text-right text-foreground">{value}</div>
    </div>
  );
}

function BillRows({ plan, budget }: { plan: ProjectEstimate; budget: { amountMinor: number; currency: string } }) {
  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-background/40 px-3">
      <InvoiceLine label={plan.plannerOutput.goal} detail={`Approved plan v${plan.version}`} value="Build" />
      <InvoiceLine label="AI agent build" detail="Runs in your private workspace" value={AGENT_RUN_CAP} />
      <InvoiceLine label="Independent verification" detail="Tests re-run offline on a clean copy" value="Included" />
      <InvoiceLine
        label="Usage cap"
        detail="The build stops before going over"
        value={formatMinor(budget.amountMinor, budget.currency)}
      />
    </div>
  );
}

function PayStep({ state }: { state: ChatBuildState }) {
  const task = state.task!;
  const queryClient = useQueryClient();
  const { data: funding, isLoading } = useProjectFunding(task.id);
  const resume = useMutation({
    mutationFn: () => checkout(state),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key(state.discussionId) });
      queryClient.invalidateQueries({ queryKey: ["project-funding", task.id] });
    },
  });

  return (
    <Step
      icon={<Receipt />}
      title={`Invoice ${task.id.slice(0, 8).toUpperCase()}`}
      badge={<Badge variant="warning">Awaiting payment</Badge>}
      stage={funding?.status === "FUNDED" ? 3 : 2}
      discussionId={state.discussionId}
      detailsLabel="Invoice"
      details={
        <>
          <BillRows plan={state.plan!} budget={{ amountMinor: task.budgetMinor, currency: task.currency }} />
          {funding && (
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>Escrow account (Solana Devnet)</span>
              <a
                href={devnetExplorerAddressUrl(funding.onchainAccount)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-mono hover:text-foreground"
              >
                {short(funding.onchainAccount)} <ExternalLink className="size-3" />
              </a>
            </div>
          )}
        </>
      }
    >
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background/40 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Total due</p>
          <p className="text-xl font-semibold tracking-tight text-foreground">
            {funding ? `${formatDevnetSol(funding.requiredLamports)} SOL` : "…"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <Badge variant="info">Solana Devnet</Badge>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3 text-success" /> Held in escrow
          </span>
        </div>
      </div>
      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !funding ? (
        <div className="flex flex-col gap-2">
          <Button size="sm" className="self-start" disabled={resume.isPending} onClick={() => resume.mutate()}>
            {resume.isPending ? <Loader2 className="animate-spin" /> : <Receipt />} Continue
          </Button>
          <ErrorLine error={resume.error ? message(resume.error) : null} />
        </div>
      ) : (
        <ConnectionProvider endpoint={WALLET_DEVNET_ENDPOINT}>
          <WalletProvider wallets={[]} autoConnect={false}>
            <PayNow discussionId={state.discussionId} taskId={task.id} funded={funding.status === "FUNDED"} />
          </WalletProvider>
        </ConnectionProvider>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Released to AtherNull only when you accept the build; refunded if it fails. Devnet test funds, no real money.
      </p>
    </Step>
  );
}

function PayNow({ discussionId, taskId, funded }: { discussionId: string; taskId: string; funded: boolean }) {
  const queryClient = useQueryClient();
  const { wallets, wallet, publicKey, connected, connecting, select, connect, sendTransaction } = useWallet();
  const connection = useMemo(() => new Connection(WALLET_DEVNET_ENDPOINT, "confirmed"), []);
  const [busy, setBusy] = useState<null | "connecting" | "preparing" | "signing" | "confirming" | "starting">(null);
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [payAfterConnect, setPayAfterConnect] = useState(false);
  const cancelled = useRef(false);
  const started = useRef(false);
  const installed = wallets.filter((w) => w.readyState === "Installed");

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: key(discussionId) });
    queryClient.invalidateQueries({ queryKey: ["project-funding", taskId] });
  }, [queryClient, discussionId, taskId]);

  // Paid: start the build (the activation gate re-checks the funding itself).
  const startBuild = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setBusy("starting");
    try {
      await dashboardApi.fundTask(taskId);
    } catch (err) {
      started.current = false;
      setError(message(err));
    } finally {
      setBusy(null);
      refresh();
    }
  }, [taskId, refresh]);

  useEffect(() => {
    if (funded) void startBuild();
  }, [funded, startBuild]);

  const pay = useCallback(async () => {
    if (!publicKey) return;
    setError(null);
    try {
      setBusy("preparing");
      let res = await dashboardApi.prepareProjectFunding(taskId, { customerWallet: publicKey.toBase58() });
      for (let i = 0; i < 6 && res.state === "INITIALIZING"; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        res = await dashboardApi.prepareProjectFunding(taskId, { customerWallet: publicKey.toBase58() });
      }
      if (res.state !== "READY" || !res.transaction) throw new Error("The project account is still being created on Solana Devnet. Try again in a moment.");
      setBusy("signing");
      const tx = Transaction.from(Uint8Array.from(atob(res.transaction.base64), (c) => c.charCodeAt(0)));
      const sig = await sendTransaction(tx, connection);
      setSignature(sig);
      setBusy("confirming");
      // Credited only once Solana finalizes and AtherNull verifies it.
      const t0 = Date.now();
      while (!cancelled.current && Date.now() - t0 < POLL_MAX_MS) {
        try {
          const v = await dashboardApi.verifyProjectFunding(taskId, sig);
          if (v.signature?.outcome === "CREDITED" || v.signature?.outcome === "ALREADY_CREDITED") {
            setBusy(null);
            refresh();
            if (v.funding.status === "FUNDED") await startBuild();
            return;
          }
        } catch (err) {
          if (!/VERIFICATION_UNAVAILABLE|retriable/i.test(message(err))) throw err;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      throw new Error("Still waiting for Solana to finalize. This card updates by itself once it does.");
    } catch (err) {
      setBusy(null);
      setError(message(err));
    }
  }, [publicKey, taskId, sendTransaction, connection, refresh, startBuild]);

  // "Pay now" before a wallet was connected: connect, then carry on paying.
  useEffect(() => {
    if (!payAfterConnect) return;
    if (wallet && !connected && !connecting) {
      connect().catch((err: unknown) => {
        setPayAfterConnect(false);
        setBusy(null);
        setError(message(err));
      });
    } else if (connected && publicKey) {
      setPayAfterConnect(false);
      void pay();
    }
  }, [payAfterConnect, wallet, connected, connecting, publicKey, connect, pay]);

  function payWith(name: Parameters<typeof select>[0]) {
    setError(null);
    setBusy("connecting");
    if (wallet?.adapter.name !== name) select(name);
    setPayAfterConnect(true);
  }

  const label = {
    connecting: "Connecting wallet…",
    preparing: "Preparing payment…",
    signing: "Approve in your wallet…",
    confirming: "Confirming on Solana…",
    starting: "Starting your build…",
  };

  if (funded) {
    return (
      <div className="flex flex-col gap-2">
        <p className="flex items-center gap-2 text-success">
          <CheckCircle2 className="size-4" /> Paid. {busy === "starting" ? "Starting your build…" : ""}
        </p>
        {error && (
          <Button size="sm" variant="outline" className="self-start" onClick={() => void startBuild()}>
            Start build
          </Button>
        )}
        <ErrorLine error={error} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {busy ? (
        <Button size="sm" disabled className="self-start">
          <Loader2 className="animate-spin" /> {label[busy]}
        </Button>
      ) : connected && publicKey ? (
        <Button size="sm" className="self-start" onClick={() => void pay()}>
          <Wallet /> Pay now · {wallet?.adapter.name}
        </Button>
      ) : installed.length === 0 ? (
        <NoWallet discussionId={discussionId} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {installed.map((w) => (
            <Button key={w.adapter.name} size="sm" onClick={() => payWith(w.adapter.name)}>
              <Wallet /> {installed.length === 1 ? "Pay now" : `Pay with ${w.adapter.name}`}
            </Button>
          ))}
        </div>
      )}
      {signature && (
        <a className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground" href={devnetExplorerTxUrl(signature)} target="_blank" rel="noreferrer">
          View transaction <ExternalLink className="size-3" />
        </a>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * No wallet extension in this browser (e.g. an editor's built-in browser):
 * the same payment page works in any browser with Phantom or Solflare, after
 * signing in there.
 */
function NoWallet({ discussionId }: { discussionId: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/chat-build/${encodeURIComponent(discussionId)}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("yes");
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      setCopied("failed"); // e.g. an editor's built-in browser: show the link to copy by hand
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <Wallet className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">No wallet in this browser</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Open the payment page in Chrome or Brave with Phantom or Solflare set to Devnet.
          </p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => void copy()}>
          {copied === "yes" ? <CheckCircle2 /> : <Copy />} {copied === "yes" ? "Copied" : "Copy link"}
        </Button>
      </div>
      {copied === "failed" && <p className="select-all break-all font-mono text-[11px] text-muted-foreground">{url}</p>}
    </div>
  );
}

/** A worker failure reason in plain words (anything unrecognised is shown as reported). */
function friendlyFailure(reason: string): string {
  if (/wall time/i.test(reason)) return "it ran out of time (each build may run for up to 30 minutes)";
  if (/ended in status/i.test(reason)) return "the agent hit an error and stopped before finishing";
  if (/starting the conversation failed/i.test(reason)) return "the build agent could not be started in your workspace";
  if (/no agent sandbox/i.test(reason)) return "your workspace was not ready";
  if (/USAGE_ENFORCEMENT_FAILED/.test(reason)) return "it reached its usage limit";
  return reason.length > 220 ? `${reason.slice(0, 220)}…` : reason;
}

const STOPPED = new Set<TaskStatus>(["FAILED", "CANCELLED", "REJECTED", "REFUNDING", "REFUNDED"]);

const PROGRESS: { label: string; reached: TaskStatus[] }[] = [
  { label: "Paid", reached: ["FUNDED", "QUEUED", "RUNNING", "VERIFYING", "AWAITING_ACCEPTANCE", "ACCEPTED", "SETTLING", "SETTLED"] },
  { label: "Building", reached: ["RUNNING", "VERIFYING", "AWAITING_ACCEPTANCE", "ACCEPTED", "SETTLING", "SETTLED"] },
  { label: "Verified", reached: ["AWAITING_ACCEPTANCE", "ACCEPTED", "SETTLING", "SETTLED"] },
  { label: "Accepted", reached: ["ACCEPTED", "SETTLING", "SETTLED"] },
];

function BuildStep({ state }: { state: ChatBuildState }) {
  const taskId = state.task!.id;
  const { data: task } = useTask(taskId);
  const status = (task?.status ?? state.task!.status) as TaskStatus;
  const display = TASK_STATUS_DISPLAY[status];
  const reviewing = status === "AWAITING_ACCEPTANCE";
  const { data: patch } = useBuildPatch(taskId, status === "RUNNING" || status === "VERIFYING");
  useSettlementProgress(taskId, status === "SETTLING" || status === "REFUNDING");
  const accept = useAcceptTask(taskId);
  const reject = useRejectTask(taskId);
  const refund = useRefundTask(taskId);
  // Newest first: a retried build's latest attempt and checks are what count.
  const run = [...(task?.verificationRuns ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const lastAttempt = [...(task?.executions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const stopped = STOPPED.has(status);
  // Verified and then turned down (directly, or refunded after a reject).
  const rejected = status === "REJECTED" || (stopped && status !== "FAILED" && run?.outcome === "PASS");
  let why: string | null = null;
  if (stopped) {
    if (run?.outcome === "FAIL") why = `The independent checks failed: ${String(run.evidence?.reason ?? "the tests did not pass")}.`;
    else if (lastAttempt?.failureReason) why = `The build did not finish: ${friendlyFailure(lastAttempt.failureReason)}.`;
    else if (rejected) why = "You rejected the result after it was verified.";
  }
  // What actually happened, not the success path.
  const progressReached = (label: string, reached: TaskStatus[]) => {
    if (!stopped) return reached.includes(status);
    if (label === "Paid") return true;
    if (label === "Building") return Boolean(lastAttempt);
    if (label === "Verified") return run?.outcome === "PASS";
    return false;
  };
  const error = accept.error ?? reject.error ?? refund.error;

  return (
    <Step
      icon={<Hammer />}
      title="Your build"
      badge={<Badge variant={display.tone === "default" ? "info" : display.tone}>{display.label}</Badge>}
      stage={status === "SETTLED" || status === "REFUNDED" ? 4 : 3}
      failedAt={stopped ? (run?.outcome === "PASS" ? 4 : 3) : undefined}
      discussionId={state.discussionId}
      detailsLabel="Code changes"
      details={
        patch ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {patch.filesChanged} file{patch.filesChanged === 1 ? "" : "s"} changed · +{patch.insertions} −{patch.deletions}
            </p>
            <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed">{patch.patch}</pre>
          </div>
        ) : undefined
      }
    >
      <p className="text-foreground">{state.plan?.plannerOutput.goal}</p>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {PROGRESS.map((p) => {
          const done = progressReached(p.label, p.reached);
          return (
            <li key={p.label} className={`flex items-center gap-1.5 ${done ? "text-foreground" : "text-muted-foreground"}`}>
              {done ? <CheckCircle2 className="size-3.5 text-success" /> : <Circle className="size-3.5" />}
              {p.label}
            </li>
          );
        })}
      </ol>
      {(status === "QUEUED" || status === "RUNNING" || status === "VERIFYING") && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {status === "QUEUED" ? "Waiting for an agent…" : status === "RUNNING" ? "The agent is building it…" : "Running the checks independently…"}
        </p>
      )}

      {run && (
        <p className={run.outcome === "PASS" ? "text-success" : "text-destructive"}>
          Verification {run.outcome === "PASS" ? "passed" : "failed"}: {run.tests.filter((t) => t.passed).length}/{run.tests.length} checks
        </p>
      )}

      {state.task?.previewUrl && (
        <a
          href={state.task.previewUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 self-start rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent/40"
        >
          <Globe className="size-4 text-success" /> Open live app <ExternalLink className="size-3 text-muted-foreground" />
        </a>
      )}

      {reviewing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={accept.isPending || reject.isPending} onClick={() => accept.mutate()}>
            <CheckCircle2 /> {accept.isPending ? "Accepting…" : "Accept & release payment"}
          </Button>
          <Button size="sm" variant="outline" disabled={accept.isPending || reject.isPending} onClick={() => reject.mutate(undefined)}>
            <XCircle /> {reject.isPending ? "Rejecting…" : "Reject & refund"}
          </Button>
        </div>
      )}
      {status === "FAILED" && (
        <Button size="sm" variant="outline" className="self-start" disabled={refund.isPending} onClick={() => refund.mutate()}>
          {refund.isPending ? "Refunding…" : "Refund my payment"}
        </Button>
      )}
      {status === "SETTLED" && <p className="text-success">Done. The payment was released and the code is yours.</p>}
      {stopped && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <XCircle className="size-4 text-destructive" />
            {rejected ? "You rejected this build" : "This build didn't succeed"}
          </p>
          {why && <p className="text-xs leading-relaxed text-muted-foreground">{why}</p>}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {status === "REFUNDED"
              ? "Your payment was refunded to your wallet on Solana Devnet. You were not charged."
              : status === "REFUNDING"
                ? "Your refund is on its way back to your wallet…"
                : status === "FAILED"
                  ? "You have not been charged. Get your payment back with the button below."
                  : "You were not charged for this build."}
          </p>
        </div>
      )}
      <ErrorLine error={error ? message(error) : null} />
    </Step>
  );
}

export function ChatBuildCard({ discussionId }: { discussionId: string }) {
  const { data: state, isLoading } = useChatBuild(discussionId);
  if (isLoading || !state) return null;
  if (!state.plan) return state.messageCount > 0 ? <DraftStep discussionId={discussionId} /> : null;
  if (!state.task) return <PlanStep state={state} />;
  if (state.task.status === "AWAITING_FUNDING") return <PayStep state={state} />;
  return <BuildStep state={state} />;
}

/** One progress dot in the bar: done, current, failed (red) or not yet. */
function dotTone(i: number, stage: number, failedAt: number | undefined): string {
  if (failedAt !== undefined) return i === failedAt ? "w-5 bg-destructive" : i < failedAt ? "w-3 bg-success" : "w-3 bg-border";
  return i < stage ? "w-3 bg-success" : i === stage ? "w-5 bg-primary" : "w-3 bg-border";
}

/** The bar's content for each point of the journey. */
function barContent(state: ChatBuildState, requiredLamports: string | null) {
  const goal = state.plan?.plannerOutput.goal ?? "";
  const status = state.task?.status;
  if (!state.plan) {
    return { stage: 0 as Stage, icon: <Sparkles />, title: "Ready to build?", note: "Turn this chat into a plan and a bill", action: "Draft plan" };
  }
  if (!state.task) {
    const approved = state.plan.status === "APPROVED";
    return {
      stage: (approved ? 1 : 0) as Stage,
      icon: <ClipboardList />,
      title: goal,
      note: approved ? `Plan v${state.plan.version} approved` : `Plan v${state.plan.version} needs your approval`,
      action: approved ? "View bill" : "Review plan",
    };
  }
  const amount = requiredLamports ? ` · ${formatDevnetSol(requiredLamports)} SOL` : "";
  if (status === "AWAITING_FUNDING") {
    return {
      stage: 2 as Stage,
      icon: <Receipt />,
      title: `Invoice ${state.task.id.slice(0, 8).toUpperCase()}${amount}`,
      note: "Awaiting payment · held in escrow until you accept",
      action: "Pay now",
    };
  }
  const display = status ? TASK_STATUS_DISPLAY[status] : null;
  if (status === "AWAITING_ACCEPTANCE") {
    return { stage: 3 as Stage, icon: <Hammer />, title: goal, note: "Verified · ready for your review", action: "Review & accept" };
  }
  if (status === "SETTLED") {
    return { stage: 4 as Stage, icon: <CheckCircle2 />, title: goal, note: "Done · payment released", action: "View" };
  }
  if (status === "FAILED") {
    return { stage: 3 as Stage, icon: <XCircle />, title: goal, note: "Build didn't succeed · you can get your payment back", action: "See why", failedAt: 3 };
  }
  if (status === "REFUNDING" || status === "REFUNDED") {
    return {
      stage: 4 as Stage,
      icon: <XCircle />,
      title: goal,
      note: status === "REFUNDING" ? "Refund on its way to your wallet" : "Refunded to your wallet · not charged",
      failedAt: 3,
      action: "See why",
    };
  }
  const working = status === "FUNDED" || status === "QUEUED" || status === "RUNNING" || status === "VERIFYING";
  return {
    stage: 3 as Stage,
    icon: working ? <Loader2 className="animate-spin" /> : <Hammer />,
    title: goal,
    note: display?.label ?? "In progress",
    action: working ? "View progress" : "View",
  };
}

/**
 * The fixed-height bar at the end of a discussion in the canvas: where the
 * build is and the one thing to do next. Its button opens the whole build in
 * the canvas's large panel (patch 0006); opened outside the canvas, it links
 * to the full page instead.
 */
export function ChatBuildBar({ discussionId }: { discussionId: string }) {
  const { data: state, isLoading } = useChatBuild(discussionId);
  const taskId = state?.task?.id ?? null;
  const { data: funding } = useQuery({
    queryKey: ["project-funding", taskId ?? "none"],
    queryFn: () => dashboardApi.getProjectFunding(taskId!),
    enabled: taskId !== null && state?.task?.status === "AWAITING_FUNDING",
  });
  const visible = !isLoading && !!state && (!!state.plan || state.messageCount > 0);

  useEffect(() => {
    window.parent.postMessage({ type: "athernull:chat-build", discussionId, visible }, window.location.origin);
  }, [discussionId, visible]);

  if (!visible || !state) return null;
  const bar = barContent(state, funding?.requiredLamports ?? null);

  function open() {
    if (window.self !== window.top) {
      window.parent.postMessage({ type: "athernull:open-build", discussionId }, window.location.origin);
    } else {
      window.location.href = `/chat-build/${encodeURIComponent(discussionId)}`;
    }
  }

  return (
    <div className="flex h-16 items-center gap-3 rounded-xl border border-border bg-panel px-3.5 shadow-sm">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary [&>svg]:size-4">
        {bar.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{bar.title}</p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1" aria-label={`Step ${bar.stage + 1} of ${JOURNEY.length}`}>
            {JOURNEY.map((label, i) => (
              <span
                key={label}
                title={label}
                className={`h-1.5 rounded-full ${dotTone(i, bar.stage, "failedAt" in bar ? bar.failedAt : undefined)}`}
              />
            ))}
          </span>
          <span className="truncate">{bar.note}</span>
        </div>
      </div>
      <Button size="sm" className="shrink-0" onClick={open}>
        {bar.action}
      </Button>
    </div>
  );
}
