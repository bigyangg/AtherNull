import * as React from "react";

import { cn } from "@/lib/utils";

function ScrollArea({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]",
        className,
      )}
      {...props}
    />
  );
}

export { ScrollArea };
