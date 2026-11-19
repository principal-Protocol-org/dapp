"use client"

import { ClipboardCopy } from "lucide-react"
import { toast } from "sonner"
import { useManifest } from "@/components/app/manifest-provider"
import { Button } from "@/components/ui/button"
import { COMPLIANCE_ITEM_LABEL, type ComplianceItem } from "@/lib/protocol/compliance"

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function copyAddress(address: string): void {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard) {
    toast.error("This browser does not allow copying here")
    return
  }
  void clipboard.writeText(address).then(
    () => toast.success("Address copied"),
    () => toast.error("Could not copy the address"),
  )
}

/** Whether the protocol team has something to grant: an `access` fix, or a trustline the issuer needs first. */
export function needsAccessRequest(items: readonly ComplianceItem[]): boolean {
  return items.some((i) => i.fix === "access" || (i.id === "trustline" && i.status === "missing"))
}

/**
 * Where nothing can be granted from the app (Mainnet): the issuer's authorization and the
 * Permissioning grants are done by the protocol team on request. Shows what to send them (the
 * connected address), what is still missing for this market, and how to reach them (the manifest's
 * `accessContact`). It reads nothing from the chain: the items are the compliance card's.
 */
export function AccessRequest({ address, items }: { address: string; items: readonly ComplianceItem[] }) {
  const contact = useManifest().accessContact
  if (!needsAccessRequest(items)) return null
  const missing = items.filter((i) => i.status !== "ok")
  const trustlineMissing = items.some((i) => i.id === "trustline" && i.status === "missing")
  const newTab = contact ? /^https:/i.test(contact.url) : false

  return (
    <section aria-label="Request access" className="grid gap-3 rounded-lg border border-line p-3">
      <h4 className="font-semibold">Request access</h4>
      <div className="grid gap-1">
        <p className="label">Your address</p>
        <div className="flex flex-wrap items-start gap-2">
          <code className="min-w-0 flex-1 basis-56 font-mono text-xs/5 break-all">{address}</code>
          <Button type="button" variant="secondary" size="toggle" onClick={() => copyAddress(address)}>
            <ClipboardCopy aria-hidden="true" className="size-3.5" />
            Copy address
          </Button>
        </div>
      </div>
      <div className="grid gap-1">
        <p>Still missing for this market:</p>
        <ul className="grid list-disc gap-0.5 pl-5">
          {missing.map((i) => (
            <li key={i.id}>{capitalize(COMPLIANCE_ITEM_LABEL[i.id])}</li>
          ))}
        </ul>
      </div>
      {trustlineMissing ? <p>Add the trustline first: the issuer cannot authorize an account without one.</p> : null}
      {contact ? (
        <p className="wrap-anywhere">
          Send your address to{" "}
          <a
            href={contact.url}
            target={newTab ? "_blank" : undefined}
            rel="noopener noreferrer"
            className="text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {contact.label}
          </a>
          .
        </p>
      ) : (
        <p>Ask the protocol team.</p>
      )}
    </section>
  )
}
