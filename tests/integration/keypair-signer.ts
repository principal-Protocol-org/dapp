/**
 * A local keypair standing in for Freighter in the integration suite. `sign` honours the
 * `WalletAdapter.sign` contract (`lib/protocol/wallet.ts`): it signs the exact XDR for the given
 * network as the expected account and returns the signed XDR, or refuses.
 */
import { Keypair, Transaction } from "@stellar/stellar-sdk"
import { fundWithFriendbot } from "@/lib/protocol/onboarding"
import type { SignTransaction } from "@/lib/protocol/review"
import type { Manifest } from "@/lib/protocol/types"

export type KeypairSigner = {
  publicKey: string
  /** `WalletAdapter.sign(xdr, passphrase, expectedSigner)`. */
  sign: SignTransaction
}

export function keypairSigner(keypair: Keypair, networkPassphrase: string): KeypairSigner {
  const publicKey = keypair.publicKey()
  return {
    publicKey,
    async sign(unsignedXdr, passphrase, expectedSigner) {
      // Freighter refuses to sign for another network or account; so does this signer.
      if (passphrase !== networkPassphrase) throw new Error(`signer is on "${networkPassphrase}", asked to sign for "${passphrase}"`)
      if (expectedSigner !== publicKey) throw new Error(`signer holds ${publicKey}, asked to sign as ${expectedSigner}`)
      const tx = new Transaction(unsignedXdr, passphrase)
      tx.sign(keypair)
      return tx.toXdr()
    },
  }
}

/** A fresh random account, funded with XLM by the network's Friendbot (the production helper). */
export async function fundedKeypairSigner(manifest: Manifest): Promise<KeypairSigner> {
  const keypair = Keypair.random()
  await fundWithFriendbot({ manifest, account: keypair.publicKey() })
  return keypairSigner(keypair, manifest.networkPassphrase)
}
