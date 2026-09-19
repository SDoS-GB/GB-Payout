"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ShieldCheck } from "lucide-react"
import { signInAdmin } from "@/app/actions/session"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function AdminLoginForm({ needsBootstrap, bootstrapAvailable }: { needsBootstrap: boolean; bootstrapAvailable: boolean }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await signInAdmin(password)
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.push("/admin")
      router.refresh()
    })
  }

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
        <form onSubmit={submit} className="flex flex-col gap-4">
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
              disabled={pending}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending || (needsBootstrap && !bootstrapAvailable)}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          <Link href="/" className="text-center text-sm text-muted-foreground hover:underline">
            Back to calculator
          </Link>
        </form>
      </CardContent>
    </Card>
  )
}
