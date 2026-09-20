import Link from "next/link";
import { FolderGit2, Sparkles } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IconBadge } from "@/components/icon-badge";

const PATHS = [
  {
    href: "/projects/new/create",
    icon: Sparkles,
    title: "Create New",
    badge: "New application",
    description:
      "Describe an idea and generate a working application from our modular foundation.",
    steps: ["Prompt", "Build", "Preview", "Deploy"],
  },
  {
    href: "/projects/new/import",
    icon: FolderGit2,
    title: "Import Repository",
    badge: "Existing application",
    description:
      "Connect existing code and use AI to add features, fix bugs or improve the interface.",
    steps: ["Import", "Analyze", "Edit", "Test", "PR"],
  },
] as const;

export default function NewProjectChoicePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="mb-8 text-xl font-semibold">
        Two ways to use AtherNull
      </h1>

      <div className="grid gap-4 sm:grid-cols-2">
        {PATHS.map(({ href, icon: Icon, title, badge, description, steps }) => (
          <Link key={href} href={href}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <IconBadge>
                  <Icon />
                </IconBadge>
                <CardTitle className="mt-2 text-base">{title}</CardTitle>
                <Badge variant="muted" className="w-fit">
                  {badge}
                </Badge>
              </CardHeader>
              <CardContent>
                <CardDescription>{description}</CardDescription>
                <p className="mt-4 text-xs text-muted-foreground">
                  {steps.join(" → ")}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <p className="mt-8 text-sm text-muted-foreground">
        Both use the same OpenHands execution engine, spending controls,
        verification process and billing system.
      </p>
    </main>
  );
}
