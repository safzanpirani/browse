//! `browse find [site] [--json]`: one call that shows every browser paired with this relay (connected or not) and the
//! tabs agents can use in each (the ones agents opened and the ones the user lent). With a site (a host, URL fragment
//! or title word) it lists the matching tabs and the command to run next, or says how to get the site open. It reads a
//! relay that already runs and the pairing file; it never starts a relay, and it leaves a TypeScript browse relay
//! alone (any other call would replace it).

use anyhow::bail;
use browse_core::{Content, ToolCallRequest};
use serde_json::{Value, json};

use crate::{legacy, relay, relay_api};

const USAGE: &str = "Usage: browse find [site] [--json]";

pub fn command(args: &[String]) -> anyhow::Result<i32> {
    let mut as_json = false;
    let mut query: Option<&str> = None;
    for arg in args {
        match arg.as_str() {
            "--json" => as_json = true,
            flag if flag.starts_with('-') => bail!("Unknown option {flag} for find. {USAGE}"),
            word if query.is_none() => query = Some(word),
            _ => bail!("find takes one site. {USAGE}"),
        }
    }
    let paired: Vec<(String, String)> = browse_relay::pairing::read_browser_pairings(&relay_api::paths())
        .into_values()
        .filter_map(|pairing| Some((pairing.id?, pairing.name.unwrap_or_default())))
        .collect();
    let report = report(query, live(), &paired);
    if as_json {
        println!("{report:#}");
    } else {
        print!("{}", format(&report));
    }
    Ok(0)
}

/// What the running relay says: `{ relay, browsers, tabs }`, with a `note` on the relay when it can't be read.
fn live() -> Value {
    let endpoint = relay_api::endpoint();
    let down = |note: String| json!({ "relay": { "running": false, "endpoint": endpoint, "note": note }, "browsers": [], "tabs": [] });
    match relay::probe() {
        relay::Probe::Absent => down("No relay is running.".into()),
        relay::Probe::Foreign(message) => down(message),
        relay::Probe::Running(version) if legacy::is_legacy(&version) => json!({
            "relay": { "running": true, "endpoint": endpoint, "note": "A TypeScript browse relay runs here; this browse can't read its tabs without replacing it (`browse restart` does that)." },
            "browsers": [],
            "tabs": [],
        }),
        relay::Probe::Running(probed) => {
            // `status` names the browsers; `tabs` lists the tabs with their current titles. Both go on one connection
            // that first finds the relay the probe saw (by instanceId), with the token only if one exists: nothing here
            // starts, replaces or retries a relay, and a relay that took the port since the probe gets nothing.
            let instance = probed.get("instanceId").and_then(Value::as_str).unwrap_or_default();
            let requests = [ToolCallRequest { name: "status".into(), arguments: json!({}) }, ToolCallRequest { name: "tabs".into(), arguments: json!({ "action": "list" }) }];
            let json_of = |output: &browse_core::ToolOutput| {
                output.content.iter().find_map(|content| match content {
                    Content::Text { text } => serde_json::from_str::<Value>(text).ok(),
                    Content::Image { .. } => None,
                })
            };
            match relay::call_observed(instance, &requests) {
                Ok(outputs) => match (outputs.first().and_then(json_of), outputs.get(1).and_then(json_of)) {
                    (Some(status), Some(tabs)) => json!({
                        "relay": { "running": true, "endpoint": endpoint },
                        "browsers": status["extension"]["browsers"],
                        "tabs": tabs["tabs"],
                    }),
                    _ => down("The relay didn't answer status and tabs.".into()),
                },
                Err(error) => down(format!("{error:#}")),
            }
        }
    }
}

/// The site a query names, the way URLs and titles are matched: lowercase, without a scheme, `www.` or trailing `/`.
fn site(query: &str) -> String {
    let lower = query.trim().to_lowercase();
    let bare = lower.split_once("://").map_or(lower.as_str(), |(_, rest)| rest);
    bare.strip_prefix("www.").unwrap_or(bare).trim_end_matches('/').to_owned()
}

/// How to name a tab in the next command: its chosen id when it has one, else its number.
fn tab_handle(tab: &Value) -> String {
    tab["id"].as_str().map_or_else(|| tab["tab"].to_string(), str::to_owned)
}

/// The report: every browser with its tabs, and for a query the matching tabs with the next command, or advice.
fn report(query: Option<&str>, live: Value, paired: &[(String, String)]) -> Value {
    let tabs = live["tabs"].as_array().cloned().unwrap_or_default();
    let mut browsers: Vec<Value> = live["browsers"].as_array().cloned().unwrap_or_default();
    for (id, name) in paired {
        if !browsers.iter().any(|b| b["id"].as_str() == Some(id.as_str())) {
            browsers.push(json!({ "id": id, "name": name, "connected": false }));
        }
    }
    let shown = |tab: &Value| json!({ "tab": tab["tab"], "id": tab["id"], "url": tab["url"], "title": tab["title"], "lent": tab["lent"], "group": tab["group"] });
    let browsers: Vec<Value> = browsers
        .into_iter()
        .map(|browser| {
            let own: Vec<Value> = tabs.iter().filter(|t| t["browser"] == browser["id"]).map(shown).collect();
            json!({ "id": browser["id"], "name": browser["name"], "connected": browser["connected"] == true, "default": browser["default"] == true, "tabs": own })
        })
        .collect();
    let mut report = json!({ "relay": live["relay"], "browsers": browsers });
    let Some(query) = query else { return report };
    let wanted = site(query);
    let matches: Vec<Value> = tabs
        .iter()
        .filter(|tab| !wanted.is_empty() && [&tab["url"], &tab["title"]].iter().any(|field| field.as_str().is_some_and(|text| text.to_lowercase().contains(&wanted))))
        .map(|tab| json!({ "browser": tab["browser"], "tab": shown(tab), "next": format!("browse snapshot --tab {}", tab_handle(tab)) }))
        .collect();
    if matches.is_empty() {
        let connected: Vec<&str> = report["browsers"].as_array().into_iter().flatten().filter(|b| b["connected"] == true).filter_map(|b| b["id"].as_str()).collect();
        let url = if query.contains("://") { query.to_owned() } else { format!("https://{}", query.trim_end_matches('/')) };
        report["advice"] = match connected.as_slice() {
            [] => "No browser is connected: ask the user to open the profile with browse, then run find again.".into(),
            ids => format!(
                "No agent or lent tab shows {wanted}. Open it in the browser that's signed in there (`browse --profile <browser> navigate {url}`; connected: {}), or ask the user to lend their tab with the browse toolbar button.",
                ids.join(", ")
            )
            .into(),
        };
    }
    report["query"] = query.into();
    report["matches"] = matches.into();
    report
}

fn format(report: &Value) -> String {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let mut out = format!("Relay: {}{}\n", text(&report["relay"]["endpoint"]), if report["relay"]["running"] == true { "" } else { " (not running)" });
    if let Some(note) = report["relay"]["note"].as_str() {
        out.push_str(&format!("  {note}\n"));
    }
    for browser in report["browsers"].as_array().into_iter().flatten() {
        let state = if browser["connected"] == true { "connected" } else { "not connected" };
        let default = if browser["default"] == true { ", default" } else { "" };
        out.push_str(&format!("Browser {} ({}): {state}{default}\n", text(&browser["id"]), text(&browser["name"])));
        for tab in browser["tabs"].as_array().into_iter().flatten() {
            let lent = if tab["lent"] == true { " [lent]" } else { "" };
            let group = tab["group"].as_str().map(|g| format!(" [{g}]")).unwrap_or_default();
            out.push_str(&format!("  tab {}{lent}{group} {} {}\n", tab_handle(tab), text(&tab["url"]), text(&tab["title"])));
        }
    }
    if report["browsers"].as_array().is_none_or(Vec::is_empty) {
        out.push_str("No browser has paired with this relay yet; `browse pair` prints a code for one.\n");
    }
    for found in report["matches"].as_array().into_iter().flatten() {
        out.push_str(&format!("Match in {}: tab {} {} → {}\n", text(&found["browser"]), tab_handle(&found["tab"]), text(&found["tab"]["url"]), text(&found["next"])));
    }
    if let Some(advice) = report["advice"].as_str() {
        out.push_str(&format!("{advice}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live() -> Value {
        json!({
            "relay": { "running": true, "endpoint": "http://127.0.0.1:19988" },
            "browsers": [
                { "id": "work", "name": "Work", "connected": true, "default": true },
                { "id": "patty", "name": "Patty", "connected": true },
            ],
            "tabs": [
                { "tab": 12, "url": "https://www.figma.com/file/abc", "title": "Design", "browser": "work", "lent": true },
                { "tab": 14, "id": "mail", "url": "https://mail.google.com/", "title": "Inbox", "browser": "patty", "lent": false, "group": "triage" },
            ],
        })
    }

    #[test]
    fn every_browser_shows_with_its_tabs_and_offline_pairings() {
        let report = report(None, live(), &[("work".into(), "Work".into()), ("an".into(), "An".into())]);
        let browsers = report["browsers"].as_array().unwrap();
        assert_eq!(browsers.len(), 3);
        assert_eq!(browsers[0]["tabs"][0]["tab"], 12);
        assert_eq!(browsers[1]["tabs"][0]["id"], "mail");
        assert_eq!((browsers[2]["id"].as_str(), browsers[2]["connected"].as_bool()), (Some("an"), Some(false)));
        assert!(report.get("matches").is_none());
        let text = format(&report);
        assert!(text.contains("Browser an (An): not connected"), "{text}");
        assert!(text.contains("tab mail [triage] https://mail.google.com/ Inbox"), "{text}");
    }

    #[test]
    fn a_site_finds_its_tab_and_the_next_command() {
        let report = report(Some("https://figma.com/"), live(), &[]);
        assert_eq!(report["matches"][0]["browser"], "work");
        assert_eq!(report["matches"][0]["next"], "browse snapshot --tab 12");
        assert!(report.get("advice").is_none());
        let chosen = super::report(Some("inbox"), live(), &[]);
        assert_eq!(chosen["matches"][0]["next"], "browse snapshot --tab mail");
    }

    #[test]
    fn no_match_says_where_to_open_it() {
        let report = report(Some("github.com"), live(), &[]);
        assert_eq!(report["matches"], json!([]));
        let advice = report["advice"].as_str().unwrap();
        assert!(advice.contains("browse --profile <browser> navigate https://github.com") && advice.contains("work, patty"), "{advice}");
        let offline = super::report(Some("github.com"), json!({ "relay": { "running": false }, "browsers": [], "tabs": [] }), &[("work".into(), "Work".into())]);
        assert!(offline["advice"].as_str().unwrap().starts_with("No browser is connected"));
    }
}
