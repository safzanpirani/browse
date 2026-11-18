//! `--profile <browser>` on any command (or OPENCODE_BROWSER_PROFILE): which paired browser, one Chrome-family
//! profile with browse, the command's new tabs and settings use. It names the browser's id or the name `status` lists
//! (its "Name for agents"); the relay resolves it (browse-relay `link_for`). main.rs takes the flag out of argv before
//! anything else parses it; `browse --profile work mcp` makes every tab that MCP server opens a `work` tab.

use std::sync::OnceLock;

use anyhow::bail;
use serde_json::{Map, Value};

pub const VARIABLE: &str = "OPENCODE_BROWSER_PROFILE";

static SELECTED: OnceLock<Option<String>> = OnceLock::new();

/// `args` without `--profile <name>` / `--profile=<name>`, and the name. Arguments after `--` belong to another
/// program and are left alone.
pub fn take(args: &[String]) -> anyhow::Result<(Vec<String>, Option<String>)> {
    let mut rest = Vec::with_capacity(args.len());
    let mut profile = None;
    let mut words = args.iter();
    while let Some(arg) = words.next() {
        if arg == "--" {
            rest.push(arg.clone());
            rest.extend(words.by_ref().cloned());
            break;
        }
        let value = if arg == "--profile" {
            match words.next() {
                Some(value) if !value.starts_with('-') => value.clone(),
                _ => bail!("--profile needs a browser name (see `browse status`)"),
            }
        } else if let Some(value) = arg.strip_prefix("--profile=") {
            value.to_owned()
        } else {
            rest.push(arg.clone());
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            bail!("--profile needs a browser name (see `browse status`)");
        }
        profile = Some(value.to_owned());
    }
    Ok((rest, profile))
}

fn from_env() -> Option<String> {
    std::env::var(VARIABLE).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

/// Records the `--profile` main.rs took from argv; without one, OPENCODE_BROWSER_PROFILE applies.
pub fn select(profile: Option<String>) {
    let _ = SELECTED.set(profile.or_else(from_env));
}

/// The browser this process was asked to use, if any.
pub fn selected() -> Option<&'static str> {
    SELECTED.get_or_init(from_env).as_deref()
}

/// Gives a call the selected browser where it picks one and names none: a tab it opens (navigate without `tab`,
/// `tabs new`), the tabs an execute opens, and the settings it reads or changes. Tabs that exist stay in their browser.
pub fn apply(tool: &str, arguments: &mut Map<String, Value>, browser: Option<&str>) {
    let Some(browser) = browser else { return };
    if arguments.get("browser").is_some_and(|v| !v.is_null()) {
        return;
    }
    let picks = match tool {
        "navigate" => arguments.get("tab").is_none_or(Value::is_null),
        "tabs" => arguments.get("action").and_then(Value::as_str) == Some("new"),
        "execute" | "settings" => true,
        _ => false,
    };
    if picks {
        arguments.insert("browser".into(), Value::String(browser.to_owned()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| (*w).to_owned()).collect()
    }

    #[test]
    fn the_flag_comes_out_of_argv_anywhere_before_a_separator() {
        let (rest, profile) = take(&words(&["--profile", "work", "navigate", "https://x.test"])).unwrap();
        assert_eq!((rest, profile.as_deref()), (words(&["navigate", "https://x.test"]), Some("work")));
        let (rest, profile) = take(&words(&["snapshot", "--tab", "3", "--profile=patty"])).unwrap();
        assert_eq!((rest, profile.as_deref()), (words(&["snapshot", "--tab", "3"]), Some("patty")));
        let (rest, profile) = take(&words(&["execute", "--", "--profile", "x"])).unwrap();
        assert_eq!((rest, profile), (words(&["execute", "--", "--profile", "x"]), None));
        assert!(take(&words(&["--profile"])).is_err());
        assert!(take(&words(&["--profile", "--tab", "3"])).is_err());
        assert!(take(&words(&["--profile=  "])).is_err());
    }

    #[test]
    fn only_calls_that_pick_a_browser_get_it() {
        let filled = |tool: &str, args: Value| {
            let mut map = args.as_object().cloned().unwrap();
            apply(tool, &mut map, Some("work"));
            map.get("browser").cloned()
        };
        assert_eq!(filled("navigate", json!({ "url": "https://x.test" })), Some(json!("work")));
        assert_eq!(filled("navigate", json!({ "url": "https://x.test", "tab": 4 })), None);
        assert_eq!(filled("tabs", json!({ "action": "new" })), Some(json!("work")));
        assert_eq!(filled("tabs", json!({ "action": "list" })), None);
        assert_eq!(filled("execute", json!({ "code": "1", "tab": 4 })), Some(json!("work")));
        assert_eq!(filled("settings", json!({})), Some(json!("work")));
        assert_eq!(filled("snapshot", json!({ "tab": 4 })), None);
        assert_eq!(filled("navigate", json!({ "browser": "patty" })), Some(json!("patty")));
        let mut untouched = Map::new();
        apply("navigate", &mut untouched, None);
        assert!(untouched.is_empty());
    }
}
