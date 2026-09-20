import Link from "next/link";
import { FolderGit2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconBadge } from "@/components/icon-badge";

export default function ImportProjectPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-10">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
        <IconBadge>
          <FolderGit2 />
        </IconBadge>
        <h1 className="text-base font-semibold">Import Repository</h1>
        <p className="text-sm text-muted-foreground">
          Connecting an existing codebase is coming soon. In the meantime you
          can start from a described idea instead.
        </p>
        <Button asChild className="mt-1">
          <Link href="/projects/new/create">Create a new project</Link>
        </Button>
      </div>
    </main>
  );
}
