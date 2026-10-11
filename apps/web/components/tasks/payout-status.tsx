"use client";

import { useState } from "react";
import { devnetExplorerTxUrl, formatDevnetSol } from "@athernull/contracts";
import { CheckCircle2, Coins, ExternalLink, Loader2, RotateCcw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProjectFunding, useSettlementProgress } from "@/lib/hooks/use-project-funding";
import { useRefundTask } from "@/lib/hooks/use-tasks";
import type { TaskDetail } from "@/lib/types";

function short(value: string) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// Phase 4E.2 — where the build's devnet deposit went. Accept settles it
// (release to the provider, any over-funding back to the customer), reject
// or a failed build refunds it; the server reports FINALIZED only once the
// payout transaction is finalized on chain. Renders nothing for a build that
// never had a confirmed deposit.
export function PayoutStatus({ task }: { task: TaskDetail }) {
  const inFlight = task.status === "SETTLING" || task.status === "REFUNDING";
  const progress = useSettlementProgress(task.id, inFlight);
  const { data: funding } = useProjectFunding(task.id);
  const refund = useRefundTask(task.id);
  const [error, setError] = useState<string | null>(null);

  if (!funding || BigInt(funding.confirmedLamports) === 0n) return null;
  const settlement = funding.settlement;
  const refundable = !settlement && (task.status === "FAILED" || task.status === "CANCELLED");
  if (!settlement && !refundable) return null;

  if (refundable) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-3.5">
        <p className="text-sm text-foreground">
          This build didn&apos;t pass. Refund the {formatDevnetSol(funding.confirmedLamports)} devnet SOL deposit to your wallet.
        </p>
        <div>
          <Button
            size="sm"
            disabled={refund.isPending}
            onClick={async () => {
              setError(null);
              try {
                await refund.mutateAsync();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Refund failed.");
              }
            }}
          >
            <RotateCcw /> {refund.isPending ? "Refunding…" : "Refund deposit"}
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  const s = settlement!;
  const finalized = s.status === "FINALIZED";
  const label = s.kind === "SETTLE" ? "Payment settled" : "Deposit refunded";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-3.5">
      <div className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4">
        {finalized ? <CheckCircle2 className="text-success" /> : <Loader2 className="animate-spin text-info" />}
        <span className="flex-1">{finalized ? label : s.kind === "SETTLE" ? "Settling on Solana devnet…" : "Refunding on Solana devnet…"}</span>
        <Badge variant={finalized ? "success" : "info"}>
          {finalized ? "Finalized" : s.status === "SUBMITTED" ? "Awaiting finality" : "Sending"}
        </Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {s.kind === "SETTLE" && (
          <>
            <dt className="text-muted-foreground">To provider</dt>
            <dd className="text-right">
              {formatDevnetSol(s.releaseLamports)} SOL
              {s.recipientWallet && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{short(s.recipientWallet)}</span>}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Back to you</dt>
        <dd className="text-right">
          {formatDevnetSol(s.refundLamports)} SOL
          <span className="ml-1.5 font-mono text-xs text-muted-foreground">{short(s.customerWallet)}</span>
        </dd>
      </dl>
      {s.signature && (
        <a
          href={devnetExplorerTxUrl(s.signature)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Coins className="size-3.5" /> Payout transaction <span className="font-mono">{short(s.signature)}</span>
          <ExternalLink className="size-3" />
        </a>
      )}
      {progress.isError && (
        <p className="text-xs text-warning">Couldn&apos;t reach the chain just now. Retrying…</p>
      )}
    </div>
  );
}
