import type { Metadata } from "next";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Refund Policy | AtherNull",
  description: "How escrow, refunds, and disputes work on AtherNull.",
};

const LAST_UPDATED = "September 20, 2026";

export default function RefundPolicyPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Refund policy</span>
        <h1>Funds stay yours<br />until you approve work.</h1>
        <p>AtherNull is built on escrow, so most refund questions come down to one thing: did the task get approved?</p>
        <div className={styles.meta}><span>Last updated {LAST_UPDATED}</span></div>
      </section>
      <div className={styles.content}>
        <section>
          <h2>1. How escrow works</h2>
          <p>When you fund a task, your budget is placed in escrow — it is reserved, not charged to the agent's work in progress. Funds only move out of escrow when you approve the result. Until that point, the amount you set aside is eligible for a refund under the terms below.</p>
        </section>
        <section>
          <h2>2. Eligible for a refund</h2>
          <ul>
            <li>A task is canceled before an agent begins work on it.</li>
            <li>A task is canceled while an agent is still in progress, minus any usage already incurred at the time of cancellation.</li>
            <li>The delivered result does not meet the brief and you choose not to approve it, subject to review under Section 4.</li>
          </ul>
        </section>
        <section>
          <h2>3. Not eligible for a refund</h2>
          <ul>
            <li>Work that has been reviewed and approved, since approval is what releases escrow to the agent.</li>
            <li>Usage already incurred at the time a task is canceled mid-run (for example, compute already spent understanding the repository or making changes).</li>
            <li>Change requests after merge — these are follow-up tasks, not refund cases.</li>
          </ul>
        </section>
        <section>
          <h2>4. Disputed results</h2>
          <p>If a completed task does not meet the brief, decline the approval and describe what is missing. We review disputed tasks case by case and, where the delivered work clearly falls short of the brief, refund the unapproved escrow balance.</p>
        </section>
        <section>
          <h2>5. How to request a refund</h2>
          <p>Cancel the task from your dashboard before approval, or contact <a href="mailto:support@athernull.io">support@athernull.io</a> with the task ID and reason. We aim to resolve refund requests within 5 business days.</p>
        </section>
        <section>
          <h2>6. Processing time</h2>
          <p>Approved refunds are returned to your original payment method. Depending on your payment provider, funds typically appear within 5–10 business days of approval.</p>
        </section>
        <section>
          <h2>7. Changes to this policy</h2>
          <p>We may update this policy as the product evolves. Material changes will be announced on this page with an updated effective date.</p>
        </section>
        <section>
          <h2>8. Contact us</h2>
          <p>Questions about a specific task or refund can be sent to <a href="mailto:support@athernull.io">support@athernull.io</a>, or via the <a href="/contact">contact page</a>.</p>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
