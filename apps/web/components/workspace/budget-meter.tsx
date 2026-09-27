import { Progress } from "@/components/ui/progress";
import { formatMinor } from "@/lib/types";

export function BudgetMeter({
  spentMinor,
  maxMinor,
  currency,
}: {
  // Phase 4D.1: null means "real usage exists but its cost is genuinely
  // unknown" (no rate card yet) — never render $0.00 for that case, which
  // would falsely imply zero cost was incurred. Only a real number (0 or
  // otherwise) renders the numeric meter.
  spentMinor: number | null;
  maxMinor: number;
  currency: string;
}) {
  if (spentMinor === null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">AI budget</span>
          <span className="text-muted-foreground">Cost — Not priced yet</span>
        </div>
        <Progress value={0} />
      </div>
    );
  }

  const pct = maxMinor > 0 ? Math.min(100, (spentMinor / maxMinor) * 100) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">AI budget</span>
        <span className="text-foreground">
          {formatMinor(spentMinor, currency)} / {formatMinor(maxMinor, currency)}
        </span>
      </div>
      <Progress value={pct} />
    </div>
  );
}
