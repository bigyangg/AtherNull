import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "./site-footer.module.css";

const FOOTER_COLUMNS = [
  {
    heading: "Explore",
    links: [
      { label: "How it works", href: "/#workflow" },
      { label: "Integrations", href: "/#integrations" },
      { label: "Documentation", href: "/docs" },
      { label: "Whitepaper", href: "/whitepaper" },
    ],
  },
  {
    heading: "AtherNull",
    links: [
      { label: "Request access", href: "/waitlist" },
      { label: "Contact", href: "/contact" },
      { label: "Log in", href: "/sign-in" },
    ],
  },
  {
    heading: "Policies",
    links: [
      { label: "Privacy policy", href: "/privacy-policy" },
      { label: "Refund policy", href: "/refund-policy" },
    ],
  },
] as const;

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <div className={styles.brandArea}>
          <Link href="/" className={styles.brand} aria-label="AtherNull home">
            <span className={styles.logo}><Image src="/brand/athernull-icon.png" alt="" width={34} height={34} /></span>
            <span>Ather<span>Null</span></span>
          </Link>
          <p>Describe the work. Set the terms. Review the proof.</p>
          <span className={styles.brandNote}>A clearer way to work with coding agents.</span>
        </div>

        <nav className={styles.columns} aria-label="Footer navigation">
          {FOOTER_COLUMNS.map(({ heading, links }) => (
            <div key={heading} className={styles.column}>
              <h2>{heading}</h2>
              {links.map(({ label, href }) => (
                <Link key={label} href={href}>{label}<ArrowUpRight aria-hidden="true" /></Link>
              ))}
            </div>
          ))}
        </nav>
      </div>

      <div className={styles.bottom}>
        <span>© {new Date().getFullYear()} AtherNull</span>
        <span>Built around human approval.</span>
        <Link href="/contact">Questions? Get in touch <ArrowUpRight aria-hidden="true" /></Link>
      </div>
    </footer>
  );
}
