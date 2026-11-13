/**
 * The live suites' RPC access (plan 0007): the SDK's server and the app's contract reader, with
 * every read and simulation asked again while the RPC is overloaded or unreachable for a moment
 * (`retryTransient`: JSON-RPC -32004 "preflight queue full; retry later", HTTP 429/502/503/504,
 * resets and timeouts), and logged. An answer, a contract error among them, is never retried.
 *
 * `sendTransaction` is passed through untouched: a submission is retried only at the step level,
 * once, and only when the signer's sequence number shows nothing of it landed (`retryOnce`).
 * `submitAndPoll` sends a signed transaction once and, as the app's `signAndSubmit` does, polls its
 * hash even when the RPC did not answer the send.
 *
 * No server code here (`pnpm test` loads `tests/live/`), and nothing printed escapes `redact`.
 */
import { errorMessage } from "@/lib/protocol/errors"
import type { ContractReader } from "@/lib/protocol/reader"
import {
  createRpcServer,
  pollTransactionStatus,
  simulateContractRead,
  submitSignedTransaction,
  transactionEnvelopeHash,
  type PolledTransactionResult,
} from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import { isTransientRpcError, retryTransient } from "./retry"
import { redact } from "./util"

type Log = (line: string) => void
/** The retry's clock and budget; the defaults outside unit tests. */
type RetryClock = { wait?: (ms: number) => Promise<unknown>; now?: () => number; budgetMs?: number }

/** Where a retry is logged when the caller gives no suite log. */
export const liveLog: Log = (line) => console.info(`[live] ${redact(line)}`)

/**
 * The RPC methods that only read or simulate, and so may be asked again. `prepareTransaction` is a
 * simulation (nothing is signed or sent). `sendTransaction` is not here, on purpose.
 */
export const RETRIED_RPC_METHODS: ReadonlySet<string> = new Set([
  "getAccount",
  "getEvents",
  "getHealth",
  "getLatestLedger",
  "getLedgerEntries",
  "getNetwork",
  "getTransaction",
  "getTransactions",
  "prepareTransaction",
  "simulateTransaction",
])

/**
 * `server`, with each method of `RETRIED_RPC_METHODS` run through `retryTransient`. A method runs
 * on the unwrapped server, so one that calls another (`prepareTransaction` simulates) is retried
 * once, as a whole, never inside itself. Every other method is the server's own.
 */
export function withTransientRetry<S extends object>(server: S, p: RetryClock & { log?: Log } = {}): S {
  return new Proxy(server, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target)
      if (typeof value !== "function") return value
      const method = value as (...args: unknown[]) => unknown
      if (typeof prop !== "string" || !RETRIED_RPC_METHODS.has(prop)) return method.bind(target)
      return (...args: unknown[]) => retryTransient({ ...p, what: `RPC ${prop}`, log: p.log ?? liveLog, run: async () => method.apply(target, args) })
    },
  })
}

/** The SDK's RPC server for `rpcUrl` (`createRpcServer`), its reads and simulations retried while the RPC is overloaded. */
export function liveRpcServer(rpcUrl: string, log: Log = liveLog) {
  return withTransientRetry(createRpcServer(rpcUrl), { log })
}

/**
 * The app's contract reader (`createRpcReader`: one simulation per read), each read retried while
 * the RPC is overloaded, and named in the log and in the error once the retries are spent.
 */
export function liveReader(m: Pick<Manifest, "rpcUrl" | "networkPassphrase">, log: Log = liveLog, clock: RetryClock = {}): ContractReader {
  const server = createRpcServer(m.rpcUrl)
  return <T>(call: Parameters<ContractReader>[0]) =>
    retryTransient({
      ...clock,
      what: `read ${call.functionName}`,
      log,
      run: () =>
        simulateContractRead<T>({
          rpcUrl: m.rpcUrl,
          networkPassphrase: m.networkPassphrase,
          server,
          invocation: { contractId: call.contractId, functionName: call.functionName, args: call.args ?? [] },
        }),
    })
}

/**
 * `signedXdr` sent once, then its hash polled (30 times, 2 s apart, each poll retried while the RPC
 * is overloaded). A send the RPC did not answer (a transient failure) may still have reached the
 * network, so, as the app's `signAndSubmit` does, its hash is polled before anything is concluded;
 * it is never sent again here. When the network does not show it, the send's failure is thrown,
 * named: a caller's step may then run once more, if the signer's sequence number shows nothing
 * landed. TRY_AGAIN_LATER (nothing was taken) is thrown at once.
 */
export async function submitAndPoll(p: {
  rpcUrl: string
  networkPassphrase: string
  signedXdr: string
  what: string
  log?: Log
  /** Unit tests only: the server to send and poll through, and the poll's interval. */
  server?: Parameters<typeof submitSignedTransaction>[0]["server"] & Parameters<typeof pollTransactionStatus>[0]["server"]
  intervalMs?: number
}): Promise<PolledTransactionResult> {
  const log = p.log ?? liveLog
  const hash = transactionEnvelopeHash(p.signedXdr, p.networkPassphrase)
  let status: string | undefined
  let unanswered: unknown
  try {
    // Never through `liveRpcServer`: the submission is not repeated.
    ;({ status } = await submitSignedTransaction({ rpcUrl: p.rpcUrl, networkPassphrase: p.networkPassphrase, signedXdr: p.signedXdr, server: p.server }))
  } catch (error) {
    if (!isTransientRpcError(error)) throw error
    unanswered = error
    log(`${p.what} ${hash}: the RPC did not answer the submission (${errorMessage(error)}); its hash is polled before anything else`)
  }
  if (status === "TRY_AGAIN_LATER") throw new Error(`${p.what} ${hash}: TRY_AGAIN_LATER, the network is busy and did not accept it`)
  const polled = await pollTransactionStatus({ rpcUrl: p.rpcUrl, hash, attempts: 30, intervalMs: p.intervalMs ?? 2_000, server: p.server ?? liveRpcServer(p.rpcUrl, log) })
  if (polled.status === "NOT_FOUND" && unanswered !== undefined) {
    throw new Error(`${p.what} ${hash}: the RPC did not answer the submission (${errorMessage(unanswered)}), and the network does not show it`, { cause: unanswered })
  }
  return polled
}
