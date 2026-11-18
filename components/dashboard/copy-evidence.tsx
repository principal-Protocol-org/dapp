"use client"

import { ClipboardCopy } from "lucide-react"
import { toast } from "sonner"
import { useManifest } from "@/components/app/manifest-provider"
import { Button } from "@/components/ui/button"
import { evidenceRows, type VerifiableFigure } from "@/lib/protocol/dashboard/verify"

/** Puts `text` on the clipboard and says so; a browser without clipboard access gets an error toast, never silence. */
export function copyText(text: string, done: string): void {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard) {
    toast.error("This browser does not allow copying here")
    return
  }
  void clipboard.writeText(text).then(
    () => toast.success(done),
    () => toast.error("Could not copy"),
  )
}

/**
 * "Copy evidence table" (D-7): every figure on the page as a Markdown table with the TRANCHE_2_3
 * §15.2 (l.1824) columns (`evidenceRows`), "Verified" left blank for the reviewer. Contracts are
 * named by their role in the manifest. Disabled until a figure has been read.
 */
export function CopyEvidence({ figures }: { figures: VerifiableFigure[] }) {
  const manifest = useManifest()
  const n = figures.length
  return (
    <Button
      type="button"
      variant="secondary"
      size="toggle"
      disabled={n === 0}
      // Contracts named by role; each status says how old its read is at the moment of copying.
      onClick={() => copyText(evidenceRows(figures, { manifest, now: Date.now() }), `Evidence table copied: ${n} figure${n === 1 ? "" : "s"}`)}
    >
      <ClipboardCopy aria-hidden="true" className="size-3.5" />
      Copy evidence table
    </Button>
  )
}
