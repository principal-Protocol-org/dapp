import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    passWithNoTests: true,
    // The live run is evidence (hashes, simulated vs decoded): print every test's output, passing ones too.
    reporters: ["verbose"],
  },
})
