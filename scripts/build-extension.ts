// Builds the extension (both vite passes) into a staging directory under the OS temp directory, then swaps the
// result into dist/ file by file. Chrome loads dist/ unpacked and unloads the extension when its manifest or service
// worker disappears, so dist/ is never emptied: a failed build leaves the previous output untouched, and a
// successful one writes every new file before it removes the stale ones (old content-hashed assets).
// Concurrent builds each run vite on their own, then publish one at a time under a lock beside dist/, so one build's
// prune never deletes the assets another build's background.js has just started loading. A lock is never taken over:
// a build waits while the lock's owner runs, and refuses (leaving dist/ alone) when the owner is gone.
import { $ } from "bun"
import { randomUUID } from "node:crypto"
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** The publish lock is left by a build that is no longer running; only the user may clear it. */
export class StaleLockError extends Error {}

/** Replaces `destination`'s contents with `source`'s while holding the publish lock beside it. */
export async function publish(source: string, destination: string): Promise<void> {
  const lock = `${destination}.lock`
  const owner = `${process.pid} ${randomUUID()}`
  await acquire(lock, owner)
  try {
    await mkdir(destination, { recursive: true })
    await copyInto(source, destination)
    await prune(source, destination)
  } finally {
    await release(lock, owner)
  }
}

/**
 * Takes the lock: a directory holding the owner's pid and a nonce, created complete under a private name and renamed
 * into place. The rename fails onto a non-empty directory; an empty one is never a lock (every lock is created with
 * its owner file and moved aside before it is deleted), so the rename replaces it. Waits while the holder runs;
 * throws StaleLockError when the holder is gone, since only the user can tell that no build is still using it.
 */
async function acquire(lock: string, owner: string): Promise<void> {
  const candidate = `${lock}.${process.pid}`
  await rm(candidate, { recursive: true, force: true })
  await mkdir(candidate)
  await writeFile(path.join(candidate, "owner"), `${owner}\n`)
  try {
    for (let misses = 0; ; await Bun.sleep(50)) {
      try {
        await rename(candidate, lock)
        return
      } catch (error) {
        // Windows reports a rename onto an existing directory as EPERM.
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        const holder = await lockOwner(lock)
        if (holder === undefined) {
          // No lock there, yet the rename keeps failing: the error is not about the lock.
          if (++misses > 100) throw error
          continue
        }
        // The holder's pid naming this process means it was reused after the holder died.
        const pid = Number.parseInt(holder, 10)
        if (pid !== process.pid && alive(pid)) continue
        const why = Number.isInteger(pid) ? `its owner (pid ${pid}) is not running` : "it names no owner"
        throw new StaleLockError(
          `${lock} is held by no running build: ${why}, so a build likely died while publishing into dist/. ` +
            `Check that no extension build is running, delete ${lock}, then build again.`,
        )
      }
    }
  } finally {
    await rm(candidate, { recursive: true, force: true })
  }
}

/**
 * Removes the lock only while it is still this publish's own. It is moved aside before it is deleted, so a waiter
 * never reads a half-removed lock as one with no owner.
 */
async function release(lock: string, owner: string): Promise<void> {
  if ((await lockOwner(lock)) !== owner) return
  const trash = `${lock}.${process.pid}.released`
  await rename(lock, trash)
  await rm(trash, { recursive: true, force: true })
}

/** The lock's owner line; undefined when there is no lock, and "" when the lock has no readable owner. */
async function lockOwner(lock: string): Promise<string | undefined> {
  try {
    return (await readFile(path.join(lock, "owner"), "utf8")).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return (await lstat(lock).catch(() => undefined)) ? "" : undefined
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
    if (status === 0) {
      await publish(staging, dist).catch((error: unknown) => {
        if (!(error instanceof StaleLockError)) throw error
        console.error(error.message)
        status = 1
      })
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  if (status !== 0) console.error("Extension build failed; dist/ was left as it was.")
  process.exitCode = status
}
