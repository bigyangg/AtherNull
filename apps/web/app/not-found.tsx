import type { Metadata } from "next";

import { SiteErrorScreen } from "@/components/error-screen";

export const metadata: Metadata = {
  title: "Page not found | AtherNull",
};

export default function NotFound() {
  return (
    <SiteErrorScreen
      code="404"
      title="This page doesn't exist."
      message="The link may be old, or the address mistyped. Your builds and conversations are safe; head back and pick up where you left off."
    />
  );
}
