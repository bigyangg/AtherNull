import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check, GitBranch, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { siGithub, siGitlab, siJira, siLinear, siNotion, type SimpleIcon } from "simple-icons";

import { Button } from "@/components/ui/button";
import { LandingMotion } from "@/components/landing/landing-motion";
import { HeroFlight } from "@/components/landing/hero-flight";
import { HeroTitle } from "@/components/landing/hero-title";
import { OwnershipFlow } from "@/components/landing/ownership-flow";
import ownership from "@/components/landing/ownership-flow.module.css";
import styles from "./landing.module.css";

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

const INTEGRATIONS: { name: string; icon: SimpleIcon; role: string }[] = [
  { name: "GitHub", icon: siGithub, role: "Repositories" },
  { name: "GitLab", icon: siGitlab, role: "Repositories" },
  { name: "Linear", icon: siLinear, role: "Issues" },
  { name: "Jira", icon: siJira, role: "Issues" },
  { name: "Notion", icon: siNotion, role: "Context" },
];

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <LandingMotion>
        <header className={styles.nav}>
          <Link href="/" className={styles.brand} aria-label="AtherNull home">
            <span className={styles.logoCrop}>
              <Image src="/brand/athernull-dark.png" alt="" width={512} height={512} priority />
            </span>
            <span>Ather<span>Null</span></span>
          </Link>
          <nav className={styles.navLinks} aria-label="Primary navigation">
            <a href="#workflow">How it works</a>
            <a href="#integrations">Integrations</a>
            <a href="#principles">Principles</a>
          </nav>
          <div className={styles.navActions}>
            <Link className={styles.login} href="/sign-in">Log in</Link>
            <Button asChild size="sm" className={styles.darkButton}>
              <Link href="/sign-up">Request access <ArrowRight /></Link>
            </Button>
          </div>
        </header>

        <section className={styles.hero} data-hero>
          <HeroFlight />
          <HeroTitle />
          <p className={styles.heroCopy} data-hero-copy>Tell AtherNull what needs to happen. Agents understand your codebase, complete the work, and return proof. Not just a promise.</p>
          <div className={styles.heroActions} data-hero-actions>
            <Button asChild size="lg" className={styles.darkButton}><Link href="/sign-up">Start a project <ArrowRight /></Link></Button>
            <a className={styles.textButton} href="#workflow">See the workflow <ArrowRight /></a>
          </div>
        </section>

        <section className={ownership.section} data-section>
          <div className={ownership.intro}>
            <span>Built around ownership</span>
            <h2>You own the code.<br />You set the terms.</h2>
            <p className={ownership.copy}>Give agents room to work. Keep control of what matters. From the first brief to the final review, every step stays connected to you.</p>
            <div className={ownership.terms}>
              <div><GitBranch aria-hidden /><div><strong>Your repository</strong><p>Work happens in your codebase.</p></div><small>01</small></div>
              <div><Wallet aria-hidden /><div><strong>Your budget</strong><p>Set the ceiling before work begins.</p></div><small>02</small></div>
              <div><ShieldCheck aria-hidden /><div><strong>Your approval</strong><p>Review the evidence. Decide what ships.</p></div><small>03</small></div>
            </div>
          </div>
          <OwnershipFlow />
        </section>

        <section id="workflow" className={styles.workflow}>
          <div className={styles.workflowLead} data-section>
            <span className={styles.sectionLabel}>How it works</span>
            <h2>A task should never<br />be a black box.</h2>
            <p>AtherNull makes each phase visible: what was asked, what the agent did, what changed, and what it cost.</p>
          </div>
          <div className={styles.storyLayout} data-story-layout>
            <div className={styles.storySteps}>
              <div className={styles.storyRail} aria-hidden="true"><span className={styles.storyRailFill} data-story-rail-fill /></div>
              {STEPS.map((step, index) => <article key={step.number} data-story-step className={index === 0 ? styles.stepActive : undefined}><span>{step.number}</span><h3>{step.title}</h3><p>{step.text}</p></article>)}
            </div>
            <div className={styles.storyVisual} data-story-visual aria-label="Task workflow preview">
              <div className={`${styles.storyScreen} ${styles.screenBrief}`} data-story-screen>
                <div className={styles.screenBar}><span>1 of 3 · Task brief</span><small>Ready to fund</small></div>
                <div className={styles.screenBody}><span className={styles.screenLabel}>What needs to happen?</span><h3>Make checkout feel instant.</h3><p>Persist cart state, reduce steps, and verify the address and payment flow on mobile.</p><div className={styles.taskMeta}><span>Repository <b>acme/storefront</b></span><span>Budget <b>$42.00</b></span></div><button>Fund task <ArrowRight /></button></div>
              </div>
              <div className={`${styles.storyScreen} ${styles.screenAgent}`} data-story-screen>
                <div className={styles.screenBar}><span><i /> 2 of 3 · Agent run</span><small>In progress</small></div>
                <div className={styles.runRows}><div data-reveal-item><Check /><span><b>Repository mapped</b><small>24 files understood</small></span><time>00:18</time></div><div data-reveal-item><Check /><span><b>Cart persistence added</b><small>3 files changed</small></span><time>01:42</time></div><div className={styles.running} data-reveal-item><i /><span><b>Checkout tests running</b><small>Payment and address paths</small></span><time>now</time></div></div><div className={styles.codeLine} data-reveal-item><span>checkout-session.ts</span><b>+48 −12</b></div>
              </div>
              <div className={`${styles.storyScreen} ${styles.screenReview}`} data-story-screen>
                <div className={styles.screenBar}><span>3 of 3 · Review</span><small>Ready for you</small></div>
                <div className={styles.reviewScore} data-reveal-item><Check /><div><span>All checks passed</span><b>Ready to merge</b></div></div><div className={styles.reviewList}><div data-reveal-item><span>Changes</span><b>8 files</b></div><div data-reveal-item><span>Tests</span><b>24 passed</b></div><div data-reveal-item><span>Final cost</span><b>$12.84</b></div></div><button data-reveal-item>Review pull request <ArrowRight /></button></div>
            </div>
          </div>
        </section>

        <section id="integrations" className={styles.integrations}>
          <div className={styles.integrationsHead} data-section>
            <div><span className={styles.sectionLabel}>Connected workflow</span><h2>Your tools,<br />in the loop.</h2></div>
            <p>Issues carry the request. Repositories hold the code. Docs explain the context. Bring them together so an agent can start with the full picture and return work where your team reviews it.</p>
          </div>
          <div className={styles.integrationFrame}>
            <div className={styles.integrationFrameTop}><span>Connection roadmap</span><span>Designed around your existing stack</span></div>
            <div className={styles.integrationGrid}>
              {INTEGRATIONS.map(({ name, icon, role }) => (
                <div className={styles.integrationTile} key={name} data-benefit>
                  <svg viewBox="0 0 24 24" role="img" aria-label={`${name} logo`} style={{ color: `#${icon.hex}` }}><path fill="currentColor" d={icon.path} /></svg>
                  <strong>{name}</strong><span>{role}</span>
                </div>
              ))}
            </div>
            <div className={styles.integrationFrameBottom}><span>Collect the context</span><ArrowRight aria-hidden /><span>Run the task</span><ArrowRight aria-hidden /><span>Review the result</span></div>
          </div>
        </section>

        <section id="principles" className={styles.principles}>
          <div className={styles.principlesHeading} data-section><span className={styles.sectionLabel}>Designed for trust</span><h2>Autonomy needs<br />good boundaries.</h2></div>
          <div className={styles.principlesGrid}>
            <article data-benefit><Wallet /><span>01</span><h3>Budget before work</h3><p>Start every task with a ceiling. Cost is a decision, not a surprise.</p></article>
            <article data-benefit><ShieldCheck /><span>02</span><h3>Escrow until review</h3><p>Funds stay held while the agent works and only release after approval.</p></article>
            <article data-benefit><GitBranch /><span>03</span><h3>Changes stay yours</h3><p>Every task works against your repository and ends with a reviewable change set.</p></article>
          </div>
        </section>

        <section className={styles.finalCta} data-section><Sparkles /><p>The next release starts with one sentence.</p><h2>Give your idea<br />a way forward.</h2><Button asChild size="lg" className={styles.darkButton}><Link href="/sign-up">Request early access <ArrowRight /></Link></Button></section>
      </LandingMotion>
      <footer className={styles.footer}><span>© {new Date().getFullYear()} AtherNull</span><span>AI agent orchestration platform</span><div><Link href="/sign-in">Log in</Link><Link href="/sign-up">Request access</Link></div></footer>
    </main>
  );
}
