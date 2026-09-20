"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

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

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get("token");

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setLoading(true);

    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    setLoading(false);

    if (resetError) {
      setError(describeAuthError(resetError.code) ?? resetError.message ?? "Something went wrong.");
      return;
    }

    setDone(true);
    setTimeout(() => router.push("/sign-in"), 1500);
  }

  if (!token) {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle className="text-lg">Invalid link</CardTitle>
          <CardDescription>
            This reset link is missing its token.{" "}
            <Link href="/forgot-password" className="text-foreground underline underline-offset-4">
              Request a new one
            </Link>
            .
          </CardDescription>
        </CardHeader>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle className="text-lg">Password updated</CardTitle>
          <CardDescription>Taking you to sign in…</CardDescription>
        </CardHeader>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-lg">Choose a new password</CardTitle>
        <CardDescription>Signs you out of every other device.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              New password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={loading} className="mt-1">
            {loading ? "Updating…" : "Update password"}
          </Button>
        </form>
      </CardContent>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
