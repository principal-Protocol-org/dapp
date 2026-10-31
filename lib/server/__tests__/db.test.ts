// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { toQuery } from "@/lib/server/db"
import { directUrl } from "../../../scripts/db-migrate.mjs"

describe("toQuery", () => {
  it("numbers the parameters and never interpolates a value into the SQL text", () => {
    const evil = "'; drop table x; --"
    const strings = Object.assign(["select * from t where a = ", " and b = ", ""], { raw: [] }) as unknown as TemplateStringsArray
    const q = toQuery(strings, [evil, 42])
    expect(q.text).toBe("select * from t where a = $1 and b = $2")
    expect(q.text).not.toContain("drop")
    expect(q.values).toEqual([evil, 42])
  })
})

describe("directUrl (migrations)", () => {
  const host = (url: string | null) => new URL(url as string).hostname
  it("strips -pooler from the hostname", () => {
    expect(host(directUrl({ DATABASE_URL: "postgres://u:p@ep-a-b-pooler.region.example.invalid/db" }))).toBe(
      "ep-a-b.region.example.invalid",
    )
  })
  it("prefers DATABASE_URL_UNPOOLED", () => {
    const url = directUrl({
      DATABASE_URL: "postgres://u:p@ep-x-pooler.example.invalid/db",
      DATABASE_URL_UNPOOLED: "postgres://u:p@direct.example.invalid/db",
    })
    expect(host(url)).toBe("direct.example.invalid")
  })
  it("leaves a non-Neon URL unchanged and returns null when unset", () => {
    expect(host(directUrl({ DATABASE_URL: "postgres://u:p@localhost:5432/db" }))).toBe("localhost")
    expect(directUrl({})).toBeNull()
  })
})
