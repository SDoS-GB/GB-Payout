"use client"

import { useTransition } from "react"
import { usePathname, useRouter } from "next/navigation"
import Link from "next/link"
import { AlertTriangle } from "lucide-react"
import { signOutSession } from "@/app/actions/session"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/**
 * Error boundary for every /admin page. A failure while reading the saved
 * dashboard data (database or network) ends here with a way forward instead of
 * leaving the sign-in button spinning. It never reveals the underlying error
 * text; the digest is enough to find it in the server logs.
 */
export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()
  const onLoginPage = pathname?.endsWith("/login") ?? false

  const retry = () =>
    startTransition(() => {
      router.refresh()
      reset()
    })

  const signOut = () =>
    startTransition(async () => {
      try {
        await signOutSession()
      } catch {
        // The cookie may already be gone; the login page handles a missing session.
      }
      router.replace("/admin/login")
    })

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <CardTitle className="text-2xl">{onLoginPage ? "Sign-in page could not load" : "Dashboard could not load"}</CardTitle>
          <CardDescription className="text-pretty">
            {onLoginPage
              ? "The server could not be reached or the database did not answer. Nothing was changed."
              : "You are still signed in, but the saved payout data could not be read. This is usually a temporary database or network problem. No payouts were changed and no messages were sent."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error.digest && (
            <p className="text-center font-mono text-xs text-muted-foreground">Reference {error.digest}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button onClick={retry} disabled={pending} className="flex-1">
              {pending ? "Retrying…" : "Retry"}
            </Button>
            {!onLoginPage && (
              <Button onClick={signOut} disabled={pending} variant="outline" className="flex-1">
                Sign out
              </Button>
            )}
          </div>
          <Link href="/" className="text-center text-sm text-muted-foreground hover:underline">
            Back to calculator
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}
