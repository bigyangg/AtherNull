"use client";

import { useState, type FormEvent } from "react";

import styles from "@/app/waitlist/waitlist.module.css";

export function WaitlistForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStatus("loading");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Try again.");
        setStatus("idle");
        return;
      }

      setStatus("done");
    } catch {
      setError("Something went wrong. Try again.");
      setStatus("idle");
    }
  }

  if (status === "done") {
    return (
      <div className={styles.success}>
        <strong>You&apos;re on the list.</strong>
        <span>We&apos;ll email you as soon as it&apos;s your turn.</span>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label htmlFor="waitlist-name">Name</label>
        <input
          id="waitlist-name"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="waitlist-email">Email</label>
        <input
          id="waitlist-email"
          type="email"
          autoComplete="email"
          required
          placeholder="ada@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <button type="submit" className={styles.submit} disabled={status === "loading"}>
        {status === "loading" ? "Joining…" : "Join Waitlist"}
      </button>
    </form>
  );
}
