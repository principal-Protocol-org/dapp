import { afterEach, describe, expect, it, vi } from "vitest"
import { bytesToHex } from "../bytes"

describe("bytesToHex", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("works without a Buffer global", () => {
    vi.stubGlobal("Buffer", undefined)
    delete (globalThis as { Buffer?: unknown }).Buffer
    expect("Buffer" in globalThis).toBe(false)
    expect(bytesToHex(new Uint8Array([0, 255]))).toBe("00ff")
  })
})
