// @vitest-environment node
import { describe, expect, it } from "vitest"
import { fetchAccount, fetchIssuerFlags } from "../horizon"

const URL = "https://horizon.example"

function fakeFetch(status: number, body: unknown, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input))
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
}

describe("fetchAccount", () => {
  it("GETs /accounts/{id} and returns balances", async () => {
    const seen: string[] = []
    const body = {
      last_modified_ledger: 55,
      balances: [
        { asset_type: "credit_alphanum4", asset_code: "STA", asset_issuer: "GISS", balance: "1.0000000", is_authorized: true },
        { asset_type: "native", balance: "9.0" },
      ],
    }
    const r = await fetchAccount(`${URL}/`, "GABC", fakeFetch(200, body, seen))
    expect(seen).toEqual([`${URL}/accounts/GABC`])
    expect(r).toMatchObject({ status: "live", ledger: 55 })
    expect(r.status === "live" && r.value?.balances).toHaveLength(2)
  })

  it("404 is a live null: the account does not exist", async () => {
    const r = await fetchAccount(URL, "GABC", fakeFetch(404, { status: 404 }))
    expect(r).toMatchObject({ status: "live", value: null })
  })

  it("any other failure is unavailable", async () => {
    expect((await fetchAccount(URL, "GABC", fakeFetch(500, {}))).status).toBe("unavailable")
    expect((await fetchAccount(URL, "GABC", fakeFetch(429, {}))).status).toBe("unavailable")
    const boom = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    expect(await fetchAccount(URL, "GABC", boom)).toEqual({ status: "unavailable", error: "network down" })
  })

  it("a malformed body is unavailable", async () => {
    expect((await fetchAccount(URL, "GABC", fakeFetch(200, { nope: 1 }))).status).toBe("unavailable")
  })
})

describe("fetchIssuerFlags", () => {
  it("maps the issuer account flags", async () => {
    const body = { flags: { auth_required: true, auth_revocable: true, auth_clawback_enabled: false } }
    const r = await fetchIssuerFlags(URL, "GISS", fakeFetch(200, body))
    expect(r).toMatchObject({
      status: "live",
      value: { authRequired: true, authRevocable: true, clawbackEnabled: false },
    })
  })

  it("an issuer that cannot be found is unavailable, not flagless", async () => {
    expect((await fetchIssuerFlags(URL, "GISS", fakeFetch(404, {}))).status).toBe("unavailable")
    expect((await fetchIssuerFlags(URL, "GISS", fakeFetch(200, {}))).status).toBe("unavailable")
  })
})
