import { Plug } from "lucide-react";
import { siGithub, siJira, siNotion, type SimpleIcon } from "simple-icons";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";

// simple-icons has no Slack entry (see app/page.tsx, which hits the same gap
// and falls back to a hand-drawn logo) — same fix here.
function SlackLogo() {
  return (
    <svg viewBox="0 0 80 80" role="img" aria-label="Slack logo" className="size-5">
      <path fill="#E01E5A" d="M17.0676 50.1813C17.0676 54.7603 13.3668 58.4612 8.78773 58.4612C4.20868 58.4612.507812 54.7603.507812 50.1813S4.20868 41.9014 8.78773 41.9014h8.27987v8.2799ZM21.2076 50.1813c0-4.5791 3.7009-8.2799 8.2799-8.2799s8.2799 3.7008 8.2799 8.2799v20.6998c0 4.579-3.7008 8.2799-8.2799 8.2799s-8.2799-3.7009-8.2799-8.2799V50.1813Z" />
      <path fill="#36C5F0" d="M29.4877 16.9358c-4.579 0-8.2799-3.7009-8.2799-8.27991S24.9087.375977 29.4877.375977s8.28 3.700873 8.28 8.279913v8.27991h-8.28ZM29.4877 21.1385c4.5791 0 8.28 3.7009 8.28 8.2799s-3.7009 8.2799-8.28 8.2799H8.72523c-4.57905 0-8.279918-3.7008-8.279918-8.2799s3.700868-8.2799 8.279918-8.2799H29.4877Z" />
      <path fill="#2EB67D" d="M62.6685 29.4184c0-4.579 3.7009-8.2799 8.28-8.2799s8.2799 3.7009 8.2799 8.2799-3.7009 8.2799-8.2799 8.2799h-8.28v-8.2799ZM58.5286 29.4184c0 4.5791-3.7009 8.2799-8.2799 8.2799s-8.2799-3.7008-8.2799-8.2799V8.65589c0-4.57904 3.7009-8.279913 8.2799-8.279913s8.2799 3.700873 8.2799 8.279913V29.4184Z" />
      <path fill="#ECB22E" d="M50.2487 62.6012c4.579 0 8.2799 3.7008 8.2799 8.2799s-3.7009 8.2799-8.2799 8.2799-8.2799-3.7009-8.2799-8.2799v-8.2799h8.2799ZM50.2487 58.4612c-4.5791 0-8.2799-3.7009-8.2799-8.2799s3.7008-8.2799 8.2799-8.2799h20.7625c4.579 0 8.2799 3.7009 8.2799 8.2799s-3.7009 8.2799-8.2799 8.2799H50.2487Z" />
    </svg>
  );
}

// Same brand set the landing page promises (app/page.tsx's INTEGRATIONS) —
// none of these are wired up yet (see docs/dashboard-routes-report.md), so
// every card reads "Coming soon" rather than claiming a connection exists.
const INTEGRATIONS: { name: string; icon: SimpleIcon | null; description: string }[] = [
  {
    name: "GitHub",
    icon: siGithub,
    description: "Beyond importing a repository, no app install, checks, or status sync yet.",
  },
  {
    name: "Slack",
    icon: null,
    description: "Get review/settlement notifications where your team already talks.",
  },
  {
    name: "Jira",
    icon: siJira,
    description: "Turn a ticket into a task without copy-pasting the brief.",
  },
  {
    name: "Notion",
    icon: siNotion,
    description: "Give agents extra context straight from your docs.",
  },
] as const;

export default function IntegrationsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        icon={<Plug />}
        title="Integrations"
        subtitle="Connect AtherNull to the rest of your stack."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {INTEGRATIONS.map(({ name, icon, description }) => (
          <Card key={name}>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-3">
                <div
                  className="flex size-11 items-center justify-center rounded-xl border border-border"
                  style={icon ? { background: `#${icon.hex}14` } : undefined}
                >
                  {icon ? (
                    <svg viewBox="0 0 24 24" role="img" aria-label={`${name} logo`} className="size-5" style={{ color: `#${icon.hex}` }}>
                      <path fill="currentColor" d={icon.path} />
                    </svg>
                  ) : (
                    <SlackLogo />
                  )}
                </div>
                <CardTitle className="text-base">{name}</CardTitle>
              </div>
              <Badge variant="muted">Coming soon</Badge>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{description}</CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
