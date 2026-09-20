import type { ReactNode } from "react";

import { UserMenu } from "@/components/auth/user-menu";
import { CurrentOrgProvider } from "@/lib/auth/current-org-provider";

export default function ProjectsLayout({ children }: { children: ReactNode }) {
  return (
    <CurrentOrgProvider>
      <div className="flex justify-end border-b border-border px-6 py-3">
        <UserMenu />
      </div>
      {children}
    </CurrentOrgProvider>
  );
}
