// Builds the extension (both vite passes) into a staging directory under the OS temp directory, then swaps the
// result into dist/ file by file. Chrome loads dist/ unpacked and unloads the extension when its manifest or service
// worker disappears, so dist/ is never emptied: a failed build leaves the previous output untouched, and a
// successful one writes every new file before it removes the stale ones (old content-hashed assets).
// Concurrent builds each run vite on their own, then publish one at a time under a lock beside dist/, so one build's
// prune never deletes the assets another build's background.js has just started loading.
import { $ } from "bun"
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Replaces `destination`'s contents with `source`'s while holding the publish lock beside it. */
export async function publish(source: string, destination: string): Promise<void> {
  const lock = `${destination}.lock`
  await acquire(lock)
  try {
    await mkdir(destination, { recursive: true })
    await copyInto(source, destination)
    await prune(source, destination)
  } finally {
    await release(lock)
  }
}

/**
 * Takes the lock: a directory holding the owner's pid, created complete under a private name and renamed into place
 * (a rename onto an existing, non-empty directory fails). A lock whose owner is gone is cleared and retaken.
 */
async function acquire(lock: string): Promise<void> {
  const candidate = `${lock}.${process.pid}`
  await rm(candidate, { recursive: true, force: true })
  await mkdir(candidate)
  await writeFile(path.join(candidate, "pid"), `${process.pid}\n`)
  try {
    for (let misses = 0; ; await Bun.sleep(50)) {
      // The lock's age tells a held lock from one whose dead owner's pid now names an unrelated process, so it starts
      // fresh however long this build waited.
      const now = new Date()
      await utimes(candidate, now, now)
      try {
        await rename(candidate, lock)
        return
      } catch (error) {
        // Windows reports a rename onto an existing directory as EPERM.
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        const owner = await lockOwner(lock)
        // No lock there, yet the rename keeps failing: the error is not about the lock.
        if (owner === undefined && ++misses > 100) throw error
        // Stale: its owner is gone, or its pid was reused (by this process, or anyone once it is too old to be held).
        if (owner !== undefined && (owner === process.pid || !alive(owner) || (await lockAge(lock)) > staleAfterMs))
          await clearStale(lock, owner)
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true })
  }
}

/** Moves the lock aside before deleting it, so the path never holds a half-removed (empty) lock directory. */
async function release(lock: string): Promise<void> {
  const trash = `${lock}.${process.pid}.released`
  try {
    await rename(lock, trash)
  } catch (error) {
    // Already cleared as stale by another build.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  await rm(trash, { recursive: true, force: true })
}

/** Publishing takes well under a second; a lock held this long belongs to no running build. */
const staleAfterMs = 60_000

async function lockAge(lock: string): Promise<number> {
  const stats = await lstat(lock).catch(() => undefined)
  return stats ? Date.now() - stats.mtimeMs : 0
}

/** Clears a dead owner's lock; puts it back if, in between, someone live had taken it. */
async function clearStale(lock: string, owner: number): Promise<void> {
  const trash = `${lock}.${process.pid}.stale`
  try {
    await rename(lock, trash)
  } catch {
    return
  }
  const moved = await lockOwner(trash)
  if (moved !== owner && moved !== undefined && alive(moved) && (await lockAge(trash)) <= staleAfterMs)
    await rename(trash, lock).catch(() => undefined)
  await rm(trash, { recursive: true, force: true })
}

/** The lock's owner pid; undefined when the lock is gone, and NaN (never alive) when it has no readable pid. */
async function lockOwner(lock: string): Promise<number | undefined> {
  try {
    return Number.parseInt(await readFile(path.join(lock, "pid"), "utf8"), 10)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return (await lstat(lock).catch(() => undefined)) ? Number.NaN : undefined
  }
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const temporaryName = (name: string, pid: number) => `.${name}.${pid}.tmp`
const temporaryPattern = /^\..+\.(\d+)\.tmp$/

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
    const temporary = path.join(destination, temporaryName(entry.name, process.pid))
    await copyFile(from, temporary)
    await rename(temporary, to)
  }
}

/**
 * Removes what the staged build no longer has, once every new file is in place. A temporary file whose writer is
 * still running stays; one left by a build that died goes.
 */
async function prune(source: string, destination: string): Promise<void> {
  const staged = new Map((await readdir(source, { withFileTypes: true })).map((entry) => [entry.name, entry]))
  for (const name of await readdir(destination)) {
    const entry = staged.get(name)
    if (entry?.isDirectory()) await prune(path.join(source, name), path.join(destination, name))
    if (entry) continue
    const writer = temporaryPattern.exec(name)?.[1]
    if (writer !== undefined && alive(Number(writer))) continue
    await rm(path.join(destination, name), { recursive: true, force: true })
  }
}

const root = path.resolve(import.meta.dir, "..")
const dist = path.join(root, "dist")

// Last, so every declaration above is initialized before the top-level await runs.
if (import.meta.main) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "browse-extension-build-"))
  let status = 0
  try {
    // The main build, then the content script (a classic script, built on its own). Run through `bun run build`,
    // which puts node_modules/.bin (and so vite) on the PATH. Vite prints its own errors.
    for (const config of [[], ["-c", "vite.content.config.ts"]]) {
      status = (await $`vite build ${config} --outDir ${staging}`.cwd(root).nothrow()).exitCode
      if (status !== 0) break
    }
    if (status === 0) await publish(staging, dist)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  if (status !== 0) console.error("Extension build failed; dist/ was left as it was.")
  process.exitCode = status
}
