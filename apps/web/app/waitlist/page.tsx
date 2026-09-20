import type { Metadata } from "next";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import { WaitlistForm } from "@/components/landing/waitlist-form";
import landing from "../landing.module.css";
import legal from "../legal.module.css";
import styles from "./waitlist.module.css";

export const metadata: Metadata = {
  title: "Join Waitlist | AtherNull",
  description: "Get early access to AtherNull — agent-executed engineering work, held in escrow until you approve it.",
};

export default function WaitlistPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={legal.hero}>
        <span>Early access</span>
        <h1>Join the waitlist.</h1>
        <p>We&apos;re bringing on new teams in small batches. Leave your email and we&apos;ll reach out when it&apos;s your turn.</p>
      </section>
      <div className={styles.card}>
        <WaitlistForm />
        <p className={styles.note}>No spam — just one email when your access is ready.</p>
      </div>
      <SiteFooter />
    </main>
  );
}
