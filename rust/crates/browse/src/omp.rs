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

fn manifest_file() -> PathBuf {
    relay_api::paths().data.join("omp.json")
}

/// What an earlier install recorded writing.
fn recorded() -> Option<Paths> {
    let value: Value = serde_json::from_slice(&std::fs::read(manifest_file()).ok()?).ok()?;
    Some(Paths { launcher: value["launcher"].as_str()?.into(), skill: value["skill"].as_str()?.into() })
}

/// Where install writes: `--bin-dir`/`--skills-dir`, else the environment, else the defaults.
pub fn paths(bin_dir: Option<&Path>, skills_dir: Option<&Path>) -> Paths {
    let env = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
    let bin = bin_dir.map(Path::to_path_buf).or_else(|| env("OPENCODE_BROWSER_BIN_DIR")).unwrap_or_else(relay_api::bin_root);
    let skills = skills_dir.map(Path::to_path_buf).or_else(|| env("OPENCODE_BROWSER_SKILLS_DIR")).unwrap_or_else(|| crate::setup::home().join(".agents").join("skills"));
    Paths { launcher: bin.join("browse"), skill: skills.join("browse").join("SKILL.md") }
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
/// nothing, when either file exists and isn't this install's. Returns the lines to print.
pub fn install(paths: &Paths, executable: &Path, browsers: &[(String, String)]) -> anyhow::Result<Vec<String>> {
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
    let done = write_owned(&paths.skill, &skill(browsers), false)?;
    lines.push(format!("✓ omp skill {done}: {}", tilde(&paths.skill)));
    let manifest = json!({ "launcher": paths.launcher, "skill": paths.skill, "launcherWritten": launcher });
    crate::update::write_private(&manifest_file(), format!("{manifest:#}\n").as_bytes())?;
    Ok(lines)
}

/// Removes what install recorded writing (else what it would write at the defaults), each only with its marker.
pub fn uninstall() -> Vec<String> {
    let paths = recorded().unwrap_or_else(|| paths(None, None));
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
        let lines = install(&paths, &exe, &[]).unwrap();
        assert!(lines[0].contains("updated") && lines[1].contains("added"), "{lines:?}");
        assert_eq!(std::fs::read_to_string(&paths.launcher).unwrap(), launcher_script(&exe));
        assert_eq!(owner(&paths.skill), Owner::Ours);
        assert!(install(&paths, &exe, &[]).unwrap().iter().all(|l| l.contains("unchanged")));
        std::fs::write(&paths.skill, "someone's skill").unwrap();
        let error = install(&paths, &exe, &[]).unwrap_err().to_string();
        assert!(error.contains("won't overwrite") && error.contains("SKILL.md"), "{error}");
        // A build that is the launcher's own file gets no launcher.
        std::fs::remove_file(&paths.skill).unwrap();
        let lines = install(&paths, &paths.launcher, &[]).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_launcher_quotes_its_target() {
        assert_eq!(launcher_script(Path::new("/a b/it's/browse")).lines().last(), Some("exec '/a b/it'\\''s/browse' \"$@\""));
    }
}
