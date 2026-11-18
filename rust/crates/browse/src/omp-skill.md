---
name: browse
description: Drive Safzan's real, signed-in browser profiles (Chrome, Helium) from omp with the `browse` CLI (OpenCode Browse, Rust build of the omp fork). Use for signed-in pages, sites behind a login, lent tabs, network captures of a logged-in app, and handing a login or 2FA step to the user. Not for screenshots of UI under development (macshot) or anonymous scraping.
---

# browse (omp)

`browse` is the browse CLI on PATH. One relay (127.0.0.1:19988) drives every browser profile paired with it, through
the browse extension in each. Run it from bash; `browse --help` lists the commands and `browse <tool> --help` a
tool's options. Add `--json '<object>'` to pass arguments as JSON. The `browse` MCP server is optional.

## Tabs are the handle

There are no sessions. A tool that acts on a page takes `--tab <id>`: the number `navigate` or `tabs new` printed, or
an id you chose with `tabs new --id work-mail`. You can use only tabs browse opened and tabs the user lent (the browse
toolbar button on their own tab); every other tab of theirs is invisible.

```bash
browse find figma.com                          # which browser has it in an agent or lent tab, and the next command
browse --profile work navigate https://example.com   # opens a background agent tab in `work`, prints "tab": 12
browse snapshot --tab 12                       # outline with refs (e1, e2, ...)
browse click e5 --tab 12
browse fill e7 'hello' --tab 12
browse screenshot --tab 12 --output /tmp/shot.png
browse tabs close --tab 12                     # a lent tab is given back, not closed
```

Options fixed when a tab opens (`navigate` without `--tab`, or `tabs new`): `--group <label>` (the tab group's title;
`tabs list --group` and `tabs close --group` act on all of them), `--readOnly` (snapshots and screenshots only),
`--allowedOrigins '["example.com"]'`, `--keepVisible`, `--keepOpen` (never closed as idle), `--browser <id>`.
Popups a tab opens become agent tabs with the same options. Idle agent tabs close after the profile's idleMinutes.

## Profiles

Each paired browser has an id, set from **Name for agents** on its browse Options page. `--profile <id>` on any
command (or `OPENCODE_BROWSER_PROFILE=<id>`) sends the tabs that command opens, and `settings`, to that browser;
without it the first connected browser gets them. Tabs that already exist stay in their browser, so `--tab` alone is
enough after the first command. Shell variables don't persist between bash calls: pass `--profile` on each command
that opens a tab. The browsers when this skill was installed (`browse status` and `browse find` show the live state):

{{BROWSERS}}

Check the app's own signed-in account before acting, not the profile name: one profile can hold several Google
accounts or app logins. Never use or override another person's account.

## Scripts: execute

```bash
browse --profile work execute --code 'await page.goto("https://example.com"); return await page.title()'
browse execute --tab 12 --file script.js       # continue in tab 12; `state` persists per tab between executes
```

The code is an async function body in a sandboxed JavaScript engine on the relay: a Playwright-style `page`, `snapshot()`,
`ref("e12")`, `handoff(message)`, `network.*`, `files.write/read` inside the file roots, `browse.<tool>(args)`. No
Node, fs, require or fetch (use `page.evaluate(() => fetch(...))` for in-page requests). It prints the tab it ended
in; pass that as `--tab` to continue. Default timeout 60 s (`--timeoutMs <ms>`, 0 for none). Return small values.

## The user's turn

`browse handoff --tab 12 --message "Sign in, then click Continue"` shows a card in the tab and waits (default 10 min)
until the user clicks Continue. Use it for logins, 2FA, captchas and payments; never solve a captcha yourself.
`browse demonstrate --tab 12 --message "Show me how to export"` records what the user does.

## Captures

- `browse network start --tab 12`, then `browse network stop --tab 12`: requests and JSON/form bodies with every
  credential replaced by `[redacted]` (authorization headers, cookie values, secret-named fields, known values where
  they reappear; short numbers like `1` stay data).
- `browse console start|read|stop --tab 12`, `browse recording start|stop --tab 12` (a Matroska file).
- `browse screenshot_diff --tab 12` compares against a baseline.

## Settings

`browse --profile work settings` reads that browser's settings; `browse --profile work settings --json
'{"set":{"idleMinutes":"never"}}'` changes them. Change settings only when the user asks.

## Relay

`browse status` shows the relay, the browsers and their state. `browse restart` restarts the relay (agent tabs stay
open); `browse stop` stops it. From ampere the same CLI reaches this relay through one ssh tunnel on the same port
(skill `browse-remote`).

| Symptom | Do this |
|---|---|
| Browser not connected | `browse find`; use a connected browser, or tell the user which profile to open. One command waits up to 35 s for a reconnect; don't loop `status`. |
| "No connected browser is called …" | The profile isn't open, or its Name for agents differs: `browse status` lists the ids. |
| "isn't a browse tab" | The user hasn't lent it: ask them to click the browse toolbar button on that tab, then `browse find <site>`. |
| "Tab … is gone" | It closed (idle, or the user closed it): open another. |
| A call hangs on a handoff | The user hasn't clicked Continue; ask them to. |
