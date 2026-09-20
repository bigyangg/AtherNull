"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { TextPlugin } from "gsap/TextPlugin";
import { useRef } from "react";

import styles from "./hero-title.module.css";

gsap.registerPlugin(TextPlugin);

export function HeroTitle() {
  const root = useRef<HTMLHeadingElement>(null);

  useGSAP(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const firstLine = root.current?.querySelector<HTMLElement>("[data-type-first]");
    const lead = root.current?.querySelector<HTMLElement>("[data-type-lead]");
    const accent = root.current?.querySelector<HTMLElement>("[data-type-accent]");
    const ending = root.current?.querySelector<HTMLElement>("[data-type-ending]");
    const cursor = root.current?.querySelector<HTMLElement>("[data-type-cursor]");
    const sweep = root.current?.querySelector<HTMLElement>("[data-type-sweep]");
    if (!firstLine || !lead || !accent || !ending || !cursor || !sweep) return;

    if (reduceMotion) {
      gsap.set([firstLine, lead, accent, ending], { opacity: 1 });
      return;
    }

    gsap.set([firstLine, lead, accent, ending], { text: "" });
    gsap.set([firstLine, lead, accent, ending], { opacity: 1 });
    gsap.set(cursor, { autoAlpha: 1 });
    gsap.set(sweep, { autoAlpha: 0, scaleX: 0, transformOrigin: "50% 50%" });
    gsap.timeline({ defaults: { ease: "none" } })
      .to(firstLine, { text: "Software moves faster", duration: 0.78 })
      .to(lead, { text: "when ", duration: 0.26 }, "+=0.08")
      .to(accent, { text: "intent", duration: 0.32 })
      .to(ending, { text: " is enough.", duration: 0.46 })
      .to(cursor, { autoAlpha: 0, scaleY: 0.22, duration: 0.2, ease: "power2.in" }, "+=0.3")
      .to(sweep, { autoAlpha: 0.8, scaleX: 1, duration: 0.46, ease: "power3.out" }, "<")
      .to(sweep, { autoAlpha: 0, scaleX: 1.35, duration: 0.38, ease: "power2.in" })
      .call(() => window.dispatchEvent(new Event("athernull:hero-complete")));
  }, { scope: root });

  return (
    <h1 ref={root} className={styles.title} aria-label="Software moves faster when intent is enough.">
      <span className={styles.line} aria-hidden="true"><span data-type-first>Software moves faster</span></span>
      <span className={styles.line} aria-hidden="true"><span data-type-lead>when </span><em data-type-accent>intent</em><span data-type-ending> is enough.</span><i className={styles.cursor} data-type-cursor /></span>
      <i className={styles.sweep} data-type-sweep aria-hidden="true" />
      <noscript>
        <style>{`[data-type-first],[data-type-lead],[data-type-accent],[data-type-ending]{opacity:1}`}</style>
      </noscript>
    </h1>
  );
}
