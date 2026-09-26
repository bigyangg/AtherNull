"use client";

import { useState } from "react";
import { ClipboardCheck, FileText, RefreshCcw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { IconBadge } from "@/components/icon-badge";
import {
  useApproveEstimate,
  useGenerateEstimate,
  useProjectEstimates,
  useReviseEstimate,
} from "@/lib/hooks/use-project-estimates";
import { formatMinor, type EstimateStatus, type ProjectEstimate } from "@/lib/types";

const STATUS_VARIANT: Record<EstimateStatus, "muted" | "warning" | "success" | "default"> = {
  DRAFT: "muted",
  READY_FOR_REVIEW: "warning",
  APPROVED: "success",
  SUPERSEDED: "muted",
};

function EstimateStatusBadge({ status }: { status: EstimateStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status.replace(/_/g, " ")}</Badge>;
}

function BulletList({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">None specified.</p>;
  }
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-foreground">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function CostCard({ estimate }: { estimate: ProjectEstimate }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <IconBadge>
          <ShieldCheck />
        </IconBadge>
        <CardTitle className="text-base">Cost estimate</CardTitle>
      </CardHeader>
      <CardContent>
        {estimate.pricingStatus === "PRICED" &&
        estimate.estimatedMinMinor !== null &&
        estimate.estimatedMaxMinor !== null &&
        estimate.proposedBudgetCapMinor !== null &&
        estimate.currency ? (
          <div className="flex flex-col gap-1">
            <p className="text-lg font-semibold">
              {formatMinor(estimate.estimatedMinMinor, estimate.currency)} –{" "}
              {formatMinor(estimate.estimatedMaxMinor, estimate.currency)}
            </p>
            <p className="text-sm text-muted-foreground">
              Proposed budget cap: {formatMinor(estimate.proposedBudgetCapMinor, estimate.currency)}
              {estimate.rateVersion ? ` (rate card ${estimate.rateVersion})` : ""}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-lg font-semibold text-muted-foreground">Unpriced</p>
            <p className="text-sm text-muted-foreground">
              No rate card is configured yet — this plan has no real cost figure to show. Once
              pricing is configured, revising this scope will produce a real range and budget cap.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlanView({ estimate }: { estimate: ProjectEstimate }) {
  const { plannerOutput: plan } = estimate;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-muted-foreground">Goal</p>
        <p className="text-sm text-foreground">{plan.goal}</p>
      </div>
      <Separator />
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-sm font-medium text-muted-foreground">In scope</p>
          <BulletList items={plan.scope.included} />
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-muted-foreground">Out of scope</p>
          <BulletList items={plan.scope.excluded} />
        </div>
      </div>
      <Separator />
      <div>
        <p className="mb-1 text-sm font-medium text-muted-foreground">Deliverables</p>
        <BulletList items={plan.deliverables} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-muted-foreground">Implementation plan</p>
        <BulletList items={plan.implementationPlan} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-muted-foreground">Acceptance criteria</p>
        <BulletList items={plan.acceptanceCriteria} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-muted-foreground">Infrastructure requirements</p>
        <BulletList items={plan.infrastructureRequirements} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-muted-foreground">Assumptions</p>
        <BulletList items={plan.assumptions} />
      </div>
      <div>
        <p className="mb-1 text-sm font-medium text-muted-foreground">Risks</p>
        <BulletList items={plan.risks} />
      </div>
    </div>
  );
}

// Phase 4A's focused scope/build-plan/cost-estimate view. Deliberately not
// role-gated on the client — no other privileged action in this app is
// either (see components/tasks/review-panel.tsx's accept/reject, which show
// unconditionally and rely on apps/api's 403); the backend's
// requirePrivilegedRole is the actual security boundary, and a denied
// approve surfaces its error inline the same way fund/accept/reject already
// do elsewhere in this app.
export function ScopeEstimatePanel({ projectId }: { projectId: string }) {
  const { data: estimates, isLoading } = useProjectEstimates(projectId);
  const generateEstimate = useGenerateEstimate(projectId);
  const reviseEstimate = useReviseEstimate(projectId);
  const approveEstimate = useApproveEstimate(projectId);

  const [prompt, setPrompt] = useState("");
  const [revising, setRevising] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One lineage per project's planning conversation is the common case —
  // show the latest lineage's current head (highest version, any status).
  // Superseded rows from earlier revisions remain reachable via the version
  // history list below, never deleted or hidden entirely.
  const latestLineageId = estimates?.at(-1)?.lineageId ?? null;
  const lineageVersions =
    estimates?.filter((e) => e.lineageId === latestLineageId).sort((a, b) => a.version - b.version) ??
    [];
  const head = lineageVersions.at(-1) ?? null;

  async function handleGenerate() {
    setError(null);
    try {
      await generateEstimate.mutateAsync(prompt.trim());
      setPrompt("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleRevise() {
    if (!head) return;
    setError(null);
    try {
      await reviseEstimate.mutateAsync({ estimateId: head.id, prompt: prompt.trim() });
      setPrompt("");
      setRevising(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleApprove() {
    if (!head) return;
    setError(null);
    try {
      await approveEstimate.mutateAsync(head.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  const isBusy = generateEstimate.isPending || reviseEstimate.isPending || approveEstimate.isPending;

  return (
    <div className="flex flex-col gap-4">
      {(!head || revising) && (
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <IconBadge>
              <FileText />
            </IconBadge>
            <CardTitle className="text-base">
              {head ? "Revise scope" : "Describe what to build"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Textarea
              rows={4}
              placeholder="e.g. Build a small SaaS issue tracker with email authentication, projects, issues, comments, PostgreSQL and a simple admin dashboard."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                disabled={prompt.trim().length === 0 || isBusy}
                onClick={head ? handleRevise : handleGenerate}
              >
                {generateEstimate.isPending || reviseEstimate.isPending
                  ? "Generating…"
                  : head
                    ? "Submit revision"
                    : "Generate plan"}
              </Button>
              {head && revising && (
                <Button variant="outline" disabled={isBusy} onClick={() => setRevising(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {head && !revising && (
        <>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-3">
                <IconBadge>
                  <ClipboardCheck />
                </IconBadge>
                <CardTitle className="text-base">
                  Scope — v{head.version}
                  {lineageVersions.length > 1 ? ` of ${lineageVersions.length}` : ""}
                </CardTitle>
              </div>
              <EstimateStatusBadge status={head.status} />
            </CardHeader>
            <CardContent>
              <PlanView estimate={head} />
            </CardContent>
          </Card>

          <CostCard estimate={head} />

          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={isBusy || head.status === "SUPERSEDED"}
              onClick={() => setRevising(true)}
            >
              <RefreshCcw /> Revise scope
            </Button>
            <Button
              disabled={isBusy || head.status !== "READY_FOR_REVIEW"}
              onClick={handleApprove}
            >
              {approveEstimate.isPending ? "Approving…" : "Approve scope"}
            </Button>
          </div>

          {head.status === "APPROVED" && head.approvedAt && (
            <p className="text-sm text-muted-foreground">
              Approved {new Date(head.approvedAt).toLocaleString()}.
            </p>
          )}
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
