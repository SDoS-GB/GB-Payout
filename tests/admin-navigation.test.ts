import { describe, expect, it } from "vitest"
import { ADMIN_VIEWS, DEFAULT_ADMIN_LOCATION, adminHref, parseAdminLocation } from "@/lib/admin/navigation"

describe("parseAdminLocation", () => {
  it("defaults to Due for a bare /admin and for junk", () => {
    expect(parseAdminLocation(null)).toEqual(DEFAULT_ADMIN_LOCATION)
    expect(parseAdminLocation(new URLSearchParams("view=nonsense&batch=abc&tech=-1"))).toEqual(DEFAULT_ADMIN_LOCATION)
  })

  it("reads every field from the query string", () => {
    expect(parseAdminLocation(new URLSearchParams("view=history&batch=42"))).toMatchObject({ view: "history", batchId: 42 })
    expect(parseAdminLocation(new URLSearchParams("view=settings&section=opening"))).toMatchObject({ view: "settings", section: "opening" })
    expect(parseAdminLocation(new URLSearchParams("view=settings&team=unmapped"))).toMatchObject({ view: "settings", section: "team", teamFilter: "unmapped" })
    expect(parseAdminLocation(new URLSearchParams("view=settings"))).toMatchObject({ view: "settings", section: "technicians" })
    expect(parseAdminLocation({ view: "due", tech: "7" })).toMatchObject({ view: "due", techId: 7 })
  })

  it("only exposes Due, Paid history, Review and Settings; retired pages land on Review", () => {
    expect(ADMIN_VIEWS).toEqual(["due", "history", "review", "settings"])
    expect(parseAdminLocation(new URLSearchParams("view=payouts")).view).toBe("review")
    expect(parseAdminLocation(new URLSearchParams("view=waiting")).view).toBe("review")
  })
})

describe("adminHref", () => {
  it("emits the shortest URL and round-trips", () => {
    expect(adminHref({ view: "due" })).toBe("/admin")
    expect(adminHref({ view: "history", batchId: 12 })).toBe("/admin?view=history&batch=12")
    expect(adminHref({ view: "settings", section: "team", teamFilter: "unmapped" })).toBe("/admin?view=settings&team=unmapped")
    expect(adminHref({ view: "settings", section: "sync" })).toBe("/admin?view=settings&section=sync")
    for (const loc of [
      { view: "review" as const },
      { view: "history" as const },
      { view: "settings" as const, section: "team" as const },
      { view: "due" as const, techId: 3 },
      { view: "settings" as const, section: "activity" as const },
    ]) {
      const href = adminHref(loc)
      const parsed = parseAdminLocation(new URL(href, "https://x.test").searchParams)
      expect(parsed).toMatchObject(loc)
    }
  })

  it("drops fields that do not belong to the view", () => {
    expect(adminHref({ view: "due", batchId: 9 })).toBe("/admin")
    expect(adminHref({ view: "history", techId: 9 })).toBe("/admin?view=history")
  })
})
