"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { useRef, type ReactNode } from "react";

gsap.registerPlugin(ScrollTrigger, SplitText);

export function LandingMotion({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const supportingCopy = root.current?.querySelector<HTMLElement>("[data-hero-copy]");
    const heroActions = root.current?.querySelector<HTMLElement>("[data-hero-actions]");

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (supportingCopy) gsap.set(supportingCopy, { opacity: 1 });
      if (heroActions) gsap.set(heroActions, { opacity: 1 });
      return;
    }

    if (supportingCopy) {
      SplitText.create(supportingCopy, { type: "lines,words", mask: "lines", autoSplit: true, onSplit(self) { gsap.set(supportingCopy, { opacity: 1 }); return gsap.from(self.words, { autoAlpha: 0, yPercent: 70, duration: 0.65, delay: 2.55, stagger: 0.024, ease: "power3.out" }); } });
    }
    if (heroActions) gsap.set(heroActions, { opacity: 1 });
    gsap.from("[data-hero-actions]", { autoAlpha: 0, y: 16, duration: 0.65, delay: 2.88, ease: "power3.out" });
    gsap.utils.toArray<HTMLElement>("[data-section]").forEach((element) => {
      gsap.from(element, { autoAlpha: 0, y: 36, duration: 0.85, ease: "power3.out", scrollTrigger: { trigger: element, start: "top 82%" } });
    });
    gsap.from("[data-benefit]", { autoAlpha: 0, y: 32, duration: 0.72, stagger: 0.13, ease: "power3.out", scrollTrigger: { trigger: "[data-benefit]", start: "top 78%" } });
  }, { scope: root });

  return <div ref={root}>{children}</div>;
}
