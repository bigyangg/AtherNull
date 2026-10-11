"use client";

import { useState, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, ClipboardList, Landmark, Rocket } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentTurn } from "@/components/canvas/agent-timeline";
import { useAgentProfiles } from "@/lib/hooks/use-agent-profiles";
import { useAuthorizeBudget } from "@/lib/hooks/use-budget-authorizations";
import { useApproveEstimate } from "@/lib/hooks/use-project-estimates";
import { usePrepareBuild } from "@/lib/hooks/use-tasks";
import { formatMinor, type BudgetAuthorization, type ProjectEstimate } from "@/lib/types";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}

function StepCard({ icon, title, badge, children }: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-sm font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
        {icon}
        <span className="flex-1">{title}</span>
        {badge}
      </div>
      <div className="flex flex-col gap-3 p-3.5">{children}</div>
    </div>
  );
}

// One plan version as the agent's reply to the prompt that produced it.
// Only the lineage head is actionable; earlier versions stay readable.
export function PlanTurn({
  projectId,
  estimate,
  isHead,
  onOpenPlan,
}: {
  projectId: string;
  estimate: ProjectEstimate;
  isHead: boolean;
  onOpenPlan: () => void;
}) {
  const approve = useApproveEstimate(projectId);
  const [error, setError] = useState<string | null>(null);
  const plan = estimate.plannerOutput;

  if (!isHead) {
    return (
      <AgentTurn>
        <p className="text-sm text-muted-foreground">
          Drafted plan v{estimate.version}: {plan.goal}
        </p>
      </AgentTurn>
    );
  }

  const intro =
    estimate.status === "APPROVED"
      ? "Plan approved. Here's what I'll build:"
      : "Here's my plan. Approve it, or tell me what to change below.";

  return (
    <AgentTurn>
      <p className="text-sm text-foreground">{intro}</p>
      <StepCard
        icon={<ClipboardList />}
        title={`Plan v${estimate.version}`}
        badge={
          <Badge variant={estimate.status === "APPROVED" ? "success" : "warning"}>
            {estimate.status === "APPROVED" ? "Approved" : "Needs approval"}
          </Badge>
        }
      >
        <p className="text-sm text-foreground">{plan.goal}</p>
        {plan.deliverables.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {plan.deliverables.slice(0, 5).map((d, i) => (
              <li key={i} className="flex gap-2">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                {d}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{plan.acceptanceCriteria.length} acceptance criteria</span>
          <span>~{plan.resourceEstimate.estimatedDurationHours.min}–{plan.resourceEstimate.estimatedDurationHours.max}h</span>
          <span>tier {plan.resourceEstimate.inferenceRequirements.estimatedTier}</span>
          {estimate.pricingStatus === "PRICED" && estimate.estimatedMinMinor !== null && estimate.estimatedMaxMinor !== null && estimate.currency && (
            <span>
              {formatMinor(estimate.estimatedMinMinor, estimate.currency)}–
              {formatMinor(estimate.estimatedMaxMinor, estimate.currency)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onOpenPlan}>
            Full plan
          </Button>
          {estimate.status === "READY_FOR_REVIEW" && (
            <Button
              size="sm"
              disabled={approve.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await approve.mutateAsync(estimate.id);
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              {approve.isPending ? "Approving…" : "Approve plan"}
            </Button>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </StepCard>
    </AgentTurn>
  );
}

// Parses a decimal amount ("25" or "25.50") into minor units without floats.
function toMinor(input: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

export function BudgetTurn({
  projectId,
  estimate,
  authorization,
}: {
  projectId: string;
  estimate: ProjectEstimate;
  authorization: BudgetAuthorization | null;
}) {
  const authorize = useAuthorizeBudget(projectId, estimate.id);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const currency = estimate.currency ?? "USD";
  const proposed =
    estimate.pricingStatus === "PRICED" && estimate.proposedBudgetCapMinor !== null && estimate.currency
      ? estimate.proposedBudgetCapMinor
      : null;

  if (authorization) {
    return (
      <AgentTurn>
        <p className="text-sm text-foreground">
          Budget authorized: <span className="font-medium">{formatMinor(authorization.amountMinor, authorization.currency)}</span>.
          I won&apos;t spend past it.
        </p>
      </AgentTurn>
    );
  }

  async function run(input: Parameters<typeof authorize.mutateAsync>[0]) {
    setError(null);
    try {
      await authorize.mutateAsync(input);
      setAmount("");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <AgentTurn>
      <p className="text-sm text-foreground">Set the most this build may cost. I stop before going over it.</p>
      <StepCard icon={<Landmark />} title="Authorize budget">
        <div className="flex flex-wrap gap-2">
          {proposed !== null && (
            <Button
              size="sm"
              disabled={authorize.isPending}
              onClick={() => run({ source: "ESTIMATE_PROPOSED_CAP", currency })}
            >
              Use proposed cap · {formatMinor(proposed, currency)}
            </Button>
          )}
          <div className="flex min-w-0 flex-1 gap-2">
            <Input
              inputMode="decimal"
              placeholder={`Amount in ${currency}, e.g. 25`}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={authorize.isPending}
              className="h-8"
            />
            <Button
              size="sm"
              variant={proposed !== null ? "outline" : "default"}
              disabled={authorize.isPending || amount.trim() === ""}
              onClick={() => {
                const minor = toMinor(amount);
                if (minor === null) {
                  setError("Enter a positive amount, e.g. 25 or 25.50.");
                  return;
                }
                void run({ source: "USER_SET", amountMinor: minor, currency });
              }}
            >
              {authorize.isPending ? "Authorizing…" : "Authorize"}
            </Button>
          </div>
        </div>
        {estimate.pricingStatus !== "PRICED" && (
          <p className="text-xs text-muted-foreground">No rate card is configured, so the plan has no priced range. Set the cap yourself.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </StepCard>
    </AgentTurn>
  );
}

export function PrepareTurn({
  projectId,
  authorization,
  defaultRevision,
  onPrepared,
}: {
  projectId: string;
  authorization: BudgetAuthorization;
  defaultRevision: string;
  onPrepared: (taskId: string) => void;
}) {
  const prepare = usePrepareBuild(projectId);
  const { data: profiles, isLoading } = useAgentProfiles();
  const [revision, setRevision] = useState(defaultRevision || "main");
  const [error, setError] = useState<string | null>(null);
  const profileId = profiles?.[0]?.id;

  return (
    <AgentTurn>
      <p className="text-sm text-foreground">Ready to set up the build. Which revision should I start from?</p>
      <StepCard icon={<Rocket />} title="Prepare build">
        <div className="flex gap-2">
          <Input
            aria-label="Repository revision"
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            className="h-8 font-mono text-xs"
          />
          <Button
            size="sm"
            disabled={!profileId || revision.trim() === "" || prepare.isPending}
            onClick={async () => {
              if (!profileId) return;
              setError(null);
              try {
                const task = await prepare.mutateAsync({
                  budgetAuthorizationId: authorization.id,
                  agentProfileId: profileId,
                  repositoryRevision: revision.trim(),
                });
                onPrepared(task.id);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            {prepare.isPending ? "Preparing…" : "Prepare build"} <ArrowRight />
          </Button>
        </div>
        {!isLoading && !profileId && (
          <p className="text-xs text-warning">No agent profile is configured for this organization. An admin needs to add one first.</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </StepCard>
    </AgentTurn>
  );
}
