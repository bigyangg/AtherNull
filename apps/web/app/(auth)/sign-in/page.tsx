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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { absoluteUrl, authClient } from "@/lib/auth/client";
import { describeAuthError } from "@/lib/auth/errors";

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackPath = searchParams.get("callbackURL") || "/projects";
  const urlError = describeAuthError(searchParams.get("error"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [magicEmail, setMagicEmail] = useState("");
  const [magicSent, setMagicSent] = useState(false);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [magicLoading, setMagicLoading] = useState(false);

  async function handlePasswordSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
      callbackURL: callbackPath,
    });

    setLoading(false);

    if (signInError) {
      if (signInError.code === "EMAIL_NOT_VERIFIED") {
        router.push(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      }
      setError(describeAuthError(signInError.code) ?? signInError.message ?? "Invalid email or password.");
      return;
    }

    router.push(callbackPath);
  }

  async function handleMagicLinkSubmit(event: FormEvent) {
    event.preventDefault();
    setMagicError(null);
    setMagicLoading(true);

    const { error: magicLinkError } = await authClient.signIn.magicLink({
      email: magicEmail,
      callbackURL: absoluteUrl(callbackPath),
      errorCallbackURL: absoluteUrl("/sign-in"),
    });

    setMagicLoading(false);

    if (magicLinkError) {
      setMagicError(describeAuthError(magicLinkError.code) ?? magicLinkError.message ?? "Something went wrong.");
      return;
    }

    setMagicSent(true);
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-lg">Sign in</CardTitle>
        <CardDescription>Welcome back to AtherNull.</CardDescription>
      </CardHeader>
      <CardContent>
        {urlError && (
          <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {urlError}
          </p>
        )}
        <Tabs defaultValue="password">
          <TabsList className="mb-4 w-full">
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="magic-link">Magic link</TabsTrigger>
          </TabsList>

          <TabsContent value="password">
            <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-3">
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
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={loading} className="mt-1">
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="magic-link">
            {magicSent ? (
              <p className="text-sm text-muted-foreground">
                Check <strong className="text-foreground">{magicEmail}</strong> for a sign-in
                link. It expires in 15 minutes.
              </p>
            ) : (
              <form onSubmit={handleMagicLinkSubmit} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="magic-email" className="text-xs font-medium text-muted-foreground">
                    Email
                  </label>
                  <Input
                    id="magic-email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@company.com"
                    value={magicEmail}
                    onChange={(event) => setMagicEmail(event.target.value)}
                  />
                </div>
                {magicError && <p className="text-sm text-destructive">{magicError}</p>}
                <Button type="submit" disabled={magicLoading} className="mt-1">
                  {magicLoading ? "Sending…" : "Send magic link"}
                </Button>
              </form>
            )}
          </TabsContent>
        </Tabs>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/sign-up" className="text-foreground underline underline-offset-4">
            Sign up
          </Link>
        </p>
      </CardContent>
    </AuthCard>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
