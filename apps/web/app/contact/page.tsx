import type { Metadata } from "next";
import Link from "next/link";
import { LifeBuoy, Mail } from "lucide-react";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Contact | AtherNull",
  description: "Questions about AtherNull, early access, or your account? Reach the right team.",
};

const CHANNELS = [
  { icon: Mail, title: "Product and early access", text: "Tell us what you are building, ask about the roadmap, or discuss how AtherNull could fit your team.", contact: "info@athernull.io" },
  { icon: LifeBuoy, title: "Account and support", text: "Questions about your account, a technical issue, or anything that needs a closer look.", contact: "support@athernull.io" },
] as const;

export default function ContactPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Contact</span>
        <h1>Let’s talk about<br />what comes next.</h1>
        <p>Questions about the product, early access, or your account? Choose the inbox that fits and tell us a little about what you need.</p>
      </section>
      <div className={styles.content}>
        <div className={styles.notice}><strong>A note on availability</strong><p>AtherNull is still being built. If you are asking about an integration or payment feature, include your use case so we can give you an accurate status.</p></div>
        <div className={styles.grid}>
          {CHANNELS.map(({ icon: Icon, title, text, contact }) => (
            <article key={title}>
              <Icon aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
              <p><a href={`mailto:${contact}`}>{contact}</a></p>
            </article>
          ))}
        </div>
        <section>
          <h2>Help us help you.</h2>
          <p>For a product question, include the kind of repository and workflow you want to use. For an account issue, include the email associated with your account. Please do not send passwords, private keys, or repository secrets by email.</p>
        </section>
        <div className={styles.index}>
          <Link href="/docs">Documentation</Link>
          <Link href="/refund-policy">Refund policy</Link>
          <Link href="/privacy-policy">Privacy policy</Link>
        </div>
      </div>
      <SiteFooter />
    </main>
  );
}
