import type { ReactNode } from "react";

export function TimelineRow({
  icon,
  title,
  right,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-1 py-3 text-sm first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </div>
      {children && (
        <div className="flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
          {children}
        </div>
      )}
    </li>
  );
}
