import React, { ReactNode } from "react";
import { cn } from "#/utils/utils";

/**
 * SPIKE-B STUB (see MANIFEST.md "StyledTooltip" row). Upstream implements
 * this with `@heroui/react`'s `<Tooltip>`, which drags in HeroUI's whole
 * theming plugin (`hero.ts`, `tailwind.config.js`, `--heroui-*` CSS vars,
 * `themes/color-themes.ts`) — unrelated to either target reuse unit and a
 * disproportionate side-quest for a presentation-only harness. Re-implemented
 * here as a native `title`-attribute tooltip with the same prop surface so
 * every real vendored file that imports `StyledTooltip` (chat-message.tsx,
 * generic-event-message.tsx, ...) is unmodified.
 */
export interface StyledTooltipProps {
  children: ReactNode;
  content: string | ReactNode;
  tooltipClassName?: React.HTMLAttributes<HTMLDivElement>["className"];
  placement?: "top" | "bottom" | "left" | "right";
  showArrow?: boolean;
  closeDelay?: number;
  offset?: number;
  shouldFlip?: boolean;
  isOpen?: boolean;
}

export function StyledTooltip({
  children,
  content,
  tooltipClassName,
}: StyledTooltipProps) {
  const title = typeof content === "string" ? content : undefined;
  return (
    <span title={title} className={cn("inline-flex", tooltipClassName)}>
      {children}
    </span>
  );
}
