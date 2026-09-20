"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Activity, CheckCheck, ClipboardList, Code2, GitPullRequest, Radio, ShieldCheck } from "lucide-react";
import { useRef } from "react";
import styles from "./ownership-flow.module.css";

gsap.registerPlugin(ScrollTrigger);

const stages = [
  { label: "Brief", icon: Radio, x: 280, y: 66 },
  { label: "Plan", icon: ClipboardList, x: 440, y: 158 },
  { label: "Execute", icon: Code2, x: 440, y: 342 },
  { label: "Validate", icon: CheckCheck, x: 280, y: 434 },
  { label: "Review", icon: GitPullRequest, x: 120, y: 342 },
  { label: "Observe", icon: Activity, x: 120, y: 158 },
];
const circuit = "M280 66 L440 158 L440 342 L280 434 L120 342 L120 158 Z";

// Match node timing to distance traveled along the circuit.
const edges = stages.map((stage, i) => {
  const next = stages[(i + 1) % stages.length]!;
  return Math.hypot(next.x - stage.x, next.y - stage.y);
});
const perimeter = edges.reduce((sum, edge) => sum + edge, 0);
const circuitDuration = 5.4;

export function OwnershipFlow() {
  const diagramRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const diagram = diagramRef.current;
    if (!diagram || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const nodes = gsap.utils.toArray<HTMLElement>(diagram.querySelectorAll("[data-flow-node]"));
    const trace = diagram.querySelectorAll<SVGPathElement>("[data-flow-trace]");
    const waves = diagram.querySelectorAll<SVGPathElement>("[data-flow-wave]");
    if (nodes.length !== stages.length || trace.length !== 3 || waves.length !== 3) return;

    // The path and node activations share one clock, so the box appears only
    // when the trace reaches that vertex. The server-rendered fallback keeps
    // every icon visible when JavaScript or animation is unavailable.
    gsap.set(diagram, { attr: { "data-animated": "true" } });
    const activate = (index: number) => {
      nodes.forEach((node, nodeIndex) => {
        node.dataset.active = nodeIndex === index ? "true" : "false";
      });
    };
    const deactivate = () => nodes.forEach((node) => { node.dataset.active = "false"; });
    activate(0);

    const timeline = gsap.timeline({ repeat: -1, paused: true });
    timeline.fromTo(trace, { strokeDashoffset: 0 }, { strokeDashoffset: -600, duration: circuitDuration, ease: "none" }, 0);
    let distance = 0;
    stages.forEach((_, index) => {
      const arrival = distance / perimeter * circuitDuration;
      timeline.call(() => activate(index), [], arrival);
      // One outward burst per arrival. Each contour starts a fraction later,
      // then fully fades before the signal reaches the next vertex.
      waves.forEach((wave, waveIndex) => {
        timeline.fromTo(wave,
          { scale: 1, opacity: 0.5, transformOrigin: "50% 50%" },
          { scale: 1.23, opacity: 0, duration: 0.55, ease: "power2.out", immediateRender: false },
          arrival + waveIndex * 0.09,
        );
      });
      timeline.call(deactivate, [], arrival + 0.48);
      distance += edges[index]!;
    });
    timeline.call(() => activate(0), [], circuitDuration);

    ScrollTrigger.create({
      trigger: diagram,
      start: "top bottom",
      end: "bottom top",
      onEnter: () => timeline.play(),
      onEnterBack: () => timeline.play(),
      onLeave: () => timeline.pause(),
      onLeaveBack: () => timeline.pause(),
    });
  }, { scope: diagramRef });

  return (
    <div ref={diagramRef} className={styles.diagram} role="img" aria-label="Agent workflow: brief, plan, execute, validate, review, and observe. Each stage lights up as the work progresses, while you stay in control.">
      <svg className={styles.paths} viewBox="0 0 560 500" fill="none" aria-hidden="true">
        <path className={styles.wave} d={circuit} data-flow-wave />
        <path className={styles.wave} d={circuit} data-flow-wave />
        <path className={styles.wave} d={circuit} data-flow-wave />
        <path className={styles.surface} d={circuit} />
        {stages.map(({ label, x, y }) => <path key={label} className={styles.spoke} d={`M280 250 L${x} ${y}`} />)}
        <path className={styles.track} d={circuit} />
        <path className={styles.flowGlow} d={circuit} pathLength="600" data-flow-trace />
        <path className={styles.flow} d={circuit} pathLength="600" data-flow-trace />
        <path className={styles.flowHead} d={circuit} pathLength="600" data-flow-trace />
      </svg>
      <div className={styles.center} aria-hidden="true">
        <span className={styles.centerIcon}><ShieldCheck strokeWidth={1.4} /></span>
        <strong>Your terms.<br />Every step.</strong>
        <span className={styles.centerCaption}>YOU STAY IN CONTROL</span>
      </div>
      {stages.map(({ label, icon: Icon, x, y }) => (
        <div key={label} className={styles.node} style={{ left: `${x / 560 * 100}%`, top: `${y / 500 * 100}%` }} data-flow-node aria-hidden="true">
          <span className={styles.nodeIcon}><Icon strokeWidth={1.5} /></span>
          <span className={styles.nodeLabel}>{label}</span>
        </div>
      ))}
    </div>
  );
}
