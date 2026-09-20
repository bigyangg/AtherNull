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
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const supportingCopy = root.current?.querySelector<HTMLElement>("[data-hero-copy]");
    if (supportingCopy) {
      SplitText.create(supportingCopy, { type: "lines,words", mask: "lines", autoSplit: true, onSplit(self) { return gsap.from(self.words, { autoAlpha: 0, yPercent: 70, duration: 0.65, delay: 2.55, stagger: 0.024, ease: "power3.out" }); } });
    }
    gsap.from("[data-hero-actions]", { autoAlpha: 0, y: 16, duration: 0.65, delay: 2.88, ease: "power3.out" });
    gsap.utils.toArray<HTMLElement>("[data-section]").forEach((element) => {
      gsap.from(element, { autoAlpha: 0, y: 36, duration: 0.85, ease: "power3.out", scrollTrigger: { trigger: element, start: "top 82%" } });
    });
    gsap.from("[data-benefit]", { autoAlpha: 0, y: 32, duration: 0.72, stagger: 0.13, ease: "power3.out", scrollTrigger: { trigger: "[data-benefit]", start: "top 78%" } });

    const steps = gsap.utils.toArray<HTMLElement>("[data-story-step]");
    const screens = gsap.utils.toArray<HTMLElement>("[data-story-screen]");
    const railFill = root.current?.querySelector<HTMLElement>("[data-story-rail-fill]");

    // Screens stack via a clip-path wipe (never two translucent layers at once,
    // which is what produced the double-exposed text mid-scrub).
    gsap.set(screens.slice(1), { clipPath: "inset(0% 0% 100% 0%)", autoAlpha: 1 });
    gsap.set(railFill ?? [], { scaleY: 0 });
    screens.slice(1).forEach((screen) => {
      gsap.set(screen.querySelectorAll<HTMLElement>("[data-reveal-item]"), { autoAlpha: 0, y: 10 });
    });

    const story = gsap.timeline({ scrollTrigger: { trigger: "[data-story-layout]", start: "top 18%", end: "+=1700", scrub: 0.5, pin: "[data-story-visual]", anticipatePin: 1, snap: { snapTo: "labelsDirectional", duration: { min: 0.2, max: 0.45 }, ease: "power2.out" }, onUpdate: (self) => { if (railFill) gsap.set(railFill, { scaleY: self.progress }); } } });
    story.addLabel("brief");
    steps.slice(1).forEach((step, index) => {
      const previousScreen = screens[index];
      const nextScreen = screens[index + 1];
      const previousStep = steps[index];
      if (!previousScreen || !nextScreen || !previousStep) return;
      const revealItems = nextScreen.querySelectorAll<HTMLElement>("[data-reveal-item]");
      story
        .to(previousStep, { autoAlpha: 0.32, "--dot-color": "#c7c6ce", duration: 0.4 })
        .to(step, { autoAlpha: 1, "--dot-color": "#5b52e6", duration: 0.4 }, "<")
        .to(previousScreen, { scale: 0.97, duration: 0.5, ease: "power2.inOut" }, "<")
        .to(nextScreen, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.5, ease: "power2.inOut" }, "<")
        .to(revealItems, { autoAlpha: 1, y: 0, duration: 0.45, stagger: 0.09, ease: "power2.out" }, "-=0.25")
        .addLabel(index === 0 ? "run" : "review")
        .to({}, { duration: 0.3 });
    });

  }, { scope: root });

  return <div ref={root}>{children}</div>;
}
