"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { useCurrentOrg } from "@/lib/auth/current-org-provider";

export function UserMenu() {
  const router = useRouter();
  const { userEmail } = useCurrentOrg();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5">
      <span className="truncate text-xs text-muted-foreground" title={userEmail}>
        {userEmail}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        disabled={signingOut}
        onClick={handleSignOut}
      >
        <LogOut className="size-3.5" />
        {signingOut ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
