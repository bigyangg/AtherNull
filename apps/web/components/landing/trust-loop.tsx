"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { GitBranch, Repeat, ShieldCheck, Wallet } from "lucide-react";
import { useRef } from "react";
import styles from "./trust-loop.module.css";

gsap.registerPlugin(ScrollTrigger);

const SIZE = 440;
const CENTER = SIZE / 2;
const RADIUS = 150;

const STAGES = [
  { label: "Budget", pos: "top", icon: Wallet, angle: -90 },
  { label: "Escrow", pos: "right", icon: ShieldCheck, angle: 30 },
  { label: "Release", pos: "left", icon: GitBranch, angle: 150 },
] as const;

function point(angle: number) {
  const rad = (angle * Math.PI) / 180;
  return { x: CENTER + RADIUS * Math.cos(rad), y: CENTER + RADIUS * Math.sin(rad) };
}

export function TrustLoop() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const diagram = rootRef.current;
    if (!diagram) return;

    const trace = Array.from(diagram.querySelectorAll<SVGCircleElement>("[data-loop-trace]"));
    const nodes = Array.from(diagram.querySelectorAll<HTMLElement>("[data-loop-node]"));
    if (trace.length !== 3 || nodes.length !== STAGES.length) return;

    const activate = (index: number) => {
      nodes.forEach((node, nodeIndex) => {
        node.dataset.active = nodeIndex === index ? "true" : "false";
      });
    };
    const deactivate = () => nodes.forEach((node) => { node.dataset.active = "false"; });

    gsap.set(diagram, { attr: { "data-animated": "true" } });
    activate(0);

    // The stroke and active node are deliberately driven by this one clock.
    // This prevents a CSS delay drifting away from the arc after a refresh.
    const duration = 3.2;
    const timeline = gsap.timeline({ repeat: -1, paused: true });
    timeline.to(trace, { strokeDashoffset: -300, duration, ease: "none" }, 0);
    STAGES.forEach((_, index) => {
      const arrival = (index / STAGES.length) * duration;
      timeline.call(() => activate(index), [], arrival);
      timeline.call(deactivate, [], arrival + 0.38);
    });
    timeline.call(() => activate(0), [], duration);

    const trigger = ScrollTrigger.create({
      trigger: diagram,
      start: "top bottom",
      end: "bottom top",
      onEnter: () => timeline.play(),
      onEnterBack: () => timeline.play(),
      onLeave: () => timeline.pause(),
      onLeaveBack: () => timeline.pause(),
    });

    return () => {
      trigger.kill();
      timeline.kill();
    };
  }, { scope: rootRef });

  return (
    <div ref={rootRef} className={styles.diagram} role="img" aria-label="A repeating loop: budget is set, escrow holds the funds, then the release stage returns to budgeting the next task.">
      <svg className={styles.paths} viewBox={`0 0 ${SIZE} ${SIZE}`} fill="none" aria-hidden="true">
        <circle className={styles.outer} cx={CENTER} cy={CENTER} r={RADIUS + 40} />
        <circle className={styles.outer} cx={CENTER} cy={CENTER} r={RADIUS + 20} />
        <circle className={styles.surface} cx={CENTER} cy={CENTER} r={RADIUS - 2} />
        {STAGES.map(({ label, angle }) => {
          const { x, y } = point(angle);
          return <line key={label} className={styles.spoke} x1={CENTER} y1={CENTER} x2={x} y2={y} />;
        })}
        <circle className={styles.track} cx={CENTER} cy={CENTER} r={RADIUS} />
        <circle className={styles.flowGlow} cx={CENTER} cy={CENTER} r={RADIUS} pathLength={300} data-loop-trace />
        <circle className={styles.flow} cx={CENTER} cy={CENTER} r={RADIUS} pathLength={300} data-loop-trace />
        <circle className={styles.flowHead} cx={CENTER} cy={CENTER} r={RADIUS} pathLength={300} data-loop-trace />
      </svg>

      <div className={styles.center} aria-hidden="true">
        <span className={styles.centerIcon}><Repeat strokeWidth={1.6} /></span>
        <strong>One loop.<br />Every task.</strong>
        <span className={styles.centerCaption}>NEVER SKIPS A STEP</span>
      </div>

      {STAGES.map(({ label, pos, icon: Icon, angle }) => {
        const { x, y } = point(angle);
        return (
          <div
            key={label}
            className={styles.node}
            data-loop-node
            data-pos={pos}
            style={{ left: `${(x / SIZE) * 100}%`, top: `${(y / SIZE) * 100}%` }}
          >
            <span className={styles.nodeIcon}><Icon strokeWidth={1.5} /></span>
            <span className={styles.nodeLabel}>{label}</span>
          </div>
        );
      })}

      <span className={styles.caption} aria-hidden="true"><span />CONTINUOUS / REPEATS FOR EVERY TASK</span>
    </div>
  );
}
