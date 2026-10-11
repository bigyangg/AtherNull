import { Suspense } from "react";

import { BuildsHome } from "@/components/builds/builds-home";

export default function BuildsPage() {
  return (
    <Suspense>
      <BuildsHome />
    </Suspense>
  );
}
