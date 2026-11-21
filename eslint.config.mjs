import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The scripts are plain JavaScript that no type check reads: an undefined name only fails at run
  // time (a smoke run once failed on a helper used outside the scope that loaded it).
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "process", "console", "URL", "URLSearchParams", "fetch", "Request", "Response", "Headers",
          "AbortSignal", "AbortController", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
          "setImmediate", "queueMicrotask", "structuredClone", "performance", "Buffer", "TextEncoder",
          "TextDecoder", "globalThis", "crypto",
        ].map((name) => [name, "readonly"]),
      ),
    },
    rules: { "no-undef": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Tooling-owned (rness sync), not project source:
    ".claude/**",
  ]),
]);

export default eslintConfig;
