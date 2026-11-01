// `opencode-browser panel …`: read and drive extension UI that chrome.debugger can't reach (a wallet's side panel, an
// extension popup, an extension page in a tab) through the macOS accessibility API.
//
// Chromium refuses to attach chrome.debugger to another extension's pages, so the relay can never expose them. The
// accessibility tree has no such boundary: the native helper (native/macos/browse-ax.swift, compiled on first use and
// cached in the data root) lists the extension web areas of every Chromium window, dumps one, and presses or sets the
// value of one element by its child-index path. This module turns the dump into a compact outline with refs, keeps the
// refs of the last snapshot per panel, and checks that a ref still names the same element before acting on it.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { cliCommand, dataRoot } from "./paths.ts"

export type PanelSurface = {
  pid: number
  app: string
  bundleId: string
  window: number
  windowTitle: string
  url: string
  title: string
  kind: "side-panel" | "popup" | "tab"
  frame?: { x: number; y: number; width: number; height: number }
}

export type AxNode = {
  role: string
  name: string
  subrole?: string
  value?: string
  placeholder?: string
  disabled?: boolean
  focused?: boolean
  selected?: boolean
  expanded?: boolean
  actions?: string[]
  settable?: boolean
  children?: AxNode[]
}

/** What a ref points at: the child-index path from the panel's root, and the role and name it had. */
export type PanelRef = { path: number[]; role: string; name: string }

export type PanelSnapshot = { lines: string[]; refs: Record<string, PanelRef> }

export class PanelError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const actionable: Record<string, true> = { AXPress: true, AXIncrement: true, AXDecrement: true, AXConfirm: true, AXPick: true }
const containerRoles: Record<string, true> = {
  AXGroup: true, AXGenericElement: true, AXUnknown: true, AXSection: true, AXLayoutArea: true, AXScrollArea: true, AXSplitGroup: true,
}
const textRoles: Record<string, true> = { AXTextField: true, AXTextArea: true, AXComboBox: true, AXSearchField: true }
const roleNames: Record<string, string> = {
  AXStaticText: "text",
  AXTextField: "textbox",
  AXTextArea: "textbox",
  AXSearchField: "searchbox",
  AXComboBox: "combobox",
  AXPopUpButton: "combobox",
  AXCheckBox: "checkbox",
  AXRadioButton: "radio",
  AXImage: "img",
  AXMenuButton: "button",
  AXDisclosureTriangle: "button",
  AXWebArea: "document",
}
const maxName = 160

const roleName = (node: AxNode) =>
  node.subrole === "AXSecureTextField" ? "password" : roleNames[node.role] ?? node.role.replace(/^AX/, "").toLowerCase()
const isActionable = (node: AxNode) => node.settable === true || (node.actions ?? []).some((action) => actionable[action])
const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > maxName ? `${flat.slice(0, maxName)}…` : flat
}

/** The visible text under a node (for a nameless clickable row such as a wallet's asset entry). */
function descendantText(node: AxNode): string {
  const parts: string[] = []
  const visit = (current: AxNode) => {
    if (current.role === "AXStaticText" && current.name) parts.push(current.name)
    else if (current.name && current.role !== "AXGroup") parts.push(current.name)
    else for (const child of current.children ?? []) visit(child)
  }
  for (const child of node.children ?? []) visit(child)
  return parts.join(" · ")
}

const hasActionableDescendant = (node: AxNode): boolean =>
  (node.children ?? []).some((child) => isActionable(child) || hasActionableDescendant(child))

function details(node: AxNode, showValues: boolean): string[] {
  const out: string[] = []
  if (node.role === "AXHeading" && node.value) out.push(`level=${node.value}`)
  else if ((node.role === "AXCheckBox" || node.role === "AXRadioButton") && node.value !== undefined) {
    out.push(node.value === "1" ? "checked" : node.value === "2" ? "mixed" : "unchecked")
  } else if (textRoles[node.role]) {
    if (node.value) out.push(showValues ? `value=${JSON.stringify(clip(node.value))}` : "filled")
    if (node.placeholder) out.push(`placeholder=${JSON.stringify(clip(node.placeholder))}`)
  } else if (node.value && node.role !== "AXStaticText" && node.subrole !== "AXSecureTextField") {
    out.push(`value=${JSON.stringify(clip(node.value))}`)
  }
  if (node.disabled) out.push("disabled")
  if (node.focused) out.push("focused")
  if (node.selected) out.push("selected")
  // Chromium reports AXExpanded=false on every element, so only an open one is worth a word.
  if (node.expanded) out.push("expanded")
  return out
}

/**
 * The compact outline of a panel's tree: one line per meaningful node, nameless wrappers folded away, a label's text
 * not repeated under it, and `ref=eN` on every element that can be pressed or edited. Text field values are hidden
 * (shown as `filled`) unless `showValues`; a password field's value never reaches this process.
 */
export function renderPanelTree(root: AxNode, options: { showValues?: boolean } = {}): PanelSnapshot {
  const lines: string[] = []
  const refs: Record<string, PanelRef> = {}
  let next = 1
  const visit = (node: AxNode, nodePath: number[], depth: number, parentName: string) => {
    const canAct = isActionable(node)
    const indent = "  ".repeat(depth)
    if (!canAct && containerRoles[node.role] && !node.name) {
      node.children?.forEach((child, index) => visit(child, [...nodePath, index], depth, parentName))
      return
    }
    if (!canAct && node.role === "AXStaticText" && (!node.name || clip(node.name) === clip(parentName))) return
    if (!canAct && node.role === "AXImage" && !node.name) return
    let ref: string | undefined
    if (canAct) {
      ref = `e${next++}`
      refs[ref] = { path: nodePath, role: node.role, name: node.name }
    }
    // A nameless clickable row shows the text inside it; when nothing else inside is clickable, that one line is all.
    const folded = canAct && !node.name && !hasActionableDescendant(node)
    const label = node.name || (canAct ? descendantText(node) : "")
    const suffix = [ref ? `ref=${ref}` : undefined, ...details(node, options.showValues === true)].filter(Boolean).join(" ")
    lines.push(`${indent}- ${roleName(node)}${label ? ` ${JSON.stringify(clip(label))}` : ""}${suffix ? ` [${suffix}]` : ""}`)
    if (folded) return
    node.children?.forEach((child, index) => visit(child, [...nodePath, index], depth + 1, node.name))
  }
  root.children?.forEach((child, index) => visit(child, [index], 0, root.name))
  return { lines, refs }
}

const documentKey = (url: string) => url.split("#", 1)[0]!

const noPanels =
  "No extension UI is open in a Chromium window. Open the extension's side panel or popup first. If it is open, the " +
  "browser may not have built its accessibility tree yet: click into the browser window once and retry."

/** `--panel` text matches a panel's title, URL, extension id or window title (case-insensitive). */
export function selectSurface(surfaces: readonly PanelSurface[], selector: string | undefined): PanelSurface {
  const needle = selector?.toLowerCase()
  const matches = needle
    ? surfaces.filter((surface) => [surface.title, surface.url, surface.windowTitle].some((field) => field.toLowerCase().includes(needle)))
    : surfaces
  if (matches.length === 1) return matches[0]!
  const panels = matches.filter((surface) => surface.kind === "side-panel")
  if (panels.length === 1) return panels[0]!
  if (matches.length === 0) {
    throw new PanelError(
      "NO_PANEL",
      surfaces.length === 0
        ? noPanels
        : `No open extension UI matches "${selector}". Open ones:\n${formatSurfaces(surfaces)}`,
    )
  }
  throw new PanelError("AMBIGUOUS_PANEL", `Several extension UIs are open; pick one with --panel <title, URL or window>:\n${formatSurfaces(matches)}`)
}

export function formatSurfaces(surfaces: readonly PanelSurface[]): string {
  return surfaces
    .map((surface) => `  ${surface.kind.padEnd(10)} ${JSON.stringify(surface.title || "(untitled)")} ${surface.url}\n             in ${surface.app} window ${JSON.stringify(surface.windowTitle)}`)
    .join("\n")
}

// --- the native helper -------------------------------------------------------------------------------------------

const helperSource = () => path.join(path.dirname(import.meta.dirname), "native", "macos", "browse-ax.swift")

/** The compiled helper, built from the shipped source on first use and cached by the source's hash. */
export function helperBinary(root = dataRoot()): string {
  if (process.platform !== "darwin") {
    throw new PanelError("UNSUPPORTED", "browse panel reads extension UI through the macOS accessibility API; it works on macOS only.")
  }
  const source = helperSource()
  const hash = createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 16)
  const binary = path.join(root, "native", `browse-ax-${hash}`)
  if (fs.existsSync(binary)) return binary
  fs.mkdirSync(path.dirname(binary), { recursive: true, mode: 0o700 })
  const staging = `${binary}.${process.pid}.tmp`
  const built = spawnSync("xcrun", ["swiftc", "-O", "-o", staging, source], { encoding: "utf8" })
  if (built.error || built.status !== 0) {
    fs.rmSync(staging, { force: true })
    throw new PanelError(
      "HELPER_BUILD_FAILED",
      `Building the accessibility helper failed; it needs the Xcode Command Line Tools (xcode-select --install).\n${(built.stderr || built.error?.message || "").trim()}`,
    )
  }
  fs.renameSync(staging, binary)
  for (const old of fs.readdirSync(path.dirname(binary))) {
    if (old.startsWith("browse-ax-") && old !== path.basename(binary)) fs.rmSync(path.join(path.dirname(binary), old), { force: true })
  }
  return binary
}

type HelperRunner = (args: string[], input?: string) => unknown

const runHelper: HelperRunner = (args, input) => {
  const result = spawnSync(helperBinary(), args, { encoding: "utf8", input: input ?? "", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw new PanelError("HELPER_FAILED", `The accessibility helper failed: ${result.error.message}`)
  let parsed: { error?: { code: string; message: string } } & Record<string, unknown>
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new PanelError("HELPER_FAILED", `The accessibility helper printed no result (exit ${result.status}). ${result.stderr.trim()}`)
  }
  if (parsed.error) throw new PanelError(parsed.error.code, parsed.error.message)
  return parsed
}

const surfaceArgs = (surface: PanelSurface) => ["--pid", String(surface.pid), "--window", String(surface.window), "--url", surface.url]

export function listSurfaces(run: HelperRunner = runHelper): PanelSurface[] {
  return (run(["surfaces"]) as { surfaces: PanelSurface[] }).surfaces
}

export function readTree(surface: PanelSurface, run: HelperRunner = runHelper): { url: string; root: AxNode; truncated: boolean } {
  return run(["tree", ...surfaceArgs(surface)]) as { url: string; root: AxNode; truncated: boolean }
}

// --- refs of the last snapshot, per panel ------------------------------------------------------------------------

type StoredRefs = { surface: PanelSurface; refs: Record<string, PanelRef> }

const refsFile = (surface: PanelSurface, root: string) =>
  path.join(root, "panels", `${createHash("sha256").update(`${surface.pid}:${surface.window}:${documentKey(surface.url)}`).digest("hex").slice(0, 16)}.json`)

function saveRefs(surface: PanelSurface, refs: Record<string, PanelRef>, root: string) {
  const file = refsFile(surface, root)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const staging = `${file}.${process.pid}.tmp`
  fs.writeFileSync(staging, JSON.stringify({ surface, refs } satisfies StoredRefs), { mode: 0o600 })
  fs.renameSync(staging, file)
}

function loadRef(surface: PanelSurface, ref: string, root: string): PanelRef {
  let stored: StoredRefs
  try {
    stored = JSON.parse(fs.readFileSync(refsFile(surface, root), "utf8"))
  } catch {
    throw new PanelError("NO_SNAPSHOT", `No snapshot of this panel yet; run \`${cliCommand("panel snapshot")}\` first.`)
  }
  const found = stored.refs[ref]
  if (!found) throw new PanelError("UNKNOWN_REF", `The last snapshot of this panel has no ${ref}; take a new snapshot.`)
  return found
}

// --- the command -------------------------------------------------------------------------------------------------

const USAGE = `Usage:
  panel list [--json]                          Extension side panels, popups and pages open in Chromium windows
  panel snapshot [--panel <text>] [--find <regex>] [--values] [--json]
                                               The panel's outline with refs (text field values hidden unless --values)
  panel click <ref> [--panel <text>] [--snapshot]
  panel fill <ref> (<value> | --stdin) [--panel <text>] [--snapshot]
                                               Set a text field's value (--stdin keeps it out of argv and the transcript)
  panel focus <ref> [--panel <text>]
  panel wait <regex> [--gone] [--timeout-ms <ms>] [--panel <text>]
                                               Wait until the panel's text matches (or, with --gone, stops matching)
macOS only: reads the browser through the accessibility API, so the app running browse needs Accessibility access.
--panel matches a panel's title, URL or window title; without it, browse picks the only open side panel.`

type Parsed = { positionals: string[]; flags: Map<string, string | true> }

const valued: Record<string, true> = { "--panel": true, "--find": true, "--timeout-ms": true }
const booleans: Record<string, true> = { "--json": true, "--values": true, "--stdin": true, "--snapshot": true, "--gone": true }

function parse(args: readonly string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
    if (valued[name]) {
      const value = inline ?? args[++index]
      if (value === undefined) throw new PanelError("BAD_ARGS", `${name} needs a value\n${USAGE}`)
      flags.set(name, value)
    } else if (booleans[name]) flags.set(name, true)
    else if (arg.startsWith("--") && arg.length > 2) throw new PanelError("BAD_ARGS", `Unknown flag ${arg}\n${USAGE}`)
    else positionals.push(arg)
  }
  return { positionals, flags }
}

const text = (flags: Parsed["flags"], name: string) => {
  const value = flags.get(name)
  return typeof value === "string" ? value : undefined
}

function snapshotOf(surface: PanelSurface, showValues: boolean, root: string, run: HelperRunner) {
  const tree = readTree(surface, run)
  const current = { ...surface, url: tree.url }
  const snapshot = renderPanelTree(tree.root, { showValues })
  saveRefs(current, snapshot.refs, root)
  const header = `${surface.kind} ${JSON.stringify(tree.root.name || surface.title)} ${tree.url}`
  return { surface: current, header, snapshot, truncated: tree.truncated }
}

function regex(source: string): RegExp {
  try {
    return new RegExp(source, "i")
  } catch (error) {
    throw new PanelError("BAD_ARGS", `Bad regular expression ${JSON.stringify(source)}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runPanel(args: readonly string[], options: { root?: string; run?: HelperRunner; stdin?: () => string } = {}): Promise<string> {
  const root = options.root ?? dataRoot()
  const run = options.run ?? runHelper
  const [command, ...rest] = args
  const { positionals, flags } = parse(rest)
  const json = flags.has("--json")
  const out = (value: unknown, human: string) => (json ? JSON.stringify(value, null, 2) : human)
  if (command === "list") {
    const surfaces = listSurfaces(run)
    return out({ panels: surfaces }, surfaces.length ? formatSurfaces(surfaces) : noPanels)
  }
  const surface = () => selectSurface(listSurfaces(run), text(flags, "--panel"))
  if (command === "snapshot") {
    const taken = snapshotOf(surface(), flags.has("--values"), root, run)
    const find = text(flags, "--find")
    const lines = find ? taken.snapshot.lines.filter((line) => regex(find).test(line)) : taken.snapshot.lines
    const human = [taken.header, ...lines, ...(taken.truncated ? ["(the panel is larger than the snapshot limit; the rest is cut off)"] : [])].join("\n")
    return out({ panel: taken.surface, lines, refs: Object.keys(taken.snapshot.refs).length, truncated: taken.truncated }, human)
  }
  if (command === "click" || command === "fill" || command === "focus") {
    const ref = positionals[0]
    if (!ref || !/^e\d+$/.test(ref)) throw new PanelError("BAD_ARGS", `${command} needs a ref from the last snapshot, like e3\n${USAGE}`)
    let value: string | undefined
    if (command === "fill") {
      value = flags.has("--stdin") ? (options.stdin ?? (() => fs.readFileSync(0, "utf8")))().replace(/\r?\n$/, "") : positionals[1]
      if (value === undefined) throw new PanelError("BAD_ARGS", `fill needs a value or --stdin\n${USAGE}`)
    }
    const target = surface()
    const stored = loadRef(target, ref, root)
    const action = command === "click" ? "press" : command === "fill" ? "set-value" : "focus"
    const result = run(
      ["act", ...surfaceArgs(target), "--path", stored.path.join("."), "--role", stored.role, "--name", stored.name, "--action", action],
      value,
    ) as { valueMatches?: boolean }
    const what = `${roleName({ role: stored.role, name: stored.name })}${stored.name ? ` ${JSON.stringify(clip(stored.name))}` : ""} (${ref})`
    let human =
      command === "click" ? `Clicked ${what}.`
      : command === "focus" ? `Focused ${what}.`
      : result.valueMatches === false ? `Set ${what}, but the field doesn't show that value; the page may have reformatted or rejected it. Check with a snapshot.`
      : `Filled ${what}.`
    let snapshot: string[] | undefined
    if (flags.has("--snapshot")) {
      await sleep(400)
      const taken = snapshotOf(target, flags.has("--values"), root, run)
      snapshot = [taken.header, ...taken.snapshot.lines]
      human = `${human}\n${snapshot.join("\n")}`
    }
    return out({ ok: true, ref, action, valueMatches: result.valueMatches, snapshot }, human)
  }
  if (command === "wait") {
    const pattern = positionals[0]
    if (!pattern) throw new PanelError("BAD_ARGS", `wait needs a regular expression\n${USAGE}`)
    const expression = regex(pattern)
    const gone = flags.has("--gone")
    const timeoutMs = Number(text(flags, "--timeout-ms") ?? 15_000)
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new PanelError("BAD_ARGS", "--timeout-ms needs a number of milliseconds")
    const target = surface()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const taken = snapshotOf(target, false, root, run)
      const matching = taken.snapshot.lines.filter((line) => expression.test(line))
      if (gone ? matching.length === 0 : matching.length > 0) {
        return out({ ok: true, lines: matching }, gone ? `No line matches ${expression} any more.` : matching.join("\n"))
      }
      if (Date.now() >= deadline) {
        throw new PanelError("TIMEOUT", `${gone ? "Still matching" : "Nothing matched"} ${expression} after ${timeoutMs} ms.`)
      }
      await sleep(300)
    }
  }
  throw new PanelError("BAD_ARGS", USAGE)
}

export async function runPanelCommand(args: readonly string[]): Promise<void> {
  try {
    process.stdout.write(`${await runPanel(args)}\n`)
  } catch (error) {
    if (!(error instanceof PanelError)) throw error
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }, null, 2)}\n`)
    else process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
