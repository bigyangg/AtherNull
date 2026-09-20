import type { Metadata } from "next";
import { BookOpen, GitBranch, Plug, ShieldCheck, Wallet } from "lucide-react";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Docs | AtherNull",
  description: "How AtherNull briefs, budgets, and reviews agent-executed work.",
};

const TOPICS = [
  { icon: BookOpen, title: "Brief a task", text: "Write the outcome you want, point at a repository, and AtherNull scopes the work before anything starts." },
  { icon: Wallet, title: "Set a budget", text: "Every task starts with a ceiling. The agent works inside it — cost is a decision you make up front, not a surprise." },
  { icon: ShieldCheck, title: "Escrow & review", text: "Funds are held in escrow while the agent works and only release once you approve the result." },
  { icon: GitBranch, title: "Changes & repositories", text: "Work happens on its own branch in your repository and ends as a reviewable pull request." },
  { icon: Plug, title: "Integrations", text: "Connect GitHub, GitLab, Linear, Jira, and Notion so an agent can start with full context and return work where your team already reviews it." },
] as const;

export default function DocsPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Docs</span>
        <h1>Start here.</h1>
        <p>An overview of how AtherNull turns a brief into reviewed, merged work. Deeper guides and an API reference are on the way — this page will grow with them.</p>
      </section>
      <div className={styles.content}>
        <div className={styles.grid}>
          {TOPICS.map(({ icon: Icon, title, text }) => (
            <article key={title}><Icon /><h3>{title}</h3><p>{text}</p></article>
          ))}
        </div>
        <div className={styles.index}>
          <a href="/#workflow">See the workflow</a>
          <a href="/#integrations">Browse integrations</a>
          <a href="/whitepaper">Read the whitepaper</a>
          <a href="/contact">Ask a question</a>
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
