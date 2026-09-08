"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/lib/auth";
import { ApiRequestError } from "@/lib/api";
import { Button, Field, inputClass } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email, password);
      router.replace(user.role === "CHECKIN_OPERATOR" ? "/scanner" : "/dashboard");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0f2a4a] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-xs font-semibold tracking-[0.3em] text-[#d4af37] uppercase">
            Government House
          </p>
          <h1 className="mt-2 font-serif text-3xl font-bold text-white">
            Event Admissions
          </h1>
          <p className="mt-1 text-sm text-blue-200">Staff sign-in</p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl bg-white p-6 shadow-xl"
        >
          <div className="space-y-4">
            <Field label="Email">
              <input
                type="email"
                required
                autoComplete="username"
                className={inputClass}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@ghab.gov"
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                required
                autoComplete="current-password"
                className={inputClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>

        <p className="mt-6 text-center text-xs text-blue-200/70">
          Scanner devices: sign in with your scanner account, then use “Add to Home
          Screen” for offline use.
        </p>
      </div>
    </main>
  );
}
