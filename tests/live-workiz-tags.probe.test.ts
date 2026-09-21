/**
 * LIVE probe of Workiz `job/update` tag semantics. Opt-in only:
 *   LIVE_WORKIZ_TAG_PROBE=1 pnpm vitest run tests/live-workiz-tags.probe.test.ts
 *
 * It picks one old, fully paid, Done job, appends a probe tag, reads the job back,
 * then writes the original tag list and reads back again. Every step is printed so
 * the replace-vs-merge behaviour is observable. The job is left exactly as found
 * when the API replaces tags; if the API only merges, the probe tag stays and the
 * test fails loudly so it can be removed by hand.
 */
import { describe, expect, it } from "vitest"
import { getWorkizClient } from "@/lib/workiz/sync"
import { db } from "@/lib/db"
import { workizJobs } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"

const enabled = process.env.LIVE_WORKIZ_TAG_PROBE === "1"
const PROBE_TAG = process.env.LIVE_WORKIZ_TAG_NAME ?? "Payout Ready"

const tagsOf = (raw: Record<string, unknown> | null) => (Array.isArray(raw?.Tags) ? (raw!.Tags as unknown[]).map(String) : [])

describe.skipIf(!enabled)("live Workiz job/update Tags", () => {
  it("adds and removes a tag on one job", async () => {
    const { client } = await getWorkizClient()
    // Prefer an explicit UUID; otherwise the job with the oldest scheduled date (least likely to be edited right now).
    const pinned = process.env.LIVE_WORKIZ_TAG_UUID
    const [job] = await db
      .select({ uuid: workizJobs.uuid, serialId: workizJobs.serialId, status: workizJobs.status })
      .from(workizJobs)
      .where(pinned ? eq(workizJobs.uuid, pinned) : sql`true`)
      .orderBy(sql`${workizJobs.raw}->>'JobDateTime' asc`)
      .limit(1)
    expect(job, "need at least one synced job").toBeTruthy()
    console.log(`[probe] job #${job.serialId} (${job.uuid}) status=${job.status}`)

    const before = tagsOf(await client.getJob(job.uuid))
    console.log("[probe] tags before:", JSON.stringify(before))
    expect(before.map((t) => t.toLowerCase())).not.toContain(PROBE_TAG.toLowerCase())

    const addRes = await client.updateJob(job.uuid, { Tags: [...before, PROBE_TAG] })
    console.log("[probe] update(add) response:", JSON.stringify(addRes).slice(0, 300))
    const afterAdd = tagsOf(await client.getJob(job.uuid))
    console.log("[probe] tags after add:", JSON.stringify(afterAdd))
    expect(afterAdd.map((t) => t.toLowerCase()), "probe tag was not applied").toContain(PROBE_TAG.toLowerCase())
    for (const t of before) expect(afterAdd, `pre-existing tag "${t}" was lost`).toContain(t)

    const removeRes = await client.updateJob(job.uuid, { Tags: before })
    console.log("[probe] update(remove) response:", JSON.stringify(removeRes).slice(0, 300))
    const afterRemove = tagsOf(await client.getJob(job.uuid))
    console.log("[probe] tags after remove:", JSON.stringify(afterRemove))
    const replaced = !afterRemove.map((t) => t.toLowerCase()).includes(PROBE_TAG.toLowerCase())
    console.log(`[probe] RESULT: job/update Tags ${replaced ? "REPLACES the tag set (removal works)" : "only MERGES (removal via API is impossible)"}`)
    expect(replaced, `"${PROBE_TAG}" is still on job #${job.serialId}; remove it in Workiz by hand`).toBe(true)
    expect([...afterRemove].sort()).toEqual([...before].sort())
  }, 60_000)
})
