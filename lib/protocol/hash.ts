import { sha256 } from "js-sha256"

// Task 4 ports format.ts and should re-export this helper from there.
export function hashLike(input: string): string {
  return `sha256:${sha256(input)}`
}
