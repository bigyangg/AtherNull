"use client";

import { Gauge } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { useUsageSummary } from "@/lib/hooks/use-usage";
import { formatMinor, type TaskStatus } from "@/lib/types";

export default function UsagePage() {
  const { data: usage, isLoading } = useUsageSummary();

  const maxDailySpend = Math.max(1, ...(usage?.dailySpend.map((d) => d.spentMinor) ?? [0]));

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader icon={<Gauge />} title="Usage" subtitle="Spend across every task in your organization." />

      {isLoading || !usage ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Total spend</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-3xl font-semibold text-foreground">
                {formatMinor(usage.totalSpentMinor, usage.currency)}
              </p>

              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">Last 14 days</p>
                {usage.dailySpend.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No spend recorded yet.</p>
                ) : (
                  <div className="flex h-24 items-end gap-1.5">
                    {usage.dailySpend.map((day) => (
                      <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
                        <div
                          className="w-full rounded-sm bg-info/40"
                          style={{ height: `${Math.max(4, (day.spentMinor / maxDailySpend) * 100)}%` }}
                          title={`${new Date(day.date).toLocaleDateString()}: ${formatMinor(day.spentMinor, usage.currency)}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tasks by status</CardTitle>
            </CardHeader>
            <CardContent>
              {Object.keys(usage.taskCountsByStatus).length === 0 ? (
                <p className="text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <div className="flex flex-wrap gap-3">
                  {Object.entries(usage.taskCountsByStatus).map(([status, count]) => (
                    <div
                      key={status}
                      className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
                    >
                      <span className="text-lg font-semibold text-foreground">{count}</span>
                      <StatusBadge status={status as TaskStatus} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </main>
  );
}
