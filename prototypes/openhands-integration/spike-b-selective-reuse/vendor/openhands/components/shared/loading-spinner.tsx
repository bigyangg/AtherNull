// SPIKE-B genuine Next.js blocker fix (see MANIFEST.md "?react SVG imports"
// row): swapped `*.svg?react` (Vite/SVGR-only) for a lucide-react equivalent.
import { Loader2 as LoadingSpinnerOuter } from "lucide-react";
import { cn } from "#/utils/utils";

interface LoadingSpinnerProps {
  size: "small" | "large";
  className?: string;
  outerClassName?: string;
}

export function LoadingSpinner({
  size,
  className,
  outerClassName,
}: LoadingSpinnerProps) {
  const sizeStyle = size === "small" ? "w-6.25 h-6.25" : "w-12.5 h-12.5";

  return (
    <div
      data-testid="loading-spinner"
      className={cn("relative", sizeStyle, className)}
    >
      <LoadingSpinnerOuter
        className={cn("absolute animate-spin", sizeStyle, outerClassName)}
      />
    </div>
  );
}
