import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { IconBadge } from "@/components/icon-badge";

export function PageHeader({
  backHref,
  icon,
  title,
  subtitle,
  trailing,
}: {
  backHref?: string;
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        {backHref && (
          <Link
            href={backHref}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
        )}
        {icon && <IconBadge>{icon}</IconBadge>}
        <div>
          <h1 className="text-xl font-semibold leading-tight">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {trailing && <div className="flex items-center gap-2">{trailing}</div>}
    </div>
  );
}
