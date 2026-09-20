import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCheck, GitBranch, ShieldCheck, Wallet } from "lucide-react";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Documentation | AtherNull",
  description: "A practical guide to the AtherNull task model, from brief and budget to evidence and approval.",
};

const STAGES = [
  { number: "01", title: "Define", text: "Describe the outcome, identify the repository, and make the acceptance criteria explicit." },
  { number: "02", title: "Run", text: "The agent works in an isolated environment while progress and usage are recorded." },
  { number: "03", title: "Verify", text: "Tests and a reviewable change set provide evidence before anyone accepts the result." },
  { number: "04", title: "Decide", text: "A human reviews the delivery and chooses whether to approve, revise, or reject it." },
] as const;

export default function DocsPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Product guide</span>
        <h1>From a brief to<br />a decision you can trust.</h1>
        <p>Understand the task lifecycle, what the agent receives, and what you should expect to review before work is accepted.</p>
      </section>

      <div className={styles.content}>
        <div className={styles.notice}><strong>Product status</strong><p>AtherNull is in development. This guide explains the intended customer workflow. Repository connections, task execution, and payments are not yet a live end-to-end customer service.</p></div>
        <nav className={styles.toc} aria-label="On this page">
          <strong>On this page</strong>
          <Link href="#workflow">The workflow</Link>
          <Link href="#brief">Write a useful brief</Link>
          <Link href="#budget">Budget and escrow</Link>
          <Link href="#delivery">Evidence and review</Link>
          <Link href="#connections">Connections</Link>
        </nav>

        <section id="workflow">
          <span className={styles.kicker}>01 / The workflow</span>
          <h2>One task. A visible path to completion.</h2>
          <p>A task begins with a specific outcome, not an open-ended chat. It should have enough context to do useful work and a clear point at which you can say whether that work is done.</p>
          <div className={styles.stageGrid}>
            {STAGES.map(({ number, title, text }) => <div key={number}><small>{number}</small><h3>{title}</h3><p>{text}</p></div>)}
          </div>
        </section>

        <section id="brief">
          <span className={styles.kicker}>02 / Scope</span>
          <h2>Write the task so the result can be judged.</h2>
          <p>A strong brief names the repository, the behavior to change, the constraints that matter, and how to tell whether the outcome is correct. The agent should not have to guess your definition of done.</p>
          <div className={styles.example}>
            <span>Example brief</span>
            <p>“Keep the cart after refresh. Persist the current items, restore them on return, and add tests for an empty cart and a returning shopper. Do not change the checkout design.”</p>
          </div>
          <p>Useful supporting context includes an issue link, relevant files, design notes, test commands, and any dependencies or areas the agent must not touch.</p>
        </section>

        <section id="budget">
          <span className={styles.kicker}>03 / Boundaries</span>
          <h2>Set the ceiling before work starts.</h2>
          <p>The planned task model separates the maximum amount a requester is willing to spend from the amount actually used. Usage should be visible while work is in progress; an agent should not be able to increase its own budget or authorize a payout.</p>
          <div className={styles.featureRow}><Wallet aria-hidden="true" /><div><strong>Budget</strong><p>A maximum spend belongs to the task, not an unlimited session.</p></div></div>
          <div className={styles.featureRow}><ShieldCheck aria-hidden="true" /><div><strong>Escrow</strong><p>The Solana escrow program is being developed separately. It is not yet connected to the customer workflow, so no live payment or refund flow should be assumed from this guide.</p></div></div>
        </section>

        <section id="delivery">
          <span className={styles.kicker}>04 / Evidence</span>
          <h2>Review the work, not just a success message.</h2>
          <p>The intended delivery is a change set you can inspect: what changed, which tests ran, whether they passed, and how much the task used. Verification should be independent of the agent’s own claim that it succeeded.</p>
          <div className={styles.featureRow}><GitBranch aria-hidden="true" /><div><strong>Reviewable changes</strong><p>The result should map back to your repository and its normal review process.</p></div></div>
          <div className={styles.featureRow}><CheckCheck aria-hidden="true" /><div><strong>Human decision</strong><p>You decide whether the result meets the brief. Approval is a separate step from the agent finishing its run.</p></div></div>
        </section>

        <section id="connections">
          <span className={styles.kicker}>05 / Context</span>
          <h2>Bring your tools into the task.</h2>
          <p>Repository, issue, and document connections are on the roadmap. GitHub, GitLab, Linear, Jira, and Notion are examples of the tools the product is being designed around, not live app connections today.</p>
          <p>Until these connections ship, the safest way to understand AtherNull is as a developing task system with a tested coding-engine prototype, not as a service that already acts across your accounts.</p>
        </section>

        <div className={styles.nextCard}><div><span>Keep exploring</span><strong>The thinking behind the model</strong><p>Read why bounded tasks, independent evidence, and explicit approval are central to AtherNull.</p></div><Link href="/whitepaper">Read the whitepaper <ArrowRight aria-hidden="true" /></Link></div>
      </div>
      <SiteFooter />
    </main>
  );
}
