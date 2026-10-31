import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { render, renderHook, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { Manifest } from "@/lib/protocol/types"
import { ManifestProvider, useManifest } from "../manifest-provider"

const ROOT = join(__dirname, "..", "..", "..")

/** Every .ts/.tsx file under `dir`, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sources(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const isClient = (path: string) => /^\s*["']use client["']/.test(readFileSync(path, "utf8"))

describe("client code reads the server-resolved manifest", () => {
  it("client code no longer imports activeManifest (R2-5: \"use client\" files and every hook)", () => {
    const files = [
      ...sources(join(ROOT, "components")).filter(isClient),
      ...sources(join(ROOT, "app")).filter(isClient),
      ...sources(join(ROOT, "hooks")),
    ]
    expect(files.length).toBeGreaterThan(20)
    const offenders = files
      .filter((path) => /activeManifest|manifest-source/.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path))
    expect(offenders).toEqual([])
  })

  it("useManifest returns the manifest the server resolved", () => {
    const manifest = { network: "local", markets: [{ marketId: "local-usdy-1" }] } as unknown as Manifest
    function Name() {
      return <p>{useManifest().markets[0].marketId}</p>
    }
    render(
      <ManifestProvider manifest={manifest}>
        <Name />
      </ManifestProvider>,
    )
    expect(screen.getByText("local-usdy-1")).toBeTruthy()
  })

  it("useManifest outside the provider names the mistake", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => renderHook(() => useManifest())).toThrow(/ManifestProvider/)
  })
})
