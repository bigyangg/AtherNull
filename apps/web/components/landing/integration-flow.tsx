"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Check, GitBranch, GitPullRequest } from "lucide-react";
import { useRef } from "react";

import styles from "./integration-flow.module.css";

gsap.registerPlugin(ScrollTrigger);

const RUN_STEPS = ["Read the repository", "Update the checkout flow", "Run verification"] as const;
const RUN_STATUS = ["Reading", "Editing", "Verifying"] as const;

export function IntegrationFlow() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const element = root.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const progress = element.querySelector<HTMLElement>("[data-run-progress]");
    const checks = gsap.utils.toArray<HTMLElement>("[data-run-check]", element);
    const review = element.querySelector<HTMLElement>("[data-review-status]");
    const runStatus = element.querySelector<HTMLElement>("[data-run-status]");
    const intakeArrow = element.querySelector<HTMLElement>("[data-transfer-in]");
    const reviewArrow = element.querySelector<HTMLElement>("[data-transfer-out]");
    if (!progress || !review || !runStatus || !intakeArrow || !reviewArrow || checks.length !== RUN_STEPS.length) return;

    const reset = () => {
      gsap.set(progress, { scaleY: 0 });
      gsap.set(checks, { backgroundColor: "#2d2f3a", borderColor: "#575967", color: "#8b8d9d" });
      gsap.set(review, { backgroundColor: "#f4f4f7", borderColor: "#e6e6eb", color: "#686871" });
      gsap.set([intakeArrow, reviewArrow], { backgroundColor: "#fff", color: "#73717e" });
      runStatus.textContent = "Waiting for context";
      review.textContent = "Awaiting result";
    };
    reset();
    const timeline = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.6 });

    timeline.to(intakeArrow, { backgroundColor: "#edeaff", color: "#5148d1", duration: 0.32 });
    checks.forEach((check, index) => {
      timeline.call(() => { runStatus.textContent = `${index + 1}/${checks.length} · ${RUN_STATUS[index]}`; });
      timeline.to(progress, { scaleY: (index + 1) / checks.length, duration: 0.58, ease: "power2.inOut" });
      timeline.to(check, { backgroundColor: "#cbc7ff", borderColor: "#cbc7ff", color: "#28206a", duration: 0.24 }, "<+=0.35");
    });
    timeline.to(reviewArrow, { backgroundColor: "#edeaff", color: "#5148d1", duration: 0.32 }, ">+=0.16");
    timeline.call(() => { runStatus.textContent = "Run complete"; review.textContent = "Ready for your approval"; });
    timeline.to(review, { backgroundColor: "#eff9f1", borderColor: "#cde9d2", color: "#246238", duration: 0.36 });
    timeline.to([review, ...checks], { opacity: 0.55, duration: 0.36 }, ">+=2.8");
    timeline.call(reset);
    timeline.to([review, ...checks], { opacity: 1, duration: 0.18 });

    const trigger = ScrollTrigger.create({
      trigger: element,
      start: "top 82%",
      end: "bottom 10%",
      onEnter: () => timeline.play(),
      onEnterBack: () => timeline.play(),
      onLeave: () => timeline.pause(),
      onLeaveBack: () => timeline.pause(),
    });
    return () => { trigger.kill(); timeline.kill(); };
  }, { scope: root });

  return (
    <div className={styles.flow} ref={root} role="group" aria-label="Illustrative task handoff from request to review">
      <div className={styles.heading}><span>Workflow preview</span><p>A request arrives with context. The result returns ready for a decision.</p></div>
      <div className={styles.canvas}>
        <div className={styles.intake}>
          <span className={styles.label}>01 / Request</span>
          <div className={styles.issue}><span>Jira / WEB-142</span><strong>Make checkout faster</strong></div>
          <div className={styles.sources}><span><GitBranch aria-hidden="true" /> GitHub / storefront</span><span>Notion / checkout spec</span></div>
          <span className={styles.transfer} data-transfer-in aria-hidden="true">→</span>
        </div>

        <div className={styles.work}>
          <div className={styles.workHeader}><span>02 / Agent workspace</span><span className={styles.runStatus}><i aria-hidden="true" /><span data-run-status>Run complete</span></span></div>
          <div className={styles.workRows}>
            <div className={styles.progress} aria-hidden="true"><span data-run-progress /></div>
            {RUN_STEPS.map((step) => <div className={styles.workRow} key={step}><span className={styles.check} data-run-check><Check aria-hidden="true" /></span><span>{step}</span></div>)}
          </div>
          <span className={styles.transfer} data-transfer-out aria-hidden="true">→</span>
        </div>

        <div className={styles.handoff}>
          <span className={styles.label}>03 / Review</span>
          <div className={styles.pull}><GitPullRequest aria-hidden="true" /><div><span>Pull request</span><strong>Checkout improvements</strong></div></div>
          <p>Code diff, test results, and task cost in one place.</p>
          <span className={styles.reviewStatus} data-review-status>Ready for your approval</span>
        </div>
      </div>
    </div>
  );
}
