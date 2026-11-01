import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    // One live file at a time: the routes suite signs on the shared local market and ticks its
    // oracle, so the suites reading it (curve, recorder, registry) see a quiet pool, and the state it
    // logs before and after is its own.
    fileParallelism: false,
    // The live run is evidence (hashes, simulated vs decoded): print every test's output, passing ones too.
    reporters: ["verbose"],
  },
})
