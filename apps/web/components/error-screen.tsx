import Link from "next/link";
import type { ReactNode } from "react";
import { Home, LifeBuoy, RotateCcw } from "lucide-react";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import { Button } from "@/components/ui/button";
import landing from "@/app/landing.module.css";
import legal from "@/app/legal.module.css";

// One error language for the whole web app: what happened, what you can do
// next, and a reference to quote to support. "site" is the public, light
// marketing shell; "app" is the signed-in product's own theme.

export const SUPPORT_EMAIL = "support@athernull.io";

export interface ErrorScreenProps {
  /** Small label above the title, e.g. "404" or "Error". */
  code: string;
  title: string;
  message: ReactNode;
  /** Shown as "Reference: …" so a report can be matched to the server log. */
  reference?: string;
  /** Re-renders the failed segment (Next.js error boundaries). */
  onRetry?: () => void;
  /** Where "Go home" leads. */
  homeHref?: string;
  homeLabel?: string;
}

function Actions({
  onRetry,
  homeHref = "/",
  homeLabel = "Go home",
  reference,
  primaryClassName,
}: ErrorScreenProps & { primaryClassName?: string }) {
  const mail = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("AtherNull issue")}${
    reference ? `&body=${encodeURIComponent(`Reference: ${reference}\n\nWhat I was doing:\n`)}` : ""
  }`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {onRetry && (
        <Button size="sm" className={primaryClassName} onClick={onRetry}>
          <RotateCcw /> Try again
        </Button>
      )}
      <Button asChild size="sm" variant={onRetry ? "outline" : "default"} className={onRetry ? undefined : primaryClassName}>
        <Link href={homeHref}>
          <Home /> {homeLabel}
        </Link>
      </Button>
      <Button asChild size="sm" variant="ghost">
        <a href={mail}>
          <LifeBuoy /> Contact support
        </a>
      </Button>
    </div>
  );
}

/** The public site's error page: site header and footer around the message. */
export function SiteErrorScreen(props: ErrorScreenProps) {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={legal.hero}>
        <span>{props.code}</span>
        <h1>{props.title}</h1>
        <p>{props.message}</p>
        <div className="mt-8">
          <Actions {...props} primaryClassName={landing.darkButton} />
        </div>
        {props.reference && <p className="mt-6 font-mono text-xs text-neutral-400">Reference: {props.reference}</p>}
      </section>
      <SiteFooter />
    </main>
  );
}

/** The signed-in app's error panel, in the product's own theme. */
export function AppErrorScreen(props: ErrorScreenProps) {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-panel p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{props.code}</p>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{props.title}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{props.message}</p>
        <Actions {...props} />
        {props.reference && <p className="font-mono text-xs text-muted-foreground">Reference: {props.reference}</p>}
      </div>
    </main>
  );
}

/** A small inline error for embedded views (the in-chat build card). */
export function InlineError({ title, message, onRetry }: { title: string; message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry}>
          <RotateCcw /> Retry
        </Button>
      )}
    </div>
  );
}
