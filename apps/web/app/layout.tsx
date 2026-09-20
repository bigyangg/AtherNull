import type { ReactNode } from "react";

import "./globals.css";
import { QueryProvider } from "@/lib/query-provider";

export const metadata = {
  title: "AtherNull",
  description: "Multi-tenant AI agent platform for shipping real code.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
