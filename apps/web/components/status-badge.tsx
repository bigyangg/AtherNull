import { Badge } from "@/components/ui/badge";
import { TASK_STATUS_DISPLAY, type TaskStatus } from "@/lib/types";

const TONE_TO_VARIANT = {
  default: "info",
  success: "success",
  warning: "warning",
  destructive: "destructive",
  muted: "muted",
} as const;

export function StatusBadge({ status }: { status: TaskStatus }) {
  const { label, tone } = TASK_STATUS_DISPLAY[status];
  return <Badge variant={TONE_TO_VARIANT[tone]}>{label}</Badge>;
}
