//! The omp (oh-my-pi) client: what `browse install --client omp` writes, and what uninstall and status read back.
//! omp drives browse as a CLI from bash, guided by a skill, so install writes
//!   launcher  <bin dir>/browse: a sh script that runs this build (unless this build already is that file)
//!   skill     <skills dir>/browse/SKILL.md: omp-skill.md with the paired browsers filled in
//! and records both in <data root>/omp.json, so uninstall removes exactly those. `--mcp` also adds the browse MCP
//! server to omp's mcp.json, through the `omp` agent (agents.rs). The launcher and skill carry a marker line; install
//! refuses to overwrite, and uninstall leaves alone, a file without one. The TypeScript fork's marker counts too, so
//! its launcher and skill are replaced in place.
//! Defaults, each overridable by a flag, then an environment variable:
//!   --bin-dir     OPENCODE_BROWSER_BIN_DIR     ~/.local/bin ($XDG_BIN_HOME)
//!   --skills-dir  OPENCODE_BROWSER_SKILLS_DIR  ~/.agents/skills

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde_json::{Value, json};

use crate::relay_api;
use crate::setup::tilde;

const MARKER: &str = "Written by `browse install --client omp`; `browse uninstall --client omp` removes it. Install rewrites it.";
/// The TypeScript fork's marker: its launcher and skill are this install's to replace.
const LEGACY_MARKER: &str = "Written by `opencode-browser install --client omp`; `opencode-browser uninstall` removes it. Install rewrites it.";
const SKILL: &str = include_str!("omp-skill.md");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub launcher: PathBuf,
    pub skill: PathBuf,
}

pub fn manifest_file() -> PathBuf {
    relay_api::paths().data.join("omp.json")
}

/// What an earlier install recorded writing.
fn recorded() -> Option<Paths> {
    let value: Value = serde_json::from_slice(&std::fs::read(manifest_file()).ok()?).ok()?;
    Some(Paths { launcher: value["launcher"].as_str()?.into(), skill: value["skill"].as_str()?.into() })
}

/// omp's mcp.json: the one an earlier install recorded, else where omp keeps it (agents.rs).
pub fn mcp_location() -> crate::agents::Location {
    let recorded = std::fs::read(manifest_file()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["mcpConfig"].as_str().map(PathBuf::from));
    let default = crate::agents::locations(&crate::setup::opencode_config(), None).into_iter().find(|l| l.name == "omp").map(|l| l.file);
    let file = recorded.or(default).unwrap_or_else(|| crate::setup::home().join(".omp").join("agent").join("mcp.json"));
    crate::agents::Location { name: "omp", file, installed: true }
}

/// Where install writes: `--bin-dir`/`--skills-dir`, else the environment, else where an earlier install wrote, else
/// the defaults.
pub fn paths(bin_dir: Option<&Path>, skills_dir: Option<&Path>) -> Paths {
    let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let bin = bin_dir.map(Path::to_path_buf).or_else(|| env("OPENCODE_BROWSER_BIN_DIR"));
    let skills = skills_dir.map(Path::to_path_buf).or_else(|| env("OPENCODE_BROWSER_SKILLS_DIR"));
    let cwd = std::env::current_dir().unwrap_or_default();
    let defaults = Paths { launcher: relay_api::bin_root().join("browse"), skill: crate::setup::home().join(".agents").join("skills").join("browse").join("SKILL.md") };
    resolve(bin, skills, recorded(), &cwd, defaults)
}

/// Each file at its override's folder (made absolute, so status and uninstall find it from anywhere), else where an
/// earlier install recorded it, else at its default.
fn resolve(bin: Option<PathBuf>, skills: Option<PathBuf>, recorded: Option<Paths>, cwd: &Path, defaults: Paths) -> Paths {
    let absolute = |dir: PathBuf| if dir.is_absolute() { dir } else { cwd.join(dir) };
    let launcher = bin.map(|dir| absolute(dir).join("browse")).or_else(|| recorded.as_ref().map(|r| r.launcher.clone())).unwrap_or(defaults.launcher);
    let skill = skills.map(|dir| absolute(dir).join("browse").join("SKILL.md")).or_else(|| recorded.map(|r| r.skill)).unwrap_or(defaults.skill);
    Paths { launcher, skill }
}

#[derive(Debug, PartialEq, Eq)]
enum Owner {
    Missing,
    Ours,
    Foreign,
}

/// Whether `file` is missing, carries a marker line (a `#` comment in the launcher, an HTML comment in the skill), or
/// is someone else's (anything else, a symlink or a folder included).
fn owner(file: &Path) -> Owner {
    let Ok(meta) = std::fs::symlink_metadata(file) else { return Owner::Missing };
    if !meta.is_file() {
        return Owner::Foreign;
    }
    let Ok(text) = std::fs::read_to_string(file) else { return Owner::Foreign };
    let marked = text.lines().any(|line| {
        let line = line.trim().trim_start_matches('#').trim_start_matches("<!--").trim_end_matches("-->").trim();
        line == MARKER || line == LEGACY_MARKER
    });
    if marked { Owner::Ours } else { Owner::Foreign }
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

pub fn launcher_script(executable: &Path) -> String {
    format!(
        "#!/bin/sh\n# browse: the browse CLI, for omp and other agents that run commands.\n# {MARKER}\nexec {} \"$@\"\n",
        shell_quote(&executable.to_string_lossy())
    )
}

/// The skill with the paired browsers' table (id, name) in place of its placeholder, and the marker.
pub fn skill(browsers: &[(String, String)]) -> String {
    let table = if browsers.is_empty() {
        "No browser had paired when this was installed; `browse pair` prints a code for one.".to_owned()
    } else {
        let rows: Vec<String> = browsers.iter().map(|(id, name)| format!("| {id} | {} |", name.replace('|', "\\|"))).collect();
        format!("| --profile | Browser name |\n|---|---|\n{}", rows.join("\n"))
    };
    let body = SKILL.replace("{{BROWSERS}}", &table);
    // The marker goes right after the frontmatter, which must stay first.
    match body.strip_prefix("---\n").and_then(|rest| rest.find("\n---\n").map(|end| end + 4 + 5)) {
        Some(at) => format!("{}<!-- {MARKER} -->\n{}", &body[..at], &body[at..]),
        None => format!("<!-- {MARKER} -->\n{body}"),
    }
}

/// Writes `text` to a file install owns; "added", "updated" or "unchanged".
fn write_owned(file: &Path, text: &str, executable: bool) -> anyhow::Result<&'static str> {
    let before = std::fs::read_to_string(file).ok();
    if before.as_deref() == Some(text) {
        return Ok("unchanged");
    }
    std::fs::create_dir_all(file.parent().context("no parent folder")?)?;
    crate::setup::write_keeping_mode(file, text.as_bytes())?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(if before.is_none() { "added" } else { "updated" })
}

/// Installs the launcher (unless `executable` is already at its path) and the skill. Refuses, having written
/// nothing, when either file exists and isn't this install's. Records `mcp_config` when install keeps an MCP entry
/// there. Returns the lines to print.
pub fn install(paths: &Paths, executable: &Path, browsers: &[(String, String)], manifest_file: &Path, mcp_config: Option<&Path>) -> anyhow::Result<Vec<String>> {
    let same = |a: &Path, b: &Path| std::fs::canonicalize(a).ok().is_some_and(|a| std::fs::canonicalize(b).ok() == Some(a));
    let launcher = !same(&paths.launcher, executable);
    let mut refused: Vec<&Path> = Vec::new();
    if launcher && owner(&paths.launcher) == Owner::Foreign {
        refused.push(&paths.launcher);
    }
    if owner(&paths.skill) == Owner::Foreign {
        refused.push(&paths.skill);
    }
    if !refused.is_empty() {
        bail!(
            "install --client omp won't overwrite {}: browse didn't write {}. Move {} aside, or pass --bin-dir/--skills-dir.",
            refused.iter().map(|p| tilde(p)).collect::<Vec<_>>().join(" and "),
            if refused.len() == 1 { "it" } else { "them" },
            if refused.len() == 1 { "it" } else { "them" }
        );
    }
    let mut lines = Vec::new();
    if launcher {
        let done = write_owned(&paths.launcher, &launcher_script(executable), true)?;
        lines.push(format!("✓ omp launcher {done}: {} runs {}", tilde(&paths.launcher), executable.display()));
    }
    // A name someone edited in the installed table ("safzan (Helium, his main personal browser …)") stays.
    let kept = table_names(&paths.skill);
    let browsers: Vec<(String, String)> = browsers.iter().map(|(id, name)| (id.clone(), kept.iter().find(|(k, _)| k == id).map_or_else(|| name.clone(), |(_, n)| n.clone()))).collect();
    let done = write_owned(&paths.skill, &skill(&browsers), false)?;
    lines.push(format!("✓ omp skill {done}: {}", tilde(&paths.skill)));
    let mut manifest = json!({ "launcher": paths.launcher, "skill": paths.skill, "launcherWritten": launcher });
    if let Some(file) = mcp_config {
        manifest["mcpConfig"] = json!(file);
    }
    crate::update::write_private(manifest_file, format!("{manifest:#}\n").as_bytes())?;
    Ok(lines)
}

/// The `| id | name |` rows of the browser table in an installed skill this install owns (the TypeScript fork's
/// included, which used the same table).
fn table_names(file: &Path) -> Vec<(String, String)> {
    if owner(file) != Owner::Ours {
        return Vec::new();
    }
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    text.lines()
        .skip_while(|line| !line.starts_with("| --profile |"))
        .skip(2)
        .take_while(|line| line.starts_with('|'))
        .filter_map(|line| {
            let (id, rest) = line.strip_prefix("| ")?.split_once(" | ")?;
            Some((id.trim().to_owned(), rest.strip_suffix(" |")?.trim().replace("\\|", "|")))
        })
        .collect()
}

/// Removes what install recorded writing (else what it would write at the defaults), each only with its marker.
pub fn uninstall() -> Vec<String> {
    let paths = recorded().unwrap_or_else(|| paths(None, None));
    let mcp = mcp_location();
    let mut lines = Vec::new();
    for file in [&paths.launcher, &paths.skill] {
        match owner(file) {
            Owner::Ours => match std::fs::remove_file(file) {
                Ok(()) => lines.push(format!("✓ Removed {}", tilde(file))),
                Err(error) => lines.push(format!("! Couldn't remove {} ({error})", tilde(file))),
            },
            Owner::Foreign => lines.push(format!("! {} wasn't written by browse; left it alone", tilde(file))),
            Owner::Missing => {}
        }
    }
    // The MCP entry an omp install wrote (its marker says so; any other server named browse stays).
    match crate::agents::edit(&mcp, &["browse".to_owned(), "mcp".to_owned()], true) {
        Ok(crate::agents::Edit::Removed) => lines.push(format!("✓ Removed browse from omp's {}", tilde(&mcp.file))),
        Ok(_) => {}
        Err(error) => lines.push(format!("! Couldn't remove browse from {}: {error:#}", tilde(&mcp.file))),
    }
    if let Some(dir) = paths.skill.parent() {
        let _ = std::fs::remove_dir(dir);
    }
    let _ = std::fs::remove_file(manifest_file());
    lines
}

/// The status line for omp, when install set it up.
pub fn status() -> Option<String> {
    let paths = recorded()?;
    let state = |file: &Path| if owner(file) == Owner::Ours { tilde(file) } else { format!("{} missing", tilde(file)) };
    Some(format!("omp:       launcher {}, skill {}", state(&paths.launcher), state(&paths.skill)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("browse-omp-{name}-{}", crate::session::random_u64()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_skill_lists_browsers_and_keeps_its_frontmatter_first() {
        let text = skill(&[("work".into(), "Work | IIM".into())]);
        assert!(text.starts_with("---\nname: browse\n"), "{text}");
        let after = text.split_once("\n---\n").unwrap().1;
        assert!(after.starts_with(&format!("<!-- {MARKER} -->\n")), "{after}");
        assert!(text.contains("| work | Work \\| IIM |"));
        assert!(!text.contains("{{BROWSERS}}"));
        assert!(skill(&[]).contains("`browse pair` prints a code"));
    }

    #[test]
    fn install_writes_marked_files_and_refuses_foreign_ones() {
        let dir = scratch("install");
        let paths = Paths { launcher: dir.join("bin/browse"), skill: dir.join("skills/browse/SKILL.md") };
        let exe = dir.join("target/release/browse");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, "binary").unwrap();
        // The TypeScript fork's launcher is replaced in place.
        std::fs::create_dir_all(paths.launcher.parent().unwrap()).unwrap();
        std::fs::write(&paths.launcher, format!("#!/bin/sh\n# {LEGACY_MARKER}\nexec node cli.mjs \"$@\"\n")).unwrap();
        let manifest = dir.join("omp.json");
        let lines = install(&paths, &exe, &[], &manifest, None).unwrap();
        assert!(lines[0].contains("updated") && lines[1].contains("added"), "{lines:?}");
        assert_eq!(std::fs::read_to_string(&paths.launcher).unwrap(), launcher_script(&exe));
        assert_eq!(owner(&paths.skill), Owner::Ours);
        assert!(install(&paths, &exe, &[], &manifest, None).unwrap().iter().all(|l| l.contains("unchanged")));
        std::fs::write(&paths.skill, "someone's skill").unwrap();
        let error = install(&paths, &exe, &[], &manifest, None).unwrap_err().to_string();
        assert!(error.contains("won't overwrite") && error.contains("SKILL.md"), "{error}");
        // A build that is the launcher's own file gets no launcher.
        std::fs::remove_file(&paths.skill).unwrap();
        let lines = install(&paths, &paths.launcher, &[], &manifest, None).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn notes_in_the_installed_table_survive_a_reinstall() {
        let dir = scratch("notes");
        let paths = Paths { launcher: dir.join("bin/browse"), skill: dir.join("skills/browse/SKILL.md") };
        std::fs::create_dir_all(paths.skill.parent().unwrap()).unwrap();
        let installed = format!(
            "---\nname: browse\n---\n<!-- {LEGACY_MARKER} -->\n\n| --profile | Browser name |\n|---|---|\n| safzan | safzan (Helium, his main personal browser since 2026-11-13) |\n| work | work |\n\nmore\n"
        );
        std::fs::write(&paths.skill, installed).unwrap();
        let browsers = [("safzan".to_owned(), "safzan".to_owned()), ("work".to_owned(), "Work".to_owned()), ("an".to_owned(), "an".to_owned())];
        install(&paths, &paths.launcher, &browsers, &dir.join("omp.json"), None).unwrap();
        let text = std::fs::read_to_string(&paths.skill).unwrap();
        assert!(text.contains("| safzan | safzan (Helium, his main personal browser since 2026-11-13) |"), "{text}");
        assert!(text.contains("| work | work |") && text.contains("| an | an |"), "{text}");
        assert!(text.contains(MARKER) && !text.contains(LEGACY_MARKER));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_launcher_quotes_its_target() {
        assert_eq!(launcher_script(Path::new("/a b/it's/browse")).lines().last(), Some("exec '/a b/it'\\''s/browse' \"$@\""));
    }

    #[test]
    fn overrides_are_recorded_absolute_and_a_reinstall_reuses_what_was_recorded() {
        let defaults = || Paths { launcher: "/home/u/.local/bin/browse".into(), skill: "/home/u/.agents/skills/browse/SKILL.md".into() };
        let cwd = Path::new("/work");
        let paths = resolve(Some("bin".into()), Some("/s".into()), None, cwd, defaults());
        assert_eq!(paths, Paths { launcher: "/work/bin/browse".into(), skill: "/s/browse/SKILL.md".into() });
        // No override: the files an earlier install recorded, not the defaults.
        let again = resolve(None, None, Some(paths.clone()), Path::new("/elsewhere"), defaults());
        assert_eq!(again, paths);
        assert_eq!(resolve(None, None, None, cwd, defaults()), defaults());
    }

    #[test]
    fn omp_mcp_entries_are_ours_only_with_the_marker() {
        use crate::agents::{Edit, decide, definition};
        let expected = definition("omp", "/home/u/.local/bin/browse", &["mcp".to_owned()]);
        // Someone's own `node .../cli.mjs mcp` named browse is not this install's.
        let theirs = serde_json::json!({ "command": "node", "args": ["/x/cli.mjs", "mcp"] });
        assert_eq!(decide(Some(&theirs), &expected, false).0, Edit::Conflict);
        assert_eq!(decide(Some(&theirs), &expected, true).0, Edit::Conflict);
        // The TypeScript fork's entry (its runtime fingerprint) is refreshed in place, keeping the user's env.
        let legacy = serde_json::json!({ "command": "/n/node", "args": ["/b/cli/dist/cli.mjs", "mcp"], "env": { "OPENCODE_BROWSER_RUNTIME": "fp", "X": "1" } });
        let (edit, change) = decide(Some(&legacy), &expected, false);
        assert_eq!(edit, Edit::Updated);
        let server = change.unwrap().unwrap();
        assert_eq!(server["command"], "/home/u/.local/bin/browse");
        assert_eq!(server["env"], serde_json::json!({ "OPENCODE_BROWSER_RUNTIME": "browse-rust", "X": "1" }));
        assert_eq!(decide(Some(&legacy), &expected, true).0, Edit::Removed);
    }
}
