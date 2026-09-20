"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ArrowRight, Check } from "lucide-react";
import { useRef } from "react";

import pageStyles from "@/app/landing.module.css";
import styles from "./workflow-story.module.css";

gsap.registerPlugin(ScrollTrigger);

const STEPS = [
  {
    number: "01",
    title: "Brief the task",
    text: "Name the outcome, choose the repository, and set the maximum you are willing to spend.",
  },
  {
    number: "02",
    title: "Follow the run",
    text: "Watch the agent understand the code, make changes in its own branch, and show evidence as it works.",
  },
  {
    number: "03",
    title: "Approve the result",
    text: "Review the pull request, test results, and final cost. Then merge it or send it back with context.",
  },
] as const;

function BriefScreen() {
  return (
    <>
      <div className={pageStyles.screenBar}><span>1 of 3 · Task brief</span><small>Ready to fund</small></div>
      <div className={styles.screenContent}>
        <div className={pageStyles.screenBody}>
          <span className={pageStyles.screenLabel}>What needs to happen?</span>
          <h3>Make checkout feel instant.</h3>
          <p>Persist cart state, reduce steps, and verify the address and payment flow on mobile.</p>
          <div className={pageStyles.taskMeta}><span>Repository <b>acme/storefront</b></span><span>Budget <b>$42.00</b></span></div>
          <button>Fund task <ArrowRight /></button>
        </div>
      </div>
    </>
  );
}

function AgentScreen() {
  return (
    <>
      <div className={pageStyles.screenBar}><span><i /> 2 of 3 · Agent run</span><small>In progress</small></div>
      <div className={styles.screenContent}>
        <div className={pageStyles.runRows}>
          <div data-reveal-item><Check /><span><b>Repository mapped</b><small>24 files understood</small></span><time>00:18</time></div>
          <div data-reveal-item><Check /><span><b>Cart persistence added</b><small>3 files changed</small></span><time>01:42</time></div>
          <div className={pageStyles.running} data-reveal-item><i /><span><b>Checkout tests running</b><small>Payment and address paths</small></span><time>now</time></div>
        </div>
        <div className={pageStyles.codeLine} data-reveal-item><span>checkout-session.ts</span><b>+48 −12</b></div>
      </div>
    </>
  );
}

function ReviewScreen() {
  return (
    <>
      <div className={pageStyles.screenBar}><span>3 of 3 · Review</span><small>Ready for you</small></div>
      <div className={styles.screenContent}>
        <div className={pageStyles.reviewScore} data-reveal-item><Check /><div><span>All checks passed</span><b>Ready to merge</b></div></div>
        <div className={pageStyles.reviewList}>
          <div data-reveal-item><span>Changes</span><b>8 files</b></div>
          <div data-reveal-item><span>Tests</span><b>24 passed</b></div>
          <div data-reveal-item><span>Final cost</span><b>$12.84</b></div>
        </div>
        <button data-reveal-item>Review pull request <ArrowRight /></button>
      </div>
    </>
  );
}

const PANELS = [
  { ...STEPS[0], screenClass: pageStyles.screenBrief, Screen: BriefScreen },
  { ...STEPS[1], screenClass: pageStyles.screenAgent, Screen: AgentScreen },
  { ...STEPS[2], screenClass: pageStyles.screenReview, Screen: ReviewScreen },
] as const;

// Mobile keeps the original crossfade layout: a static step list next to a
// pinned visual that wipes between screens as you scroll vertically.
function LegacyStoryLayout() {
  return (
    <div className={pageStyles.storyLayout} data-story-layout>
      <div className={pageStyles.storySteps}>
        <div className={pageStyles.storyRail} aria-hidden="true"><span className={pageStyles.storyRailFill} data-story-rail-fill /></div>
        {STEPS.map((step, index) => (
          <article key={step.number} data-story-step className={index === 0 ? pageStyles.stepActive : undefined}>
            <span>{step.number}</span><h3>{step.title}</h3><p>{step.text}</p>
          </article>
        ))}
      </div>
      <div className={pageStyles.storyVisual} data-story-visual aria-label="Task workflow preview">
        {PANELS.map(({ number, screenClass, Screen }) => (
          <div key={number} className={`${pageStyles.storyScreen} ${screenClass}`} data-story-screen><Screen /></div>
        ))}
      </div>
    </div>
  );
}

// Desktop: the section pins full-height and each step becomes a full-bleed
// panel that slides in horizontally as you scroll, GSAP-showcase style, then
// releases back into normal vertical scroll once the last panel settles.
function HorizontalStoryLayout() {
  return (
    <div className={styles.storyPin} data-story-pin>
      <div className={styles.storyProgress} aria-hidden="true"><span className={styles.storyProgressFill} data-story-progress-fill /></div>
      <div className={styles.storyTrack} data-story-track>
        {PANELS.map(({ number, title, text, screenClass, Screen }) => (
          <article key={number} className={styles.storyPanel} data-story-panel>
            <div className={styles.storyPanelText}><span>{number}</span><h3>{title}</h3><p>{text}</p></div>
            <div className={`${styles.storyPanelVisual} ${screenClass}`}><Screen /></div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function WorkflowStory() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const mm = gsap.matchMedia();

    mm.add("(max-width: 760px)", () => {
      const steps = gsap.utils.toArray<HTMLElement>("[data-story-step]", root.current);
      const screens = gsap.utils.toArray<HTMLElement>("[data-story-screen]", root.current);
      const railFill = root.current?.querySelector<HTMLElement>("[data-story-rail-fill]");
      if (screens.length < 2) return;

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
    });

    mm.add("(min-width: 761px)", () => {
      const track = root.current?.querySelector<HTMLElement>("[data-story-track]");
      const panels = gsap.utils.toArray<HTMLElement>("[data-story-panel]", root.current);
      const progressFill = root.current?.querySelector<HTMLElement>("[data-story-progress-fill]");
      if (!track || panels.length < 2) return;

      panels.slice(1).forEach((panel) => {
        gsap.set(panel.querySelectorAll<HTMLElement>("[data-reveal-item]"), { autoAlpha: 0, y: 10 });
      });
      gsap.set(progressFill ?? [], { scaleX: 0 });

      const story = gsap.timeline({
        scrollTrigger: {
          trigger: "[data-story-pin]",
          start: "top top",
          end: () => `+=${panels.length * window.innerHeight * 1.15}`,
          scrub: 0.85,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          snap: { snapTo: "labelsDirectional", duration: { min: 0.3, max: 0.55 }, ease: "power2.out" },
          onUpdate: (self) => { if (progressFill) gsap.set(progressFill, { scaleX: self.progress }); },
        },
      });

      // xPercent moves the track by a fraction of ITS OWN width (300%), not one
      // panel's width — divide by panels.length so each step advances exactly
      // one panel instead of overshooting by 3x.
      const stepXPercent = 100 / panels.length;

      story.addLabel("panel-0");
      panels.slice(1).forEach((panel, index) => {
        const revealItems = panel.querySelectorAll<HTMLElement>("[data-reveal-item]");
        story
          .to(track, { xPercent: -stepXPercent * (index + 1), duration: 1, ease: "power2.inOut" })
          .addLabel(`panel-${index + 1}`)
          .to(revealItems, { autoAlpha: 1, y: 0, duration: 0.45, stagger: 0.09, ease: "power2.out" }, "-=0.35")
          .to({}, { duration: 0.55 });
      });
    });

    return () => mm.revert();
  }, { scope: root });

  return (
    <section id="workflow" className={pageStyles.workflow} ref={root}>
      <div className={pageStyles.workflowLead} data-section>
        <span className={pageStyles.sectionLabel}>How it works</span>
        <h2>A task should never<br />be a black box.</h2>
        <p>AtherNull makes each phase visible: what was asked, what the agent did, what changed, and what it cost.</p>
      </div>
      <LegacyStoryLayout />
      <HorizontalStoryLayout />
    </section>
  );
}
