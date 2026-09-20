import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import styles from "@/app/landing.module.css";

export function SiteHeader() {
  return (
    <header className={styles.nav}>
      <Link href="/" className={styles.brand} aria-label="AtherNull home">
        <span className={styles.logoCrop}>
          <Image src="/brand/athernull-dark.png" alt="" width={512} height={512} priority />
        </span>
        <span>Ather<span>Null</span></span>
      </Link>
      <nav className={styles.navLinks} aria-label="Primary navigation">
        <Link href="/#workflow">How it works</Link>
        <Link href="/#integrations">Integrations</Link>
        <Link href="/#principles">Principles</Link>
      </nav>
      <div className={styles.navActions}>
        <Link className={styles.login} href="/sign-in">Log in</Link>
        <Button asChild size="sm" className={styles.darkButton}>
          <Link href="/sign-up">Request access <ArrowRight /></Link>
        </Button>
      </div>
    </header>
  );
}
