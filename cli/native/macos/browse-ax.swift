// browse-ax: reads and drives the browser UI that chrome.debugger cannot reach (extension side panels, extension
// popups and extension pages, such as a wallet's side panel) through the macOS accessibility API.
//
// The relay drives pages through chrome.debugger, and Chromium refuses to attach it to another extension's pages
// ("Cannot access a chrome-extension:// URL of different extension"). The accessibility tree has no such boundary:
// Chromium exposes every web area of a window, side panel included, to an assistive app the user trusts. This helper
// is that app's smallest useful part. It lists extension web areas, dumps one as JSON, and presses or sets the value of
// one element addressed by its child-index path, refusing when the element at that path no longer has the role and
// name the caller saw (a stale ref).
//
// Usage (one JSON object on stdout; errors are {"error":{"code","message"}} with exit status 1):
//   browse-ax trusted
//   browse-ax surfaces [--all]
//   browse-ax tree --pid P --window W --url U [--max-nodes N]
//   browse-ax act --pid P --window W --url U --path 0.3.1 --role R --name N --action press|focus|set-value
//     set-value reads the new value from stdin, so it never appears in a process listing.
//
// Chromium builds the web part of its accessibility tree only for assistive clients; setting AXManualAccessibility on
// the application (what VoiceOver-less tools such as vercel-labs/agent-desktop do) switches it on for that process.
import AppKit
import ApplicationServices
import Foundation

@_silgen_name("_AXUIElementGetWindow")
func axWindowNumber(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

struct Failure: Error {
  let code: String
  let message: String
}

/** Chromium-family browsers whose windows can host extension side panels. */
let chromiumBundles: Set<String> = [
  "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
  "com.google.chrome.for.testing", "org.chromium.Chromium", "com.brave.Browser", "com.brave.Browser.beta",
  "com.brave.Browser.nightly", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev",
  "com.microsoft.edgemac.Canary", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "company.thebrowser.Browser",
  "net.imput.helium", "app.zen-browser.zen", "com.naver.Whale", "ru.yandex.desktop.yandex-browser",
]

let messagingTimeout: Float = 3
let roleWebArea = "AXWebArea"
let settableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider", "AXIncrementor"]
let wantedActions: Set<String> = ["AXPress", "AXShowMenu", "AXIncrement", "AXDecrement", "AXConfirm", "AXPick"]

func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

/** Several attributes in one IPC round trip; a missing attribute comes back nil. */
func copyAttributes(_ element: AXUIElement, _ names: [String]) -> [String: CFTypeRef] {
  var values: CFArray?
  let status = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
  guard status == .success, let array = values as? [CFTypeRef], array.count == names.count else { return [:] }
  var result: [String: CFTypeRef] = [:]
  for (index, value) in array.enumerated() {
    if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { continue }
    result[names[index]] = value
  }
  return result
}

func string(_ value: CFTypeRef?) -> String? {
  guard let value else { return nil }
  let type = CFGetTypeID(value)
  if type == CFStringGetTypeID() { return value as? String }
  if type == CFURLGetTypeID() { return (value as! CFURL as URL).absoluteString }
  if type == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) ? "1" : "0" }
  if type == CFNumberGetTypeID() { return (value as! NSNumber).stringValue }
  if type == CFAttributedStringGetTypeID() { return (value as! NSAttributedString).string }
  return nil
}

func bool(_ value: CFTypeRef?) -> Bool? {
  guard let value else { return nil }
  if CFGetTypeID(value) == CFBooleanGetTypeID() { return CFBooleanGetValue((value as! CFBoolean)) }
  if CFGetTypeID(value) == CFNumberGetTypeID() { return (value as! NSNumber).boolValue }
  return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (copyAttribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func frame(_ element: AXUIElement) -> [String: Double]? {
  let values = copyAttributes(element, [kAXPositionAttribute, kAXSizeAttribute])
  guard let position = values[kAXPositionAttribute], let size = values[kAXSizeAttribute] else { return nil }
  var point = CGPoint.zero
  var extent = CGSize.zero
  guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
  return ["x": point.x, "y": point.y, "width": extent.width, "height": extent.height]
}

/**
 * The name a caller sees and later quotes back as a ref's fingerprint: the title, else the description, else the text
 * of a static text node (Chromium keeps it in AXValue). One rule, here, so the tree and the stale-ref check agree.
 */
func accessibleName(role: String, values: [String: CFTypeRef]) -> String {
  if let title = string(values[kAXTitleAttribute]), !title.isEmpty { return title }
  if let description = string(values[kAXDescriptionAttribute]), !description.isEmpty { return description }
  if role == "AXStaticText", let text = string(values[kAXValueAttribute]) { return text }
  return ""
}

/**
 * The application element, with its web accessibility switched on. Chrome turns native accessibility on when an
 * assistive client reads the application's role; Electron honours AXManualAccessibility; and Chromium builds that
 * refuse both switch the web tree on for AXEnhancedUserInterface, the attribute VoiceOver sets, which is set only when
 * it is off. `activated` says the tree was off until now: Chromium publishes it a moment later.
 */
func application(_ pid: pid_t) -> (element: AXUIElement, activated: Bool) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, messagingTimeout)
  _ = copyAttribute(app, kAXRoleAttribute)
  if bool(copyAttribute(app, "AXManualAccessibility")) == true || bool(copyAttribute(app, "AXEnhancedUserInterface")) == true {
    return (app, false)
  }
  if AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success { return (app, true) }
  // Chrome answers "not implemented" yet applies the change, so the read-back decides.
  AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
  return (app, bool(copyAttribute(app, "AXEnhancedUserInterface")) == true)
}

let activationSettle: useconds_t = 1_500_000

func windows(_ app: AXUIElement) -> [(element: AXUIElement, id: CGWindowID)] {
  let list = (copyAttribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
  return list.compactMap { window in
    var id: CGWindowID = 0
    return axWindowNumber(window, &id) == .success ? (window, id) : nil
  }
}

/**
 * The page web areas of a window, outermost only (a frame inside a page is part of that page). Web areas inside the
 * toolbar are the browser's own UI (newer Chrome draws its toolbar as a WebUI page) and are skipped.
 */
func webAreas(in window: AXUIElement) -> (areas: [AXUIElement], hasTabStrip: Bool) {
  var areas: [AXUIElement] = []
  var hasTabStrip = false
  var visited = 0
  func visit(_ element: AXUIElement, _ depth: Int) {
    visited += 1
    if visited > 20_000 || depth > 60 { return }
    let role = string(copyAttribute(element, kAXRoleAttribute)) ?? ""
    if role == roleWebArea {
      areas.append(element)
      return
    }
    if role == "AXToolbar" { return }
    if role == "AXTabGroup" { hasTabStrip = true }
    for child in children(element) { visit(child, depth + 1) }
  }
  visit(window, 0)
  return (areas, hasTabStrip)
}

func isExtensionUrl(_ url: String) -> Bool { url.hasPrefix("chrome-extension://") }

/**
 * What a web area is in its window. The window title starts with the active tab's title, so the area whose title
 * prefixes it is the tab (the widest area when titles don't decide); the other areas of a window with a tab strip are
 * side panels, and a window without one is a popup.
 */
func classify(names: [String], widths: [Double], windowTitle: String, hasTabStrip: Bool) -> [String] {
  if !hasTabStrip { return names.map { _ in "popup" } }
  let titled = names.indices.filter { !names[$0].isEmpty && windowTitle.hasPrefix(names[$0] + " - ") }
  let tab = titled.count == 1 ? titled[0] : widths.indices.max(by: { widths[$0] < widths[$1] })
  return names.indices.map { $0 == tab ? "tab" : "side-panel" }
}

func surfaces(all: Bool) -> [[String: Any]] {
  var result: [[String: Any]] = []
  let running = NSWorkspace.shared.runningApplications.filter { chromiumBundles.contains($0.bundleIdentifier ?? "") }
  let apps = running.map { ($0, application($0.processIdentifier)) }
  if apps.contains(where: { $0.1.activated }) { usleep(activationSettle) }
  for (running, (app, _)) in apps {
    let pid = running.processIdentifier
    for (window, windowId) in windows(app) {
      let (areas, hasTabStrip) = webAreas(in: window)
      let windowTitle = string(copyAttribute(window, kAXTitleAttribute)) ?? ""
      let details = areas.map { copyAttributes($0, [kAXURLAttribute, kAXTitleAttribute, kAXDescriptionAttribute]) }
      let names = details.map { accessibleName(role: roleWebArea, values: $0) }
      let frames = areas.map { frame($0) }
      let kinds = classify(names: names, widths: frames.map { $0?["width"] ?? 0 }, windowTitle: windowTitle, hasTabStrip: hasTabStrip)
      for index in areas.indices {
        let url = string(details[index][kAXURLAttribute]) ?? ""
        if !all && !isExtensionUrl(url) { continue }
        var surface: [String: Any] = [
          "pid": Int(pid),
          "app": running.localizedName ?? running.bundleIdentifier ?? "",
          "bundleId": running.bundleIdentifier ?? "",
          "window": Int(windowId),
          "windowTitle": windowTitle,
          "url": url,
          "title": names[index],
          "kind": kinds[index],
        ]
        if let frame = frames[index] { surface["frame"] = frame }
        result.append(surface)
      }
    }
  }
  return result
}

/** A document's address without its fragment: single-page extension UIs (a wallet's `#/send`) route by fragment. */
func documentKey(_ url: String) -> String { url.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? url }

/** The web area for a surface: same process, same window, same document (its fragment may have changed). */
func resolveSurface(pid: pid_t, window windowId: CGWindowID, url: String) throws -> AXUIElement {
  let app = application(pid).element
  guard let window = windows(app).first(where: { $0.id == windowId })?.element else {
    throw Failure(code: "SURFACE_GONE", message: "The browser window \(windowId) is gone. List the panels again.")
  }
  let key = documentKey(url)
  let matches = webAreas(in: window).areas.filter { documentKey(string(copyAttribute($0, kAXURLAttribute)) ?? "") == key }
  guard let area = matches.first else {
    throw Failure(code: "SURFACE_GONE", message: "No web area in window \(windowId) shows \(key) any more; the panel was closed or navigated. List the panels again.")
  }
  return area
}

let nodeAttributes = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
  kAXPlaceholderValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXExpandedAttribute,
  kAXChildrenAttribute,
]

func dump(_ root: AXUIElement, maxNodes: Int) -> (node: [String: Any], count: Int, truncated: Bool) {
  var count = 0
  var truncated = false
  func visit(_ element: AXUIElement, _ depth: Int) -> [String: Any]? {
    if count >= maxNodes || depth > 200 {
      truncated = true
      return nil
    }
    count += 1
    let values = copyAttributes(element, nodeAttributes)
    let role = string(values[kAXRoleAttribute]) ?? ""
    let subrole = string(values[kAXSubroleAttribute]) ?? ""
    var node: [String: Any] = ["role": role, "name": accessibleName(role: role, values: values)]
    if !subrole.isEmpty { node["subrole"] = subrole }
    // A password field's value never leaves this process.
    if subrole != "AXSecureTextField", role != "AXStaticText", let value = string(values[kAXValueAttribute]), !value.isEmpty {
      node["value"] = value
    }
    if let placeholder = string(values[kAXPlaceholderValueAttribute]), !placeholder.isEmpty { node["placeholder"] = placeholder }
    if bool(values[kAXEnabledAttribute]) == false { node["disabled"] = true }
    if bool(values[kAXFocusedAttribute]) == true { node["focused"] = true }
    if bool(values[kAXSelectedAttribute]) == true { node["selected"] = true }
    if let expanded = bool(values[kAXExpandedAttribute]) { node["expanded"] = expanded }
    var actionNames: CFArray?
    if AXUIElementCopyActionNames(element, &actionNames) == .success, let names = actionNames as? [String] {
      let actions = names.filter { wantedActions.contains($0) }
      if !actions.isEmpty { node["actions"] = actions }
    }
    if settableRoles.contains(role) {
      var settable = DarwinBoolean(false)
      if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
        node["settable"] = true
      }
    }
    let kids = (values[kAXChildrenAttribute] as? [AXUIElement]) ?? []
    if !kids.isEmpty {
      // Children keep their index even when one is cut off, so a path stays a path into the live tree.
      var out: [Any] = []
      for kid in kids {
        guard let child = visit(kid, depth + 1) else { break }
        out.append(child)
      }
      node["children"] = out
    }
    return node
  }
  let node = visit(root, 0) ?? [:]
  return (node, count, truncated)
}

func element(at path: [Int], from root: AXUIElement) throws -> AXUIElement {
  var current = root
  for index in path {
    let kids = children(current)
    guard index >= 0, index < kids.count else {
      throw Failure(code: "STALE_REF", message: "The panel changed since the snapshot; take a new snapshot.")
    }
    current = kids[index]
  }
  return current
}

func act(options: [String: String]) throws -> [String: Any] {
  let (pid, windowId, url) = try surfaceOptions(options)
  guard let action = options["action"], let pathText = options["path"], let role = options["role"], let name = options["name"] else {
    throw Failure(code: "BAD_ARGS", message: "act needs --action, --path, --role and --name")
  }
  let path = pathText.isEmpty ? [] : try pathText.split(separator: ".").map { part -> Int in
    guard let index = Int(part) else { throw Failure(code: "BAD_ARGS", message: "Bad --path \(pathText)") }
    return index
  }
  let area = try resolveSurface(pid: pid, window: windowId, url: url)
  let target = try element(at: path, from: area)
  let values = copyAttributes(target, [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute])
  let actualRole = string(values[kAXRoleAttribute]) ?? ""
  let actualName = accessibleName(role: actualRole, values: values)
  guard actualRole == role, actualName == name else {
    throw Failure(code: "STALE_REF", message: "The element at that ref is now \(actualRole) \"\(actualName.prefix(80))\", not \(role) \"\(name.prefix(80))\"; take a new snapshot.")
  }
  switch action {
  case "press":
    let status = AXUIElementPerformAction(target, kAXPressAction as CFString)
    guard status == .success else { throw Failure(code: "ACTION_FAILED", message: "AXPress failed (\(status.rawValue)); the element may not be clickable.") }
    return ["ok": true]
  case "focus":
    let status = AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard status == .success else { throw Failure(code: "ACTION_FAILED", message: "Focusing failed (\(status.rawValue)).") }
    return ["ok": true]
  case "set-value":
    let input = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    AXUIElementSetAttributeValue(target, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let status = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, input as CFString)
    guard status == .success else { throw Failure(code: "ACTION_FAILED", message: "Setting the value failed (\(status.rawValue)); the element may not be editable.") }
    // Report whether it took, without echoing the value (it may be a secret). The renderer updates the tree a moment
    // after the page handles the input; a password field never reads back, so it reports nothing.
    if string(copyAttribute(target, kAXSubroleAttribute)) == "AXSecureTextField" { return ["ok": true] }
    for _ in 0..<20 {
      if string(copyAttribute(target, kAXValueAttribute)) == input { return ["ok": true, "valueMatches": true] }
      usleep(50_000)
    }
    return ["ok": true, "valueMatches": false]
  default:
    throw Failure(code: "BAD_ARGS", message: "Unknown --action \(action)")
  }
}

func surfaceOptions(_ options: [String: String]) throws -> (pid_t, CGWindowID, String) {
  guard let pidText = options["pid"], let pid = pid_t(pidText), let windowText = options["window"], let windowId = CGWindowID(windowText),
        let url = options["url"]
  else { throw Failure(code: "BAD_ARGS", message: "Needs --pid, --window and --url") }
  return (pid, windowId, url)
}

func parseOptions(_ args: ArraySlice<String>) throws -> [String: String] {
  var options: [String: String] = [:]
  var iterator = args.makeIterator()
  while let flag = iterator.next() {
    guard flag.hasPrefix("--") else { throw Failure(code: "BAD_ARGS", message: "Unexpected argument \(flag)") }
    let key = String(flag.dropFirst(2))
    if key == "all" {
      options[key] = "1"
      continue
    }
    guard let value = iterator.next() else { throw Failure(code: "BAD_ARGS", message: "\(flag) needs a value") }
    options[key] = value
  }
  return options
}

func emit(_ object: Any) {
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func run() throws -> Any {
  let args = CommandLine.arguments
  guard args.count >= 2 else { throw Failure(code: "BAD_ARGS", message: "Usage: browse-ax trusted|surfaces|tree|act") }
  let command = args[1]
  let options = try parseOptions(args[2...])
  if command == "trusted" { return ["trusted": AXIsProcessTrusted()] }
  guard AXIsProcessTrusted() else {
    throw Failure(
      code: "NOT_TRUSTED",
      message: "macOS has not granted Accessibility access to the app that runs browse (your terminal or agent host). Allow it in System Settings > Privacy & Security > Accessibility, then retry.")
  }
  switch command {
  case "surfaces":
    return ["surfaces": surfaces(all: options["all"] != nil)]
  case "tree":
    let (pid, windowId, url) = try surfaceOptions(options)
    let maxNodes = Int(options["max-nodes"] ?? "") ?? 4000
    var area = try resolveSurface(pid: pid, window: windowId, url: url)
    var result = dump(area, maxNodes: maxNodes)
    // A renderer that was just switched on publishes its tree a moment later.
    var waited = 0
    while result.count <= 1 && waited < 8 {
      usleep(250_000)
      waited += 1
      area = try resolveSurface(pid: pid, window: windowId, url: url)
      result = dump(area, maxNodes: maxNodes)
    }
    let current = string(copyAttribute(area, kAXURLAttribute)) ?? url
    return ["url": current, "root": result.node, "nodes": result.count, "truncated": result.truncated]
  case "act":
    return try act(options: options)
  default:
    throw Failure(code: "BAD_ARGS", message: "Unknown command \(command)")
  }
}

do {
  emit(try run())
} catch let failure as Failure {
  emit(["error": ["code": failure.code, "message": failure.message]])
  exit(1)
} catch {
  emit(["error": ["code": "INTERNAL", "message": "\(error)"]])
  exit(1)
}
