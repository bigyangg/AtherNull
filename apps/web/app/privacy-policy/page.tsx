import type { Metadata } from "next";

import { SiteFooter } from "@/components/landing/site-footer";
import { SiteHeader } from "@/components/landing/site-header";
import landing from "../landing.module.css";
import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy | AtherNull",
  description: "How AtherNull collects, uses, and protects your information.",
};

const LAST_UPDATED = "September 20, 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className={landing.page}>
      <SiteHeader />
      <section className={styles.hero}>
        <span>Privacy policy</span>
        <h1>Your data,<br />handled deliberately.</h1>
        <p>This policy explains what AtherNull collects, why, and the choices you have about it.</p>
        <div className={styles.meta}><span>Last updated {LAST_UPDATED}</span></div>
      </section>
      <div className={styles.content}>
        <section>
          <h2>1. Overview</h2>
          <p>AtherNull ("we", "us") operates a platform that lets you brief, fund, and review work performed by AI agents against your own code repositories. This policy covers the account, billing, and usage data we collect to run that platform, and the source code and task content you connect to it.</p>
        </section>
        <section>
          <h2>2. Information we collect</h2>
          <ul>
            <li><strong>Account information</strong> — name, email address, and authentication details when you sign up or log in.</li>
            <li><strong>Task content</strong> — the briefs you write, budgets you set, and the repositories, issues, and documents you connect so an agent can complete a task.</li>
            <li><strong>Billing information</strong> — payment method details, handled by our payment processor, and a record of escrow deposits, releases, and refunds.</li>
            <li><strong>Usage data</strong> — how you interact with the product, device and browser information, and log data collected automatically.</li>
          </ul>
        </section>
        <section>
          <h2>3. How we use information</h2>
          <p>We use the information above to operate and improve the platform: to run agent tasks against the repositories you connect, hold and release escrow funds, authenticate your account, provide support, and communicate service or billing updates. We do not sell your data.</p>
        </section>
        <section>
          <h2>4. Data sharing</h2>
          <p>We share information only where it is necessary to provide the service: with infrastructure and payment providers that host the platform and process transactions, with the integrations you explicitly connect (such as GitHub, GitLab, Linear, Jira, or Notion), and where required by law.</p>
        </section>
        <section>
          <h2>5. Data security</h2>
          <p>We use industry-standard safeguards — encryption in transit, access controls, and scoped credentials for connected integrations — to protect account, billing, and task data. No method of transmission or storage is completely secure, and we work to reduce that risk continuously.</p>
        </section>
        <section>
          <h2>6. Data retention</h2>
          <p>We retain account and task data for as long as your account is active, and billing records for as long as required by applicable law. You can request deletion of your account and associated data at any time, subject to records we are required to keep.</p>
        </section>
        <section>
          <h2>7. Your rights</h2>
          <p>Depending on where you live, you may have the right to access, correct, export, or delete your personal information, and to object to or restrict certain processing. To exercise any of these rights, contact us using the details below.</p>
        </section>
        <section>
          <h2>8. Cookies</h2>
          <p>We use essential cookies to keep you signed in and remember basic preferences. We do not use third-party advertising cookies.</p>
        </section>
        <section>
          <h2>9. Changes to this policy</h2>
          <p>We may update this policy as the product evolves. Material changes will be announced on this page with an updated effective date.</p>
        </section>
        <section>
          <h2>10. Contact us</h2>
          <p>Questions about this policy can be sent to <a href="mailto:info@athernull.io">info@athernull.io</a>, or via the <a href="/contact">contact page</a>.</p>
        </section>
      </div>
      <SiteFooter />
    </main>
  );
}
