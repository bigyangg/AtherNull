"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import { useRef } from "react";

import styles from "./hero-flight.module.css";

gsap.registerPlugin(MotionPathPlugin);

const PARTICLES = Array.from({ length: 72 }, (_, index) => ({
  id: index,
  route: `route-${index % 4}`,
  radius: index % 13 === 0 ? 2.6 : index % 5 === 0 ? 1.55 : 0.85,
  delay: -(index * 0.29),
  duration: 9 + (index % 7) * 1.1,
}));

export function HeroFlight() {
  const root = useRef<SVGSVGElement>(null);

  useGSAP((_context, contextSafe) => {
    if (!contextSafe) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const svg = root.current;
    if (!svg) return;
    const particles = Array.from(svg.querySelectorAll<SVGCircleElement>("[data-flight-particle]"));
    const paths = new Map(Array.from(svg.querySelectorAll<SVGPathElement>("[data-flight-path]")).map((path) => [path.id, path]));

    const travelTweens: gsap.core.Tween[] = [];
    particles.forEach((particle) => {
      const path = paths.get(particle.dataset.route ?? "");
      if (!path) return;
      gsap.set(particle, { transformOrigin: "50% 50%" });
      travelTweens.push(gsap.to(particle, {
        duration: Number(particle.dataset.duration),
        delay: Number(particle.dataset.delay),
        repeat: -1,
        ease: "none",
        motionPath: { path, align: path, alignOrigin: [0.5, 0.5] },
      }));
    });

    gsap.from("[data-flight-path]", { strokeDashoffset: 900, duration: 2.2, stagger: 0.12, ease: "power2.out" });
    gsap.from(particles, { autoAlpha: 0, scale: 0, duration: 0.8, stagger: { each: 0.012, from: "random" }, ease: "back.out(2)" });
    const launch = contextSafe(() => {
      gsap.timeline()
        .to(travelTweens, { timeScale: 2.35, duration: 0.42, ease: "power3.in" })
        .to(travelTweens, { timeScale: 1, duration: 1.2, ease: "power2.out" });
      gsap.fromTo(svg, { scale: 1 }, { scale: 1.035, duration: 0.34, yoyo: true, repeat: 1, ease: "power2.out" });
    });
    window.addEventListener("athernull:hero-complete", launch, { once: true });
    return () => window.removeEventListener("athernull:hero-complete", launch);
  }, { scope: root });

  return (
    <div className={styles.field} aria-hidden>
      <svg ref={root} viewBox="0 0 1440 640" fill="none" preserveAspectRatio="xMidYMid slice">
        <defs><radialGradient id="flight-haze"><stop stopColor="#7169ff" stopOpacity=".18" /><stop offset="1" stopColor="#7169ff" stopOpacity="0" /></radialGradient></defs>
        <ellipse cx="720" cy="315" rx="510" ry="260" fill="url(#flight-haze)" />
        <path id="route-0" data-flight-path d="M-120 405C80 85 304 553 590 305S1010 75 1545 315" />
        <path id="route-1" data-flight-path d="M-90 182C180 415 343 90 639 241s481 52 889 222" />
        <path id="route-2" data-flight-path d="M-70 535C210 255 406 586 675 379S1127 240 1518 430" />
        <path id="route-3" data-flight-path d="M105 605c183-322 389-181 574-380S1049 13 1422 128" />
        {PARTICLES.map((particle) => <circle key={particle.id} data-flight-particle data-route={particle.route} data-duration={particle.duration} data-delay={particle.delay} r={particle.radius} />)}
      </svg>
    </div>
  );
}
