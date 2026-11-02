/**
 * The public origin social cards (Open Graph, Twitter) point to. A Vercel branch URL sits behind
 * Vercel Authentication, so a link preview (WhatsApp, Slack, X…) could not load an image from it:
 * production uses principalmarket.fi, every other build the public testnet domain.
 */
export const PRODUCTION_ORIGIN = "https://principalmarket.fi"
export const TESTNET_ORIGIN = "https://testnet.principalmarket.fi"

export function siteOrigin(env: Record<string, string | undefined> = process.env): string {
  return env.VERCEL_ENV === "production" ? PRODUCTION_ORIGIN : TESTNET_ORIGIN
}

export const SOCIAL_IMAGE_ALT = "Principal: fixed income for tokenized real-world assets."

/**
 * The card image (public/og-image.png), as an absolute URL. It is declared in the metadata rather
 * than as app/opengraph-image.png: for that file convention Next uses the branch URL on a Vercel
 * preview, whatever metadataBase says.
 */
export function socialImage(origin: string) {
  return { url: `${origin}/og-image.png`, width: 1200, height: 630, alt: SOCIAL_IMAGE_ALT, type: "image/png" }
}
