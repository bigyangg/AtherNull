import Link from "next/link";
import { ArrowRight, GitBranch, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { siGithub, siGitlab, siJira, siLinear, siModelcontextprotocol, siNotion, type SimpleIcon } from "simple-icons";

import { Button } from "@/components/ui/button";
import { LandingMotion } from "@/components/landing/landing-motion";
import { HeroFlight } from "@/components/landing/hero-flight";
import { HeroTitle } from "@/components/landing/hero-title";
import { IntegrationFlow } from "@/components/landing/integration-flow";
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

const INTEGRATIONS: { name: string; icon: SimpleIcon | null; role: string }[] = [
  { name: "GitHub", icon: siGithub, role: "Repositories" },
  { name: "GitLab", icon: siGitlab, role: "Repositories" },
  { name: "Linear", icon: siLinear, role: "Issues" },
  { name: "Jira", icon: siJira, role: "Issues" },
  { name: "Notion", icon: siNotion, role: "Context" },
  { name: "Slack", icon: null, role: "Conversations" },
  { name: "MCP", icon: siModelcontextprotocol, role: "Internal tools" },
];

const INTEGRATION_GROUPS = [
  { label: "Code", description: "Where the work lives", names: ["GitHub", "GitLab"] },
  { label: "Requests", description: "Where work begins", names: ["Linear", "Jira", "Slack"] },
  { label: "Context", description: "What the agent can use", names: ["Notion", "MCP"] },
] as const;

function SlackLogo() {
  return (
    <svg viewBox="0 0 80 80" role="img" aria-label="Slack logo">
      <path fill="#E01E5A" d="M17.0676 50.1813C17.0676 54.7603 13.3668 58.4612 8.78773 58.4612C4.20868 58.4612.507812 54.7603.507812 50.1813S4.20868 41.9014 8.78773 41.9014h8.27987v8.2799ZM21.2076 50.1813c0-4.5791 3.7009-8.2799 8.2799-8.2799s8.2799 3.7008 8.2799 8.2799v20.6998c0 4.579-3.7008 8.2799-8.2799 8.2799s-8.2799-3.7009-8.2799-8.2799V50.1813Z" />
      <path fill="#36C5F0" d="M29.4877 16.9358c-4.579 0-8.2799-3.7009-8.2799-8.27991S24.9087.375977 29.4877.375977s8.28 3.700873 8.28 8.279913v8.27991h-8.28ZM29.4877 21.1385c4.5791 0 8.28 3.7009 8.28 8.2799s-3.7009 8.2799-8.28 8.2799H8.72523c-4.57905 0-8.279918-3.7008-8.279918-8.2799s3.700868-8.2799 8.279918-8.2799H29.4877Z" />
      <path fill="#2EB67D" d="M62.6685 29.4184c0-4.579 3.7009-8.2799 8.28-8.2799s8.2799 3.7009 8.2799 8.2799-3.7009 8.2799-8.2799 8.2799h-8.28v-8.2799ZM58.5286 29.4184c0 4.5791-3.7009 8.2799-8.2799 8.2799s-8.2799-3.7008-8.2799-8.2799V8.65589c0-4.57904 3.7009-8.279913 8.2799-8.279913s8.2799 3.700873 8.2799 8.279913V29.4184Z" />
      <path fill="#ECB22E" d="M50.2487 62.6012c4.579 0 8.2799 3.7008 8.2799 8.2799s-3.7009 8.2799-8.2799 8.2799-8.2799-3.7009-8.2799-8.2799v-8.2799h8.2799ZM50.2487 58.4612c-4.5791 0-8.2799-3.7009-8.2799-8.2799s3.7008-8.2799 8.2799-8.2799h20.7625c4.579 0 8.2799 3.7009 8.2799 8.2799s-3.7009 8.2799-8.2799 8.2799H50.2487Z" />
    </svg>
  );
}

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
          <noscript>
            <style>{`[data-hero-copy],[data-hero-actions]{opacity:1}`}</style>
          </noscript>
        </section>

        <section id="ownership" className={ownership.section} data-section>
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
            <p>Requests may begin in Slack or an issue. Repositories hold the code, docs add context, and MCP can connect internal tools. Bring the right inputs together, then review the result where your team works.</p>
          </div>
          <div className={styles.integrationFrame}>
            <div className={styles.integrationFrameTop}><span>Connection roadmap</span><span>Designed around your existing stack</span></div>
            <div className={styles.integrationGrid}>
              {INTEGRATION_GROUPS.map((group, index) => (
                <div className={styles.integrationGroup} key={group.label} data-benefit>
                  <div className={styles.integrationGroupHeading}><span>0{index + 1} / {group.label}</span><small>{group.description}</small></div>
                  <div className={styles.integrationGroupCards}>
                    {group.names.map((name) => {
                      const integration = INTEGRATIONS.find((item) => item.name === name)!;
                      const { icon, role } = integration;
                      return <div className={styles.integrationTile} key={name}>
                        <div className={styles.integrationIcon} style={{ background: icon ? `#${icon.hex}14` : "#f7f0f8" }}>
                          {icon ? <svg viewBox="0 0 24 24" role="img" aria-label={`${name} logo`} style={{ color: `#${icon.hex}` }}><path fill="currentColor" d={icon.path} /></svg> : <SlackLogo />}
                        </div>
                        <div><strong>{name}</strong><span>{role}</span></div>
                      </div>;
                    })}
                  </div>
                </div>
              ))}
            </div>
            <IntegrationFlow />
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
