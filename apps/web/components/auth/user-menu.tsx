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
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground">{userEmail}</span>
      <Button variant="ghost" size="sm" disabled={signingOut} onClick={handleSignOut}>
        <LogOut /> Sign out
      </Button>
    </div>
  );
}
