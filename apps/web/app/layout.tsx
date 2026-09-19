import type { ReactNode } from "react";

export const metadata = {
  title: "AtherNull",
  description: "Multi-tenant AI agent platform — task console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
