import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Product Thesis | AtherNull",
  description: "Why AtherNull is building a bounded, evidence-led workflow for agent-executed engineering work.",
};

export default function WhitepaperPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Product thesis / 2026</span>
        <h1>Autonomy needs<br />good boundaries.</h1>
        <p>AI agents can make meaningful code changes. The harder product problem is making that work scoped, observable, verifiable, and subject to a human decision.</p>
      </section>

      <div className={styles.content}>
        <div className={styles.notice}><strong>A working thesis, not a launch claim</strong><p>This paper explains the system AtherNull is building. A coding-engine prototype has been tested on a disposable repository; the complete customer workflow, connected apps, verification service, and payments are still in development.</p></div>

        <div className={styles.pullQuote}>“The unit of work is not a conversation. It is a bounded task with evidence and an explicit decision.”</div>

        <section>
          <span className={styles.kicker}>01 / The problem</span>
          <h2>Capability is only one part of delegation.</h2>
          <p>A code-writing agent may be able to understand a repository, edit files, and run tests. That does not automatically tell a team what was authorized, whether the result matches the request, what it cost, or who decided to ship it.</p>
          <p>A chat transcript is a poor system of record for engineering work. The requester needs a precise brief, a spend limit, progress that can be inspected, and an artifact that fits the team’s normal code-review process.</p>
        </section>

        <section>
          <span className={styles.kicker}>02 / The task</span>
          <h2>Make the contract of work explicit.</h2>
          <p>AtherNull’s proposed unit of work is a task. It connects an outcome to a repository, constraints, a definition of done, and a maximum budget. That structure makes the agent’s assignment understandable before it starts and the result judgeable when it finishes.</p>
          <p>The task's lifecycle follows the same shape end to end: estimate the cost, approve and fund the budget, execute the work, verify the result independently, and settle — accept and release payment, or reject and refund. The agent can report progress, but it should not control the state transitions that authorize acceptance or payment.</p>
        </section>

        <section>
          <span className={styles.kicker}>03 / The boundary</span>
          <h2>Give an agent room to work without giving away control.</h2>
          <p>Agent execution should happen away from production systems and sensitive credentials. Repository access needs to be scoped to the approved task. A worker must not hold the keys that settle escrow, and a task’s maximum spend should be enforced outside the model’s own instructions.</p>
          <p>These are design constraints, not features to add after the product grows. A useful agent is allowed to try, test, and iterate; a trustworthy system still decides where that authority ends.</p>
        </section>

        <section>
          <span className={styles.kicker}>04 / The evidence</span>
          <h2>Separate doing the work from verifying it.</h2>
          <p>The agent’s “done” message is an observation, not proof. The intended verification path inspects a fresh copy of the changed code, runs the relevant checks, and records what passed or failed. The requester should see the change set, test outcome, and usage before deciding whether to accept.</p>
          <p>Independent evidence will not eliminate every bug or subjective review decision. It does, however, make the approval decision better informed than a bare success message.</p>
        </section>

        <section>
          <span className={styles.kicker}>05 / The payment model</span>
          <h2>Payment should follow the decision.</h2>
          <p>The escrow design holds a task’s funds while work is underway. Release and refund are distinct settlement actions, and the worker cannot authorize either one. The standalone Solana program is being developed and tested separately from the customer application.</p>
          <p>Escrow alone does not decide whether software is good. It creates a clear point where the human review, the task record, and the settlement action must agree. Detailed customer-facing refund and dispute operations still depend on the complete service being built.</p>
        </section>

        <section>
          <span className={styles.kicker}>06 / The result</span>
          <h2>Keep the outcome in the team’s workflow.</h2>
          <p>The useful artifact is not an isolated answer. It is a reviewable set of changes, connected to the original task and returned to the repository where the team works. Issue and document connections can bring context in; the repository and review process give the result somewhere accountable to land.</p>
          <p>That is the product AtherNull is working toward: a way to request engineering work in plain language without losing ownership of the code, the budget, or the final decision.</p>
        </section>

        <div className={styles.nextCard}><div><span>Practical guide</span><strong>See how a task is meant to work.</strong><p>The documentation turns this thesis into a step-by-step customer workflow.</p></div><Link href="/docs">Explore the docs <ArrowRight aria-hidden="true" /></Link></div>
      </div>
      <SiteFooter />
    </main>
  );
}
