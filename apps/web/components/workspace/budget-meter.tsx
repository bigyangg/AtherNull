import { Progress } from "@/components/ui/progress";
import { formatMinor } from "@/lib/types";

export function BudgetMeter({
  spentMinor,
  maxMinor,
  currency,
}: {
  spentMinor: number;
  maxMinor: number;
  currency: string;
}) {
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
