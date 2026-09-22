"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Gauge,
  LayoutDashboard,
  Menu,
  FolderGit2,
  Plug,
  Plus,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { UserMenu } from "@/components/auth/user-menu";
import { cn } from "@/lib/utils";
import { useNeedsReviewCount } from "@/lib/hooks/use-needs-review-count";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderGit2, showReviewBadge: true },
  { href: "/skill-sets", label: "Skill sets", icon: Wrench },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/integrations", label: "Integrations", icon: Plug },
] as const;

function isActive(pathname: string, href: string): boolean {
  return href === "/dashboard" ? pathname === href : pathname.startsWith(href);
}

function BrandMark() {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-2 px-4 py-4 text-sm font-semibold"
      aria-label="AtherNull home"
    >
      <Image src="/brand/athernull-icon.png" alt="" width={20} height={20} />
      AtherNull
    </Link>
  );
}

function NavList({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const needsReviewCount = useNeedsReviewCount();

  return (
    <nav className="flex flex-col gap-0.5 px-2">
      {NAV_ITEMS.map(({ href, label, icon: Icon, ...rest }) => {
        const active = isActive(pathname, href);
        const showBadge = "showReviewBadge" in rest && rest.showReviewBadge && needsReviewCount > 0;
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1">{label}</span>
            {showBadge && (
              <Badge variant="warning" className="px-1.5 py-0 text-[11px]">
                {needsReviewCount}
              </Badge>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarBody({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <BrandMark />
      <div className="px-2 pb-3">
        <Button asChild className="w-full justify-start">
          <Link href="/projects/new/import" onClick={onNavigate}>
            <Plus /> New project
          </Link>
        </Button>
      </div>
      <NavList pathname={pathname} onNavigate={onNavigate} />
      <div className="mt-auto border-t border-border p-2">
        <UserMenu />
      </div>
    </div>
  );
}

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop: fixed left column. */}
      <aside className="hidden w-64 shrink-0 border-r border-border bg-panel lg:block">
        <div className="sticky top-0 h-screen">
          <SidebarBody pathname={pathname} />
        </div>
      </aside>

      {/* Mobile/tablet: slim top bar that opens the same nav in a Sheet. */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2 lg:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open navigation">
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarBody pathname={pathname} />
          </SheetContent>
        </Sheet>
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-sm font-semibold"
          aria-label="AtherNull home"
        >
          <Image src="/brand/athernull-icon.png" alt="" width={20} height={20} />
          AtherNull
        </Link>
        <div className="w-9" />
      </div>
    </>
  );
}
