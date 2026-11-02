import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PRODUCTION_ORIGIN, SOCIAL_IMAGE_ALT, TESTNET_ORIGIN, siteOrigin, socialImage } from "../site"

const ROOT = join(__dirname, "..", "..", "..")

describe("site origin for social cards", () => {
  it("is principalmarket.fi in production and the public testnet domain everywhere else", () => {
    expect(siteOrigin({ VERCEL_ENV: "production" })).toBe("https://principalmarket.fi")
    expect(siteOrigin({ VERCEL_ENV: "preview" })).toBe("https://testnet.principalmarket.fi")
    expect(siteOrigin({})).toBe(TESTNET_ORIGIN)
    expect(PRODUCTION_ORIGIN).toBe("https://principalmarket.fi")
  })

  it("points the card image at an absolute, public URL with its size and alt text", () => {
    expect(socialImage(TESTNET_ORIGIN)).toEqual({
      url: "https://testnet.principalmarket.fi/og-image.png",
      width: 1200,
      height: 630,
      alt: SOCIAL_IMAGE_ALT,
      type: "image/png",
    })
    expect(existsSync(join(ROOT, "public", "og-image.png"))).toBe(true)
  })

  it("has no app/opengraph-image file: on a Vercel preview Next would point it at the protected branch URL", () => {
    expect(existsSync(join(ROOT, "app", "opengraph-image.png"))).toBe(false)
    expect(existsSync(join(ROOT, "app", "twitter-image.png"))).toBe(false)
  })
})
