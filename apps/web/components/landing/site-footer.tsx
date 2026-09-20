import Image from "next/image";
import Link from "next/link";
import { BookOpen, FileText, LogIn, Mail, RotateCcw, ShieldCheck } from "lucide-react";
import type { ComponentType } from "react";

import styles from "@/app/landing.module.css";

const FOOTER_COLUMNS: { heading: string; links: { label: string; href: string; icon: ComponentType<{ strokeWidth?: number }> }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Docs", href: "/docs", icon: BookOpen },
      { label: "Whitepaper", href: "/whitepaper", icon: FileText },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Refund policy", href: "/refund-policy", icon: RotateCcw },
      { label: "Privacy policy", href: "/privacy-policy", icon: ShieldCheck },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "Contact", href: "/contact", icon: Mail },
      { label: "Log in", href: "/sign-in", icon: LogIn },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Link href="/" aria-label="AtherNull home">
            <span className={styles.logoCrop}>
              <Image src="/brand/athernull-icon.png" alt="" width={28} height={28} />
            </span>
            <span>Ather<span>Null</span></span>
          </Link>
          <p>Agent-executed engineering work, held in escrow until you approve it.</p>
        </div>
        <div className={styles.footerColumns}>
          {FOOTER_COLUMNS.map(({ heading, links }) => (
            <div key={heading} className={styles.footerColumn}>
              <span>{heading}</span>
              {links.map(({ label, href, icon: Icon }) => (
                <Link key={label} href={href}><Icon strokeWidth={1.6} aria-hidden />{label}</Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.footerBottom}>
        <span>© {new Date().getFullYear()} AtherNull</span>
        <span>athernull.io</span>
        <span>AI agent orchestration platform</span>
      </div>
    </footer>
  );
}
