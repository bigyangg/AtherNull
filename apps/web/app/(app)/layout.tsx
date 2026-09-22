import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { CurrentOrgProvider } from "@/lib/auth/current-org-provider";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <CurrentOrgProvider>
      <div className="flex min-h-screen flex-col lg:flex-row">
        <AppSidebar />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </CurrentOrgProvider>
  );
}
