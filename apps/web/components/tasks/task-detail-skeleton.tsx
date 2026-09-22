import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <Skeleton className="size-11 rounded-xl" />
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className="h-3 w-full max-w-sm" />
        ))}
      </CardContent>
    </Card>
  );
}

export function TaskDetailSkeleton() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-72" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="flex flex-col gap-6">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={1} />
        <SkeletonCard lines={2} />
        <SkeletonCard lines={2} />
      </div>
    </main>
  );
}
