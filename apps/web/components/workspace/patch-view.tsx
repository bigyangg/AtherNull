import { FileCode, ShieldCheck } from "lucide-react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { BuildPatch } from "@/lib/types";

interface FileDiff {
  path: string;
  lines: string[];
  added: number;
  removed: number;
}

function splitFiles(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)?.[2] ?? line.slice(11);
      current = { path, lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(line)) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
    current.lines.push(line);
  }
  return files;
}

// The exact change under review (ADR-0017): the patch the worker captured and
// the independent verifier tested, rendered as a unified diff per file.
export function PatchView({ patch }: { patch: BuildPatch }) {
  const files = splitFiles(patch.patch);
  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5" />
          <span>
            {patch.filesChanged} file{patch.filesChanged === 1 ? "" : "s"} ·{" "}
            <span className="text-success">+{patch.insertions}</span>{" "}
            <span className="text-destructive">−{patch.deletions}</span> against{" "}
            <span className="font-mono">{patch.baseRevision.slice(0, 10)}</span>
          </span>
          <span className="ml-auto font-mono" title={patch.sha256}>
            sha256 {patch.sha256.slice(0, 12)}
          </span>
        </div>
        {files.length === 0 && <p className="text-sm text-muted-foreground">The build made no changes.</p>}
        {files.map((file) => (
          <div key={file.path} className="overflow-hidden rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
              <FileCode className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
              <span className="font-mono text-xs text-success">+{file.added}</span>
              <span className="font-mono text-xs text-destructive">−{file.removed}</span>
            </div>
            <pre className="overflow-x-auto py-1 font-mono text-[11px] leading-5">
              {file.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "px-3 whitespace-pre",
                    line.startsWith("+") && "bg-success/10 text-success",
                    line.startsWith("-") && "bg-destructive/10 text-destructive",
                    line.startsWith("@@") && "text-info",
                    !/^[+\-@]/.test(line) && "text-muted-foreground",
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
