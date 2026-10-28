import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as AuthProfile from "../src/auth-profile.ts"

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-auth-run-"))
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "browse-auth-cwd-")))
// A caller on another host sends its own directory, which the relay host does not have.
const remoteCwd = path.join(baseDir, "caller-host-only")

afterAll(() => {
  fs.rmSync(baseDir, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
})

const run = (options: Partial<AuthProfile.AuthRunOptions>) =>
  Effect.runPromise(Effect.gen(function* () {
    yield* AuthProfile.write({ name: "p", baseDir, slots: [{ ref: "BC_SECRET_1", value: "secret-value-123", sources: ["s"] }] })
    return yield* AuthProfile.run({ name: "p", baseDir, command: "/bin/sh", args: ["-c", "pwd"], ...options })
  }))

describe("AuthProfile.run working directory", () => {
  test("runs in the requested directory when it exists", async () => {
    const result = await run({ cwd: workDir, cwdFallback: true })
    expect(result.stdout.trim()).toBe(workDir)
  })

  test("falls back to the relay's directory when the caller's implicit directory is missing", async () => {
    const result = await run({ cwd: remoteCwd, cwdFallback: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(fs.realpathSync(process.cwd()))
  })

  test("refuses a missing explicit directory and names it", async () => {
    await expect(run({ cwd: remoteCwd })).rejects.toThrow(`Working directory does not exist on the relay host: ${remoteCwd}`)
  })
})

test("secrets run output redacts a short credential but leaves a one-character index", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    yield* AuthProfile.write({
      name: "short",
      baseDir,
      slots: [
        { ref: "BC_SECRET_1", value: "p4ss!", sources: ["password"] },
        { ref: "BC_SECRET_2", value: "0", sources: ["authuser"] },
      ],
    })
    return yield* AuthProfile.run({ name: "short", baseDir, command: "/bin/sh", args: ["-c", 'echo "$BC_SECRET_1 page 0"'] })
  }))
  expect(result.stdout.trim()).toBe("${BC_SECRET_1} page 0")
})
