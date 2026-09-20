import type { ReactNode } from "react";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import { BudgetMeter } from "@/components/workspace/budget-meter";
import type { BuildStep, BuildStepStatus } from "@/lib/types";

const STEP_ICON: Record<BuildStepStatus, ReactNode> = {
  queued: <CircleDashed className="size-4 text-muted-foreground" />,
  running: <Loader2 className="size-4 animate-spin text-primary" />,
  completed: <CheckCircle2 className="size-4 text-success" />,
  failed: <XCircle className="size-4 text-destructive" />,
};

const STEP_LABEL: Record<BuildStepStatus, string> = {
  queued: "Queued",
  running: "In progress",
  completed: "Completed",
  failed: "Failed",
};

export function ActivityPanel({
  buildSteps,
  budgetSpentMinor,
  budgetMaxMinor,
  currency,
}: {
  buildSteps: BuildStep[];
  budgetSpentMinor: number;
  budgetMaxMinor: number;
  currency: string;
}) {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div>
        <p className="mb-3 text-xs font-medium text-muted-foreground">
          Build activity
        </p>
        <ul className="flex flex-col gap-2.5">
          {buildSteps.map((step) => (
            <li
              key={step.id}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="flex items-center gap-2">
                {STEP_ICON[step.status]}
                {step.label}
              </span>
              <span
                className={
                  step.status === "completed"
                    ? "text-success"
                    : step.status === "running"
                      ? "text-primary"
                      : step.status === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground"
                }
              >
                {STEP_LABEL[step.status]}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Separator className="mt-auto" />

      <BudgetMeter
        spentMinor={budgetSpentMinor}
        maxMinor={budgetMaxMinor}
        currency={currency}
      />
    </div>
  );
}
