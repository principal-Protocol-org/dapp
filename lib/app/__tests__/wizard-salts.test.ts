import { afterEach, describe, expect, it, vi } from "vitest"
import { readWizardSalts, rememberWizardSalt } from "../wizard-salts"

const A = "aa".repeat(32)
const B = "bb".repeat(32)

describe("the salts of the markets this browser started (a convenience: the link is what resumes)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it("remembers a salt per network, newest first, once", () => {
    rememberWizardSalt("testnet", A)
    rememberWizardSalt("testnet", B)
    rememberWizardSalt("testnet", A)
    expect(readWizardSalts("testnet")).toEqual([A, B])
    expect(readWizardSalts("local")).toEqual([])
  })

  it("keeps the last 20, and ignores anything that is not a salt", () => {
    for (let i = 0; i < 25; i++) rememberWizardSalt("testnet", i.toString(16).padStart(2, "0").repeat(32))
    expect(readWizardSalts("testnet")).toHaveLength(20)
    rememberWizardSalt("testnet", "nope")
    localStorage.setItem("pp-wizard-salts:local", JSON.stringify(["x", A, 5]))
    expect(readWizardSalts("local")).toEqual([A])
    localStorage.setItem("pp-wizard-salts:local", "{not json")
    expect(readWizardSalts("local")).toEqual([])
  })

  it("does not throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    expect(readWizardSalts("testnet")).toEqual([])
    expect(() => rememberWizardSalt("testnet", A)).not.toThrow()
  })
})
