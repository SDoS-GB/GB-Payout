/**
 * Thin, typed wrapper over the Workiz REST API (https://developer.workiz.com/).
 *
 * Verified from the published OpenAPI document (developer.workiz.com/api.json):
 *   - Base URL:      https://api.workiz.com/api/v1/{token}/
 *   - Read calls:    GET  job/all/, job/get/{UUID}/, team/all/
 *   - Write calls:   POST job/update/, job/addPayment/{UUID}/, job/assign/,
 *                    job/note/ (require the `api_secret` header)
 *   - Job payload:   UUID, SerialId, JobDateTime, JobEndDateTime, Status, SubStatus,
 *                    PaymentDueDate, JobTotal, SubTotal, ClientId, FirstName, LastName,
 *                    Address/City/State/PostalCode, Phone, Email, JobType, JobSource,
 *                    Team[] ({id, Name}), Tags[], Comments, JobNotes, plus optional
 *                    Items[] / Payments[] arrays on job/get/ when the account exposes them.
 *
 * Every response shape is treated as untrusted and normalised in `normalize.ts`.
 */

export const WORKIZ_API_BASE = "https://api.workiz.com/api/v1"

export type WorkizCredentials = {
  apiToken: string
  apiSecret: string
}

export class WorkizApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = "WorkizApiError"
  }
}

export type WorkizTeamMember = {
  id: string
  name: string
  role: string | null
  email: string | null
  phone: string | null
  active: boolean
  raw: Record<string, unknown>
}

export type WorkizRawJob = Record<string, unknown> & { UUID?: string }

type ListJobsParams = {
  startDate?: string // YYYY-MM-DD
  offset?: number
  records?: number
  onlyOpen?: boolean
}

export class WorkizClient {
  constructor(private readonly creds: WorkizCredentials) {
    if (!creds.apiToken) throw new Error("Workiz API token is not configured")
  }

  private url(path: string, query?: Record<string, string | number | boolean | undefined>) {
    const u = new URL(`${WORKIZ_API_BASE}/${encodeURIComponent(this.creds.apiToken)}/${path.replace(/^\//, "")}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v))
      }
    }
    return u.toString()
  }

  private async request<T>(method: "GET" | "POST", path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }) {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (method === "POST") {
      headers["Content-Type"] = "application/json"
      if (!this.creds.apiSecret) throw new Error("Workiz API secret is required for write calls")
      headers["api_secret"] = this.creds.apiSecret
    }
    const res = await fetch(this.url(path, opts?.query), {
      method,
      headers,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    if (!res.ok) {
      throw new WorkizApiError(`Workiz ${method} ${path} failed with ${res.status}`, res.status, path, json)
    }
    // Workiz wraps payloads as { flag: boolean, data: ..., has_more?: boolean }.
    if (json && typeof json === "object" && "flag" in json && (json as { flag: unknown }).flag === false) {
      throw new WorkizApiError(
        `Workiz ${method} ${path} returned flag=false`,
        res.status,
        path,
        json,
      )
    }
    return json as T
  }

  /** GET job/all/ — paginated list. Workiz caps `records` at 100. */
  async listJobs(params: ListJobsParams = {}) {
    const res = await this.request<{ flag: boolean; data: WorkizRawJob[]; has_more?: boolean; found?: number }>(
      "GET",
      "job/all/",
      {
        query: {
          start_date: params.startDate,
          offset: params.offset ?? 0,
          records: Math.min(params.records ?? 100, 100),
          only_open: params.onlyOpen ? "true" : undefined,
        },
      },
    )
    return { jobs: Array.isArray(res?.data) ? res.data : [], hasMore: Boolean(res?.has_more), found: res?.found ?? null }
  }

  /** GET job/get/{UUID}/ — single job with full detail. */
  async getJob(uuid: string): Promise<WorkizRawJob | null> {
    const res = await this.request<{ flag: boolean; data: WorkizRawJob | WorkizRawJob[] }>(
      "GET",
      `job/get/${encodeURIComponent(uuid)}/`,
    )
    const data = res?.data
    if (Array.isArray(data)) return data[0] ?? null
    return data ?? null
  }

  /** GET team/all/ — every team member with their stable numeric id. */
  async listTeam(): Promise<WorkizTeamMember[]> {
    const res = await this.request<{ flag: boolean; data: Array<Record<string, unknown>> }>("GET", "team/all/")
    const rows = Array.isArray(res?.data) ? res.data : []
    return rows.map((r) => ({
      id: String(r.id ?? r.Id ?? r.ID ?? ""),
      name: String(r.Name ?? r.name ?? `${r.FirstName ?? ""} ${r.LastName ?? ""}`.trim()),
      role: (r.Role ?? r.role ?? null) as string | null,
      email: (r.Email ?? r.email ?? null) as string | null,
      phone: (r.Phone ?? r.phone ?? null) as string | null,
      active: !(r.Active === false || r.active === false || r.Status === "Inactive"),
      raw: r,
    }))
  }

  /**
   * POST job/note/ — append an internal note to a job. Used as the default
   * technician notification channel because Workiz automations can forward a
   * job note to the assigned tech via SMS/push, and the note is visible in the
   * job timeline for audit.
   */
  async addJobNote(uuid: string, note: string) {
    return this.request<{ flag: boolean; data?: unknown }>("POST", "job/note/", {
      body: { UUID: uuid, Note: note },
    })
  }

  /** Cheap credential probe used by the admin settings screen. */
  async probe() {
    const started = Date.now()
    const team = await this.listTeam()
    const jobs = await this.listJobs({ records: 5 })
    return {
      ok: true as const,
      latencyMs: Date.now() - started,
      teamCount: team.length,
      sampleJobCount: jobs.jobs.length,
      sampleJobFields: jobs.jobs[0] ? Object.keys(jobs.jobs[0]).sort() : [],
      hasItems: jobs.jobs.some((j) => Array.isArray((j as Record<string, unknown>).Items)),
      hasPayments: jobs.jobs.some((j) => Array.isArray((j as Record<string, unknown>).Payments)),
    }
  }
}
