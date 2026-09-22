import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Spike B — OpenHands selective reuse harness",
  description:
    "Isolated Next.js harness vendoring 2 OpenHands presentation components (event feed, terminal) to measure adapter/integration cost.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
