import { redirect } from "next/navigation"
import { getCurrentSession } from "@/lib/security/session"
import { getAdminSettings } from "@/lib/settings"
import { AdminLoginForm } from "@/components/admin/admin-login-form"

export const dynamic = "force-dynamic"

export default async function AdminLoginPage() {
  const session = await getCurrentSession()
  if (session?.kind === "admin") redirect("/admin")
  const admin = await getAdminSettings()
  const needsBootstrap = !admin.passwordHash
  const bootstrapAvailable = Boolean(process.env.ADMIN_SETUP_PASSWORD)

  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <AdminLoginForm needsBootstrap={needsBootstrap} bootstrapAvailable={bootstrapAvailable} />
    </main>
  )
}
