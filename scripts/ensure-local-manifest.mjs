import { copyFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "manifests")
const target = join(dir, "local.json")
if (!existsSync(target)) copyFileSync(join(dir, "local.example.json"), target)
