"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { describeAuthError } from "@/lib/auth/errors";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    // The server builds the reset link itself from WEB_APP_URL + token
    // (apps/api/src/auth.ts), so no redirectTo is needed here.
    const { error: requestError } = await authClient.requestPasswordReset({ email });

    setLoading(false);

    if (requestError) {
      setError(describeAuthError(requestError.code) ?? requestError.message ?? "Something went wrong.");
      return;
    }

    setSent(true);
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-lg">Reset your password</CardTitle>
        <CardDescription>
          {sent
            ? "If that email has an account, a reset link is on its way."
            : "Enter your email and we'll send you a reset link."}
        </CardDescription>
      </CardHeader>
      {!sent && (
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={loading} className="mt-1">
              {loading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        </CardContent>
      )}
      <CardContent className="pt-0">
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/sign-in" className="text-foreground underline underline-offset-4">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </AuthCard>
  );
}
