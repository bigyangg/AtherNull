import Link from "next/link";
import { ArrowRight, GitBranch, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { siGithub, siGitlab, siJira, siLinear, siNotion, type SimpleIcon } from "simple-icons";

import { Button } from "@/components/ui/button";
import { LandingMotion } from "@/components/landing/landing-motion";
import { HeroFlight } from "@/components/landing/hero-flight";
import { HeroTitle } from "@/components/landing/hero-title";
import { OwnershipFlow } from "@/components/landing/ownership-flow";
import { WorkflowStory } from "@/components/landing/workflow-story";
import ownership from "@/components/landing/ownership-flow.module.css";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import { TrustLoop } from "@/components/landing/trust-loop";
import styles from "./landing.module.css";

const PRINCIPLES = [
  { number: "01", title: "Budget before work", text: "Start every task with a ceiling. Cost is a decision, not a surprise.", icon: Wallet },
  { number: "02", title: "Escrow until review", text: "Funds stay held while the agent works and only release after approval.", icon: ShieldCheck },
  { number: "03", title: "Changes stay yours", text: "Every task works against your repository and ends with a reviewable change set.", icon: GitBranch },
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
        <SiteHeader />

        <section className={styles.hero} data-hero>
          <HeroFlight />
          <HeroTitle />
          <p className={styles.heroCopy} data-hero-copy>Tell AtherNull what needs to happen. Agents understand your codebase, complete the work, and return proof. Not just a promise.</p>
          <div className={styles.heroActions} data-hero-actions>
            <Button asChild size="lg" className={styles.darkButton}><Link href="/waitlist">Join Waitlist <ArrowRight /></Link></Button>
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

        <WorkflowStory />

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
                  <div className={styles.integrationIcon} style={{ background: `#${icon.hex}1a` }}>
                    <svg viewBox="0 0 24 24" role="img" aria-label={`${name} logo`} style={{ color: `#${icon.hex}` }}><path fill="currentColor" d={icon.path} /></svg>
                  </div>
                  <strong>{name}</strong><span>{role}</span>
                </div>
              ))}
            </div>
            <div className={styles.integrationFrameBottom}><span>Collect the context</span><ArrowRight aria-hidden /><span>Run the task</span><ArrowRight aria-hidden /><span>Review the result</span></div>
          </div>
        </section>

        <section id="principles" className={styles.principles}>
          <div className={styles.principlesHeading} data-section><span className={styles.sectionLabel}>Designed for trust</span><h2>Autonomy needs<br />good boundaries.</h2></div>
          <div className={styles.principlesLoop} data-section><TrustLoop /></div>
          <div className={styles.principlesList}>
            {PRINCIPLES.map(({ number, title, text, icon: Icon }) => (
              <article key={number} data-benefit><Icon /><small>{number}</small><h3>{title}</h3><p>{text}</p></article>
            ))}
          </div>
        </section>

        <section className={styles.finalCta} data-section><Sparkles /><p>The next release starts with one sentence.</p><h2>Give your idea<br />a way forward.</h2><Button asChild size="lg" className={styles.darkButton}><Link href="/waitlist">Join Waitlist <ArrowRight /></Link></Button></section>
      </LandingMotion>
      <SiteFooter />
    </main>
  );
}
