import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/security/session"
import { loadAdminDashboard } from "@/app/actions/admin"
import { AdminDashboard } from "@/components/admin/admin-dashboard"

export const dynamic = "force-dynamic"

export default async function AdminPage() {
  const session = await getCurrentSession()
  if (session?.kind !== "admin") redirect("/admin/login")

  const data = await loadAdminDashboard()
  const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : ""

  return <AdminDashboard data={data} webhookUrl={`${origin}/api/workiz/webhook`} cronConfigured={Boolean(process.env.CRON_SECRET)} />
}
