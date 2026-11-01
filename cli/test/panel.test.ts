import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PanelError, renderPanelTree, runPanel, selectSurface, type AxNode, type PanelSurface } from "../src/panel.ts"

const temps: string[] = []
afterAll(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const surface = (overrides: Partial<PanelSurface> = {}): PanelSurface => ({
  pid: 1,
  app: "Google Chrome",
  bundleId: "com.google.Chrome",
  window: 7,
  windowTitle: "Dapp - Google Chrome - Safzan",
  url: "chrome-extension://abc/sidepanel.html#/home",
  title: "MetaMask",
  kind: "side-panel",
  ...overrides,
})

const wallet: AxNode = {
  role: "AXWebArea",
  name: "MetaMask",
  children: [
    { role: "AXGroup", name: "", children: [{ role: "AXHeading", name: "Send", value: "2", children: [{ role: "AXStaticText", name: "Send" }] }] },
    { role: "AXTextField", name: "Amount", value: "311", placeholder: "0", settable: true, actions: ["AXPress"] },
    { role: "AXTextField", name: "Password", subrole: "AXSecureTextField", settable: true },
    {
      role: "AXGroup",
      name: "",
      actions: ["AXPress", "AXShowMenu"],
      children: [{ role: "AXImage", name: "USDC logo" }, { role: "AXStaticText", name: "USDC" }, { role: "AXStaticText", name: "$312.27" }],
    },
    { role: "AXButton", name: "Continue", disabled: true, actions: ["AXPress"] },
  ],
}

describe("renderPanelTree", () => {
  test("folds nameless wrappers and repeated labels, and gives every pressable or editable element a ref with its live path", () => {
    const { lines, refs } = renderPanelTree(wallet)
    expect(lines).toEqual([
      '- heading "Send" [level=2]',
      '- textbox "Amount" [ref=e1 filled placeholder="0"]',
      '- password "Password" [ref=e2]',
      '- group "USDC logo · USDC · $312.27" [ref=e3]',
      '- button "Continue" [ref=e4 disabled]',
    ])
    expect(refs.e3).toEqual({ path: [3], role: "AXGroup", name: "" })
    expect(refs.e4).toEqual({ path: [4], role: "AXButton", name: "Continue" })
  })

  test("shows text field values only when asked", () => {
    expect(renderPanelTree(wallet, { showValues: true }).lines[1]).toBe('- textbox "Amount" [ref=e1 value="311" placeholder="0"]')
  })

  test("keeps the children of a clickable row that holds other controls", () => {
    const row: AxNode = {
      role: "AXWebArea",
      name: "",
      children: [{ role: "AXGroup", name: "", actions: ["AXPress"], children: [{ role: "AXButton", name: "Copy", actions: ["AXPress"] }] }],
    }
    const { lines, refs } = renderPanelTree(row)
    expect(lines).toEqual(["- group [ref=e1]", '  - button "Copy" [ref=e2]'])
    expect(refs.e2!.path).toEqual([0, 0])
  })
})

describe("selectSurface", () => {
  const tab = surface({ kind: "tab", title: "MetaMask", url: "chrome-extension://abc/home.html" })
  test("picks the only side panel when several extension pages are open", () => {
    expect(selectSurface([tab, surface()], undefined).kind).toBe("side-panel")
  })
  test("refuses to guess between two side panels and names them", () => {
    const other = surface({ window: 8, windowTitle: "Docs - Google Chrome - Work" })
    expect(() => selectSurface([surface(), other], undefined)).toThrow(/Several extension UIs.*\n[\s\S]*Work/)
    expect(selectSurface([surface(), other], "work").window).toBe(8)
  })
})

describe("runPanel", () => {
  const root = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browse-panel-"))
    temps.push(dir)
    return dir
  }

  test("acts on the element the last snapshot named, and passes a filled value on stdin, never in argv", async () => {
    const dir = root()
    const calls: { args: string[]; input: string | undefined }[] = []
    const run = (args: string[], input?: string) => {
      calls.push({ args, input })
      if (args[0] === "surfaces") return { surfaces: [surface()] }
      if (args[0] === "tree") return { url: "chrome-extension://abc/sidepanel.html#/send", root: wallet, truncated: false }
      return { ok: true, valueMatches: true }
    }
    await runPanel(["snapshot"], { root: dir, run })
    await runPanel(["fill", "e2", "--stdin"], { root: dir, run, stdin: () => "0xsecret\n" })
    const act = calls.at(-1)!
    expect(act.args).toEqual([
      "act", "--pid", "1", "--window", "7", "--url", "chrome-extension://abc/sidepanel.html#/home",
      "--path", "2", "--role", "AXTextField", "--name", "Password", "--action", "set-value",
    ])
    expect(act.input).toBe("0xsecret")
    expect(act.args.join(" ")).not.toContain("0xsecret")
  })

  test("refuses a ref before any snapshot of that panel", async () => {
    const run = () => ({ surfaces: [surface()] })
    await expect(runPanel(["click", "e1"], { root: root(), run })).rejects.toBeInstanceOf(PanelError)
  })
})
