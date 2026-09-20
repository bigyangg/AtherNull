import type { ReactNode } from "react";
import Link from "next/link";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden bg-[#09090b] px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[-16rem] h-[36rem] bg-[radial-gradient(ellipse_at_top,_var(--info)_0%,_transparent_60%)] opacity-[0.10]"
      />
      <Link href="/" className="relative z-10 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-sm font-bold text-background">
          A
        </span>
        <span className="text-sm font-semibold tracking-tight text-foreground">
          AtherNull
        </span>
      </Link>
      <div className="relative z-10 flex w-full flex-col items-center">
        {children}
      </div>
    </main>
  );
}
