// Loads the app's own TypeScript into a Node script (`pnpm indexer:capture`, `pnpm smoke:mainnet`),
// so a script runs the code the app runs instead of a copy of it.
import { existsSync, statSync } from "node:fs"
import { registerHooks } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Thrown when Node runs without its TypeScript transform: a usage error, said as one line. */
export class TypeScriptTransformRequired extends Error {
  constructor() {
    super("this command loads the app's TypeScript: run it with its pnpm script, which passes node --experimental-transform-types")
    this.name = "TypeScriptTransformRequired"
  }
}

/**
 * Lets Node load the app's TypeScript as Next and Vitest do: the `@/` alias (to `root`, the app's
 * directory), extensionless relative imports, and `server-only` under the `react-server` condition
 * (an empty module there). Returns `load(path)`, which imports a file by its path from `root`.
 * Call it once per process: the hook stays registered.
 */
export function loadAppTypeScript(root) {
  if (process.features?.typescript !== "transform") throw new TypeScriptTransformRequired()
  const EXTENSIONS = [".ts", ".tsx", "/index.ts"]
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return next(specifier, { ...context, conditions: [...(context.conditions ?? []), "react-server"] })
      let spec = specifier
      if (spec.startsWith("@/")) spec = pathToFileURL(join(root, spec.slice(2))).href
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null
      const appRelative = (spec.startsWith("./") || spec.startsWith("../")) && parent !== null && !parent.includes("/node_modules/")
      if (spec.startsWith("file:") || appRelative) {
        const base = spec.startsWith("file:") ? fileURLToPath(spec) : join(dirname(parent), spec)
        if (!(existsSync(base) && statSync(base).isFile())) {
          for (const ext of EXTENSIONS) if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context)
        }
      }
      return next(spec, context)
    },
  })
  return (path) => import(pathToFileURL(join(root, path)).href)
}
