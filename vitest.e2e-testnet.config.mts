import { defineConfig } from "vitest/config"

/**
 * The live Testnet suites (plan 0007): `pnpm test:e2e:testnet`. They sign real Testnet transactions
 * with throwaway keypairs, so they never run with `pnpm test` or `pnpm test:integration`.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/e2e-testnet/**/*.test.ts"],
    // A suite that finds nothing to run fails: a live suite never passes empty (Review Focus 3).
    passWithNoTests: false,
    // One suite at a time, one test at a time: the shared Testnet RPC and the faucet are rate-limited,
    // and each suite's steps build on the state the step before it left.
    fileParallelism: false,
    sequence: { concurrent: false },
    // Friendbot, the faucet and the RPC can each take minutes on a busy Testnet.
    testTimeout: 10 * 60_000,
    hookTimeout: 15 * 60_000,
    // The live run is evidence (hashes, simulated vs decoded): print every test's output, passing ones too.
    reporters: ["verbose"],
  },
})
