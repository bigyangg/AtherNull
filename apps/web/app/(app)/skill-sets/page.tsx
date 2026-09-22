"use client";

import { Wrench } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { useAgentProfiles } from "@/lib/hooks/use-agent-profiles";
import { formatMinor } from "@/lib/types";

export default function SkillSetsPage() {
  const { data: profiles, isLoading } = useAgentProfiles();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        icon={<Wrench />}
        title="Skill sets"
        subtitle="What your agents are configured to use and how they're routed."
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !profiles || profiles.length === 0 ? (
        <EmptyState
          icon={<Wrench />}
          title="No skill sets configured"
          description="An organization admin needs to add an agent profile before a task can start."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {profiles.map((profile) => (
            <Card key={profile.id}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">{profile.policyVersion}</CardTitle>
                <Badge variant="muted">rev {profile.configRevision}</Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Model tiers</p>
                  <ul className="flex flex-col divide-y divide-border text-sm">
                    {profile.modelTiers.map((tier) => (
                      <li key={tier.tier} className="flex items-center justify-between py-2">
                        <span className="font-medium text-foreground">{tier.tier}</span>
                        <span className="text-muted-foreground">{tier.model}</span>
                        <span className="text-xs text-muted-foreground">
                          {tier.costCeilingMinor !== null
                            ? `up to ${formatMinor(tier.costCeilingMinor, "usd")}`
                            : "no cost ceiling"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <Separator />

                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Tool allowlist</p>
                  {profile.toolAllowlist.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No tools restricted.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {profile.toolAllowlist.map((tool) => (
                        <Badge key={tool} variant="default">
                          {tool}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
          <p className="text-xs text-muted-foreground">
            Skill sets are configured by an organization admin — there's no self-serve editor yet.
          </p>
        </div>
      )}
    </main>
  );
}
