"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { absoluteUrl, authClient } from "@/lib/auth/client";
import { describeAuthError } from "@/lib/auth/errors";

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get("email");
  const urlError = describeAuthError(searchParams.get("error"));

  const { data: session, isPending } = authClient.useSession();
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // A click on the emailed link lands back here with a fresh session
  // (autoSignInAfterVerification) and no error — that's the success case.
  useEffect(() => {
    if (!isPending && session && !urlError) {
      const timeout = setTimeout(() => router.push("/projects"), 1200);
      return () => clearTimeout(timeout);
    }
  }, [isPending, session, urlError, router]);

  async function handleResend() {
    if (!email) return;
    setResendError(null);
    setResending(true);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: absoluteUrl("/verify-email"),
    });
    setResending(false);
    if (error) {
      setResendError(describeAuthError(error.code) ?? error.message ?? "Something went wrong.");
      return;
    }
    setResent(true);
  }

  if (!isPending && session && !urlError) {
    return (
      <AuthCard>
        <CardHeader>
          <CardTitle className="text-lg">Email verified</CardTitle>
          <CardDescription>Taking you to your projects…</CardDescription>
        </CardHeader>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <CardHeader>
        <CardTitle className="text-lg">
          {urlError ? "Verification failed" : "Check your email"}
        </CardTitle>
        <CardDescription>
          {urlError
            ? urlError
            : email
              ? `We sent a verification link to ${email}. Click it to activate your account.`
              : "We sent you a verification link. Click it to activate your account."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {email && (
          <>
            <Button
              variant="outline"
              className="w-full"
              disabled={resending || resent}
              onClick={handleResend}
            >
              {resent ? "Email sent" : resending ? "Sending…" : "Resend verification email"}
            </Button>
            {resendError && (
              <p className="mt-2 text-center text-sm text-destructive">{resendError}</p>
            )}
          </>
        )}
      </CardContent>
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
