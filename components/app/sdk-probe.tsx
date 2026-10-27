"use client"

// Temporary bundling proof (deleted in Task 12).
import { StrKey } from "@stellar/stellar-sdk"
import { isConnected } from "@stellar/freighter-api"

const PROBE_CONTRACT = "CARTAP66PCU6GJJ4MGWATZM54YIT4RF7WNTPCA2KHMQD6W23NNU7KC2U"

// Referenced so the bundler must resolve the Freighter module.
export const freighterProbe = isConnected

export function SdkProbe() {
  return <span data-testid="sdk-probe">{String(StrKey.isValidContract(PROBE_CONTRACT))}</span>
}
