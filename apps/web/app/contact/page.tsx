import type { Metadata } from "next";
import { LifeBuoy, Mail } from "lucide-react";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Contact | AtherNull",
  description: "Get in touch with the AtherNull team.",
};

const CHANNELS = [
  { icon: Mail, title: "General inquiries", text: "Questions about access, pricing, or how AtherNull fits your workflow.", contact: "info@athernull.io" },
  { icon: LifeBuoy, title: "Support", text: "Help with an active task, a billing issue, or an escrow release.", contact: "support@athernull.io" },
] as const;

export default function ContactPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Contact</span>
        <h1>Talk to us.</h1>
        <p>Pick the right inbox below and we will get back to you — typically within one business day.</p>
      </section>
      <div className={styles.content}>
        <div className={styles.grid}>
          {CHANNELS.map(({ icon: Icon, title, text, contact }) => (
            <article key={title}>
              <Icon />
              <h3>{title}</h3>
              <p>{text}</p>
              <p><a href={`mailto:${contact}`}>{contact}</a></p>
            </article>
          ))}
        </div>
        <div className={styles.index}>
          <a href="/docs">Docs</a>
          <a href="/refund-policy">Refund policy</a>
          <a href="/privacy-policy">Privacy policy</a>
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
