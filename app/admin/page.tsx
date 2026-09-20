import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/security/session"
import { loadAdminDashboard } from "@/app/actions/admin"
import { AdminDashboard } from "@/components/admin/admin-dashboard"
import { getWebhookUrl } from "@/lib/public-origin"

export const dynamic = "force-dynamic"

export default async function AdminPage() {
  const session = await getCurrentSession()
  if (session?.kind !== "admin") redirect("/admin/login")

  const [data, webhookUrl] = await Promise.all([loadAdminDashboard(), getWebhookUrl()])

  return <AdminDashboard data={data} webhookUrl={webhookUrl} cronConfigured={Boolean(process.env.CRON_SECRET)} />
}
