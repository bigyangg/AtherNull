import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

export function LivePreviewPanel({ previewUrl }: { previewUrl: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ArrowLeft className="size-3.5 text-muted-foreground" />
        <ArrowRight className="size-3.5 text-muted-foreground" />
        <RotateCw className="size-3.5 text-muted-foreground" />
        <div className="ml-2 flex-1 truncate rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {previewUrl}
        </div>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-foreground">
          Live preview isn't wired up yet
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          This panel will show your generated site here once preview hosting
          is connected. For now it's a placeholder for that integration
          point.
        </p>
      </div>
    </div>
  );
}
