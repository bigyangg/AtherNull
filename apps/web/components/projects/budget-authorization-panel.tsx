"use client";

import { useState } from "react";
import { Landmark } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { IconBadge } from "@/components/icon-badge";
import {
  useAuthorizeBudget,
  useBudgetAuthorizations,
} from "@/lib/hooks/use-budget-authorizations";
import { formatMinor, type BudgetAuthorizationStatus, type ProjectEstimate } from "@/lib/types";

// Phase 4B — Authorized Project Budget and Build Activation Boundary.
//
// This panel commits a real money AMOUNT against an APPROVED estimate. It
// is deliberately NOT funding and NOT settlement: authorizing a budget here
// creates zero task/execution/payment rows (see
// apps/api/src/routes/budget-authorizations.ts's header comment and
// docs/adr/0009-authorized-project-budget.md). To keep that boundary honest
// in the UI, this component must never render the words "Funded", "Paid",
// "Deposited", "Escrowed", or "Settled" — only "Authorized" / "Active" /
// "Superseded" — and must never show any Solana/eSewa/Khalti payment UI.
// Turning an authorization into a real funded task is entirely Phase 4C's
// job.

const STATUS_VARIANT: Record<BudgetAuthorizationStatus, "muted" | "success"> = {
  ACTIVE: "success",
  SUPERSEDED: "muted",
  // Phase 4C — a canonical task was created from this exact authorization.
  // Rendered as a quiet, successful terminal state, same tone as ACTIVE
  // (this was a legitimate, completed use of the authorization), never
  // implying anything about payment ("CONSUMED" here means "spent on
  // preparing a build," not "paid").
  CONSUMED: "success",
};

export function BudgetAuthorizationPanel({
  projectId,
  estimate,
}: {
  projectId: string;
  estimate: ProjectEstimate;
}) {
  const { data: authorizations, isLoading } = useBudgetAuthorizations(projectId, estimate.id);
  const authorizeBudget = useAuthorizeBudget(projectId, estimate.id);

  const canUseProposedCap =
    estimate.pricingStatus === "PRICED" && estimate.proposedBudgetCapMinor !== null && estimate.currency !== null;

  const [amountInput, setAmountInput] = useState("");
  const [currency, setCurrency] = useState(estimate.currency ?? "USD");
  const [error, setError] = useState<string | null>(null);

  const active = authorizations?.find((a) => a.status === "ACTIVE") ?? null;
  const history = authorizations?.filter((a) => a.id !== active?.id) ?? [];

  async function handleAuthorizeProposedCap() {
    if (!canUseProposedCap || !estimate.currency) return;
    setError(null);
    try {
      await authorizeBudget.mutateAsync({
        source: "ESTIMATE_PROPOSED_CAP",
        currency: estimate.currency,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleAuthorizeUserSet() {
    setError(null);
    const parsed = Number(amountInput);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError("Enter a whole number of minor currency units (e.g. cents) greater than zero.");
      return;
    }
    try {
      await authorizeBudget.mutateAsync({
        source: "USER_SET",
        amountMinor: parsed,
        currency: currency.trim().toUpperCase(),
      });
      setAmountInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (estimate.status !== "APPROVED") {
    return null;
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading budget authorization…</p>;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3">
          <IconBadge>
            <Landmark />
          </IconBadge>
          <CardTitle className="text-base">Authorized budget</CardTitle>
        </div>
        {active && <Badge variant={STATUS_VARIANT[active.status]}>{active.status}</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {active ? (
          <div className="flex flex-col gap-1">
            <p className="text-lg font-semibold">{formatMinor(active.amountMinor, active.currency)}</p>
            <p className="text-sm text-muted-foreground">
              Authorized {new Date(active.authorizedAt).toLocaleString()}
              {active.source === "ESTIMATE_PROPOSED_CAP" ? " from this estimate's proposed cap." : " (manually set)."}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No budget has been authorized yet. This does not create or fund any task — it only records
            the amount a privileged member has committed to this exact estimate.
          </p>
        )}

        {estimate.pricingStatus === "PRICED" ? (
          <p className="text-sm text-muted-foreground">
            This estimate is priced. Proposed cap:{" "}
            {estimate.proposedBudgetCapMinor !== null && estimate.currency
              ? formatMinor(estimate.proposedBudgetCapMinor, estimate.currency)
              : "—"}
            .
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            This estimate is unpriced — no rate card is configured. You may still authorize an
            explicit amount below.
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 gap-2">
            <Input
              type="number"
              min={1}
              step={1}
              placeholder="Amount (minor units)"
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value)}
              disabled={authorizeBudget.isPending}
            />
            <Input
              className="w-24"
              placeholder="USD"
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              disabled={authorizeBudget.isPending}
            />
          </div>
          <Button
            variant="outline"
            disabled={authorizeBudget.isPending || amountInput.trim().length === 0}
            onClick={handleAuthorizeUserSet}
          >
            {authorizeBudget.isPending ? "Authorizing…" : active ? "Correct amount" : "Authorize amount"}
          </Button>
          {canUseProposedCap && (
            <Button disabled={authorizeBudget.isPending} onClick={handleAuthorizeProposedCap}>
              Use proposed cap
            </Button>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {history.length > 0 && (
          <div className="flex flex-col gap-1 pt-2">
            <p className="text-sm font-medium text-muted-foreground">History</p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {history.map((a) => (
                <li key={a.id}>
                  {formatMinor(a.amountMinor, a.currency)} —{" "}
                  {a.status === "CONSUMED" ? "used to prepare a build" : "superseded"}, authorized{" "}
                  {new Date(a.authorizedAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
