import { Activity, CheckCheck, ClipboardList, Code2, GitPullRequest, Radio, ShieldCheck } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "./ownership-flow.module.css";

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

export function OwnershipFlow() {
  return (
    <div className={styles.diagram} role="img" aria-label="Agent workflow: brief, plan, execute, validate, review, and observe. You stay in control throughout.">
      <svg className={styles.paths} viewBox="0 0 560 500" fill="none" aria-hidden="true">
        <path className={styles.outer} d="M280 20 L480 135 L480 365 L280 480 L80 365 L80 135 Z" />
        <path className={styles.outer} d="M280 43 L460 147 L460 353 L280 457 L100 353 L100 147 Z" />
        <path className={styles.surface} d={circuit} />
        {stages.map(({ label, x, y }) => <path key={label} className={styles.spoke} d={`M280 250 L${x} ${y}`} />)}
        <path className={styles.track} d={circuit} />
        <path className={styles.flowGlow} d={circuit} pathLength="600" />
        <path className={styles.flow} d={circuit} pathLength="600" />
        <path className={styles.flowHead} d={circuit} pathLength="600" />
      </svg>
      <div className={styles.center} aria-hidden="true">
        <span className={styles.centerIcon}><ShieldCheck strokeWidth={1.4} /></span>
        <strong>Your terms.<br />Every step.</strong>
        <span className={styles.centerCaption}>YOU STAY IN CONTROL</span>
      </div>
      {stages.map(({ label, icon: Icon, x, y }, index) => (
        <div key={label} className={styles.node} style={{ left: `${x / 560 * 100}%`, top: `${y / 500 * 100}%`, "--delay": `${edges.slice(0, index).reduce((sum, edge) => sum + edge, 0) / perimeter * 6 - 6}s` } as CSSProperties} aria-hidden="true">
          <span className={styles.nodeIcon}><Icon strokeWidth={1.5} /></span>
          <span className={styles.nodeLabel}>{label}</span>
        </div>
      ))}
      <span className={styles.caption} aria-hidden="true"><span />AGENT WORKFLOW / HUMAN CONTROL</span>
    </div>
  );
}
