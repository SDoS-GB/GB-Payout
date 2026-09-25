"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { signInAdmin, type ActionResult } from "@/app/actions/session"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"

// Upper bound on the authentication request itself. The dashboard render that
// follows a successful sign-in is bounded separately by the /admin error boundary.
const AUTH_TIMEOUT_MS = 20_000

class AuthTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthTimeoutError("timeout")), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

type Phase = "idle" | "authenticating" | "opening"

export function AdminLoginForm({ needsBootstrap, bootstrapAvailable }: { needsBootstrap: boolean; bootstrapAvailable: boolean }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [pending, startTransition] = useTransition()

  const busy = pending || phase !== "idle"

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null)
    setPhase("authenticating")
    startTransition(async () => {
      let res: ActionResult
      try {
        res = await withTimeout(signInAdmin(password), AUTH_TIMEOUT_MS)
      } catch (err) {
        setPhase("idle")
        setError(
          err instanceof AuthTimeoutError
            ? "The sign-in request timed out. Check your connection and try again."
            : "Could not reach the server. Check your connection and try again.",
        )
        return
      }
      if (!res.ok) {
        setPhase("idle")
        setError(res.error)
        return
      }
      setPassword("")
      setPhase("opening")
      // The session cookie is set by the action; the dashboard is a server page,
      // so navigate and let it read the saved data. Any failure there lands in
      // app/admin/error.tsx with Retry / Sign out instead of an endless spinner.
      router.replace("/admin")
    })
  }

  const buttonLabel = phase === "authenticating" ? "Signing in…" : phase === "opening" ? "Opening dashboard…" : "Sign in"

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <CardTitle className="text-2xl">Admin sign in</CardTitle>
        <CardDescription>Workiz payout automation for Grout Brothers</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
          {needsBootstrap && (
            <Alert>
              <AlertDescription>
                {bootstrapAvailable
                  ? "First run: enter the ADMIN_SETUP_PASSWORD value. It becomes the admin password and can be changed later."
                  : "No admin password is set yet. Add an ADMIN_SETUP_PASSWORD environment variable (10+ characters) to bootstrap."}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-password">Password</Label>
            <Input
              id="admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "admin-password-error" : undefined}
              required
            />
          </div>
          {error && (
            <p id="admin-password-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy || (needsBootstrap && !bootstrapAvailable)}>
            {buttonLabel}
          </Button>
          <Link href="/" className="text-center text-sm text-muted-foreground hover:underline">
            Back to calculator
          </Link>
        </form>
      </CardContent>
    </Card>
  )
}
