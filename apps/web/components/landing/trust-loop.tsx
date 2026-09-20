import { GitBranch, Repeat, ShieldCheck, Wallet } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "./trust-loop.module.css";

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
  return (
    <div className={styles.diagram} role="img" aria-label="A repeating loop: budget is set, escrow holds the funds, then the release stage returns to budgeting the next task.">
      <svg className={styles.paths} viewBox={`0 0 ${SIZE} ${SIZE}`} fill="none" aria-hidden="true">
        <circle className={styles.outer} cx={CENTER} cy={CENTER} r={RADIUS + 40} />
        <circle className={styles.outer} cx={CENTER} cy={CENTER} r={RADIUS + 20} />
        <circle className={styles.surface} cx={CENTER} cy={CENTER} r={RADIUS - 2} />
        {STAGES.map(({ label, angle }) => {
          const { x, y } = point(angle);
          return <line key={label} className={styles.spoke} x1={CENTER} y1={CENTER} x2={x} y2={y} />;
        })}
        <circle className={styles.track} cx={CENTER} cy={CENTER} r={RADIUS} />
        <circle className={styles.flowGlow} cx={CENTER} cy={CENTER} r={RADIUS} pathLength={300} />
        <circle className={styles.flow} cx={CENTER} cy={CENTER} r={RADIUS} pathLength={300} />
        <circle className={styles.flowHead} cx={CENTER} cy={CENTER} r={RADIUS} pathLength={300} />
      </svg>

      <div className={styles.center} aria-hidden="true">
        <span className={styles.centerIcon}><Repeat strokeWidth={1.6} /></span>
        <strong>One loop.<br />Every task.</strong>
        <span className={styles.centerCaption}>NEVER SKIPS A STEP</span>
      </div>

      {STAGES.map(({ label, pos, icon: Icon, angle }, index) => {
        const { x, y } = point(angle);
        return (
          <div
            key={label}
            className={styles.node}
            data-pos={pos}
            style={{ left: `${(x / SIZE) * 100}%`, top: `${(y / SIZE) * 100}%`, "--delay": `${(index / STAGES.length) * 4}s` } as CSSProperties}
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
