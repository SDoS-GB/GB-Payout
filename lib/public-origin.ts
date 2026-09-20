import { headers } from "next/headers"

/**
 * The origin Workiz must call. Production domain first so the admin panel shows the
 * same URL from any deployment; falls back to the current request host for previews.
 */
export async function getPublicOrigin(): Promise<string> {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host")
  if (!host) return ""
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")
  return `${proto}://${host}`
}

export async function getWebhookUrl(): Promise<string> {
  const origin = await getPublicOrigin()
  return origin ? `${origin}/api/workiz/webhook` : "/api/workiz/webhook"
}
