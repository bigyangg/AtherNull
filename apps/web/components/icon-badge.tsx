import type { ReactNode } from "react";

export function IconBadge({ children }: { children: ReactNode }) {
  return (
    <div className="flex size-11 items-center justify-center rounded-xl border border-border text-foreground [&_svg]:size-5">
      {children}
    </div>
  );
}
