import type { Metadata } from "next";
import { Mail } from "lucide-react";
import Link from "next/link";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Whitepaper | AtherNull",
  description: "The thesis behind AtherNull: escrow-backed, agent-executed engineering work.",
};

export default function WhitepaperPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Whitepaper</span>
        <h1>Autonomy needs<br />good boundaries.</h1>
        <p>The full paper is in progress. This page holds the thesis in the meantime — a summary of the model AtherNull is built on.</p>
      </section>
      <div className={styles.content}>
        <section>
          <h2>The problem</h2>
          <p>Agentic coding tools can already understand a codebase and make real changes. What is missing is not capability — it is a way to hand that capability real-world constraints: a fixed budget, verifiable evidence of what happened, and a moment where a human decides whether the result ships.</p>
        </section>
        <section>
          <h2>The model</h2>
          <p>AtherNull treats every task as a funded contract, not an open-ended chat. A task is briefed with an outcome, a repository, and a maximum spend. The agent works against that repository on its own branch. Funds are held in escrow for the duration of the run and only release once the requester approves the result.</p>
        </section>
        <section>
          <h2>Why escrow</h2>
          <p>Escrow aligns incentives on both sides of the task. The requester is not asked to trust a result before seeing it, and the work is not released speculatively before it is paid for. Release is a single, explicit action tied to review — not a background assumption.</p>
        </section>
        <section>
          <h2>Why it stays in your repository</h2>
          <p>Work is not produced in an isolated sandbox and handed over as a diff to trust blindly. It happens directly in your repository, on a branch, with the same tooling, tests, and review process you already use — so the final artifact is a pull request, not a black box.</p>
        </section>
        <div className={styles.contactCard}>
          <Mail aria-hidden />
          <div>
            <strong>Want the full paper when it ships?</strong>
            <span>Reach out via the <Link href="/contact">contact page</Link> and we will let you know.</span>
          </div>
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
