import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // The live suites sign real transactions: their own configs run them (test:integration, test:e2e:testnet).
    exclude: ["**/node_modules/**", "**/.next/**", "tests/integration/**", "tests/e2e-testnet/**"],
  },
})
