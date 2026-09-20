"use client";

import { createContext, useContext, type ReactNode } from "react";

import { authClient } from "@/lib/auth/client";

// Real session/org wiring for ADR-0004 (docs/adr/0004-better-auth-for-identity.md).
// No organization-creation UI exists yet (that's a separate Phase 6 slice),
// so `organizationId` is legitimately null until a user creates or is
// invited into one — callers must handle that, not assume it's always set.
interface CurrentOrg {
  organizationId: string | null;
  organizationName: string;
  userId: string;
  userName: string;
  userEmail: string;
}

const CurrentOrgContext = createContext<CurrentOrg | null>(null);

export function CurrentOrgProvider({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!data) {
    // Middleware already keeps unauthenticated requests off these routes;
    // this only fires if a session expires mid-visit.
    if (typeof window !== "undefined") {
      window.location.href = "/sign-in";
    }
    return null;
  }

  const activeOrganizationId =
    (data.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;

  const value: CurrentOrg = {
    organizationId: activeOrganizationId,
    organizationName: activeOrganizationId ? "Workspace" : "Personal",
    userId: data.user.id,
    userName: data.user.name,
    userEmail: data.user.email,
  };

  return (
    <CurrentOrgContext.Provider value={value}>{children}</CurrentOrgContext.Provider>
  );
}

export function useCurrentOrg(): CurrentOrg {
  const ctx = useContext(CurrentOrgContext);
  if (!ctx) {
    throw new Error("useCurrentOrg must be used within CurrentOrgProvider");
  }
  return ctx;
}
