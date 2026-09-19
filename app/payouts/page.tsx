import Link from "next/link"
import { ArrowLeft, Calculator } from "lucide-react"
import { getCurrentSession } from "@/lib/security/session"
import { listPayoutsForProfile } from "@/lib/payout/queries"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TechnicianPayoutList } from "@/components/payouts/technician-payout-list"

export const dynamic = "force-dynamic"

export default async function PayoutsPage() {
  const session = await getCurrentSession()

  if (!session || session.kind !== "technician") {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Sign in to see your payouts</CardTitle>
            <CardDescription>Log in with your PIN on the calculator page. Your Workiz job payouts appear here once you are signed in.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/">
                <Calculator className="h-4 w-4" />
                Go to calculator
              </Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  const data = await listPayoutsForProfile(session.profile.id)

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex flex-col">
            <h1 className="text-xl font-semibold tracking-tight">Your payouts</h1>
            <p className="text-sm text-muted-foreground">{session.profile.name} · from Workiz jobs</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              Calculator
            </Link>
          </Button>
        </div>
      </header>
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
        <TechnicianPayoutList data={data} />
      </div>
    </main>
  )
}
