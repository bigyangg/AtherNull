import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function AuthCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "w-full max-w-sm rounded-2xl border-white/[0.08] bg-panel/90 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_32px_64px_-24px_rgba(0,0,0,0.9)] backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </Card>
  );
}
