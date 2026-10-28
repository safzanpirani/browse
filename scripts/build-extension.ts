// Builds the extension (both vite passes) into a staging directory under the OS temp directory, then swaps the
// result into dist/ file by file. Chrome loads dist/ unpacked and unloads the extension when its manifest or service
// worker disappears, so dist/ is never emptied: a failed build leaves the previous output untouched, and a
// successful one writes every new file before it removes the stale ones (old content-hashed assets).
import { $ } from "bun"
import { copyFile, lstat, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const dist = path.join(root, "dist")

const staging = await mkdtemp(path.join(os.tmpdir(), "browse-extension-build-"))
let status = 0
try {
  // The main build, then the content script (a classic script, built on its own). Run through `bun run build`,
  // which puts node_modules/.bin (and so vite) on the PATH. Vite prints its own errors.
  for (const config of [[], ["-c", "vite.content.config.ts"]]) {
    status = (await $`vite build ${config} --outDir ${staging}`.cwd(root).nothrow()).exitCode
    if (status !== 0) break
  }
  if (status === 0) {
    await mkdir(dist, { recursive: true })
    await copyInto(staging, dist)
    await prune(staging, dist)
  }
} finally {
  await rm(staging, { recursive: true, force: true })
}
if (status !== 0) console.error("Extension build failed; dist/ was left as it was.")
process.exitCode = status

/** Writes every staged file over its counterpart in `destination`, each by an atomic rename. */
async function copyInto(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    const existing = await lstat(to).catch(() => undefined)
    if (existing && existing.isDirectory() !== entry.isDirectory()) await rm(to, { recursive: true, force: true })
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      await copyInto(from, to)
      continue
    }
    const temporary = path.join(destination, `.${entry.name}.${process.pid}.tmp`)
    await copyFile(from, temporary)
    await rename(temporary, to)
  }
}

/** Removes what the staged build no longer has, once every new file is in place. */
async function prune(source: string, destination: string): Promise<void> {
  const staged = new Map((await readdir(source, { withFileTypes: true })).map((entry) => [entry.name, entry]))
  for (const name of await readdir(destination)) {
    const entry = staged.get(name)
    if (!entry) await rm(path.join(destination, name), { recursive: true, force: true })
    else if (entry.isDirectory()) await prune(path.join(source, name), path.join(destination, name))
  }
}
