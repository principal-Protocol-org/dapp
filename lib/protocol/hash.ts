import { sha256 } from "js-sha256"

// Re-exported from format.ts.
export function hashLike(input: string): string {
  return `sha256:${sha256(input)}`
}
