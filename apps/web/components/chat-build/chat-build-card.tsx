"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { devnetExplorerTxUrl, formatDevnetSol } from "@athernull/contracts";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { Connection, Transaction } from "@solana/web3.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  ExternalLink,
  Hammer,
  Loader2,
  Receipt,
  RefreshCw,
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

function Step({ icon, title, badge, children }: { icon: ReactNode; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        <span className="flex-1">{title}</span>
        {badge}
      </div>
      <div className="flex flex-col gap-3 p-3.5 text-sm">{children}</div>
    </div>
  );
}

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
    <Step icon={<Sparkles />} title="Ready to build?">
      <p className="text-muted-foreground">
        When the scope looks right, draft a plan from this conversation. You&apos;ll approve it and pay right here.
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
    >
      <p className="font-medium text-foreground">{out.goal}</p>
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
        Estimated {out.resourceEstimate.estimatedDurationHours.min}–{out.resourceEstimate.estimatedDurationHours.max} h of agent work
      </p>
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

function BillRows({ plan, budget }: { plan: ProjectEstimate; budget: { amountMinor: number; currency: string } }) {
  const hours = plan.plannerOutput.resourceEstimate.estimatedDurationHours;
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5">
      <dt className="text-muted-foreground">Build: {plan.plannerOutput.goal}</dt>
      <dd className="text-right">Plan v{plan.version}</dd>
      <dt className="text-muted-foreground">Agent work (estimated)</dt>
      <dd className="text-right">
        {hours.min}–{hours.max} h
      </dd>
      <dt className="text-muted-foreground">Independent verification</dt>
      <dd className="text-right">Included</dd>
      <dt className="text-muted-foreground">Usage cap (the build stops before going over)</dt>
      <dd className="text-right">{formatMinor(budget.amountMinor, budget.currency)}</dd>
    </dl>
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
    <Step icon={<Receipt />} title="Your bill" badge={<Badge variant="warning">Awaiting payment</Badge>}>
      <BillRows plan={state.plan!} budget={{ amountMinor: task.budgetMinor, currency: task.currency }} />
      <div className="flex items-center justify-between border-t border-border pt-3 font-medium">
        <span>Amount due</span>
        <span>{funding ? `${formatDevnetSol(funding.requiredLamports)} devnet SOL` : "…"}</span>
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
      <p className="text-xs text-muted-foreground">Solana Devnet — test value only, no real funds. Paid into the project account, released only when you accept the build.</p>
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
        <div className="flex flex-col gap-1.5">
          <p className="text-muted-foreground">No Solana wallet found here. Install Phantom or Solflare (set to Devnet), or pay in a new tab.</p>
          <a
            href={`/chat-build/${encodeURIComponent(discussionId)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 self-start text-primary underline-offset-4 hover:underline"
          >
            Pay in a new tab <ExternalLink className="size-3" />
          </a>
        </div>
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
  const [showDiff, setShowDiff] = useState(false);
  const run = task?.verificationRuns?.at(-1);
  const failed = status === "FAILED" || status === "CANCELLED" || status === "REJECTED";
  const error = accept.error ?? reject.error ?? refund.error;

  return (
    <Step
      icon={<Hammer />}
      title="Your build"
      badge={<Badge variant={display.tone === "default" ? "info" : display.tone}>{display.label}</Badge>}
    >
      <p className="text-foreground">{state.plan?.plannerOutput.goal}</p>
      <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {PROGRESS.map((p) => {
          const done = p.reached.includes(status);
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

      {patch && (
        <div className="flex flex-col gap-2">
          <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowDiff((v) => !v)}>
            {patch.filesChanged} file{patch.filesChanged === 1 ? "" : "s"} changed · +{patch.insertions} −{patch.deletions} · {showDiff ? "Hide" : "View"} changes
          </button>
          {showDiff && (
            <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed">{patch.patch}</pre>
          )}
        </div>
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
      {status === "REFUNDED" && <p className="text-muted-foreground">Refunded to your wallet.</p>}
      {failed && status !== "FAILED" && <p className="text-muted-foreground">This build was stopped.</p>}
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
