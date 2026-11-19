//! `browse uninstall` leaves nothing behind: a stopping relay is done with its files (the final tab write, the
//! shutdown log and relay.json) before uninstall deletes its folders.

use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use browse_relay::paths::Paths;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn wait_for(what: &str, timeout: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

/// The real `browse` in a throwaway environment: no real agent configs, relays or browse roots.
fn browse(home: &Path, port: u16) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_browse"));
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("xdg-data"))
        .env("XDG_STATE_HOME", home.join("xdg-state"))
        .env("XDG_CACHE_HOME", home.join("xdg-cache"))
        .env("XDG_BIN_HOME", home.join("bin"))
        .env("OPENCODE_BROWSER_HOME", home.join("browse-home"))
        .env("OPENCODE_BROWSER_PORT", port.to_string())
        .env("OPENCODE_BROWSER_AUTO_UPDATE", "off")
        .env("OPENCODE_BROWSER_UPDATE_CHECK", "0")
        .env("CODEX_HOME", home.join("codex"))
        .env("CLAUDE_CONFIG_DIR", home.join("claude"))
        .env("OPENCODE_CONFIG_DIR", home.join("opencode"));
    command
}

/// Kills its relay on drop, so a failed assertion doesn't leave one behind.
struct Guard(Child);

impl Guard {
    /// Whether the relay process is still running. Its exit is reaped here, so a zombie doesn't count.
    fn alive(&mut self) -> bool {
        self.0.try_wait().is_ok_and(|status| status.is_none())
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn uninstall_leaves_no_browse_files_behind_the_relay() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("browse-uninstall-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let paths = Paths::rooted(home.join("browse-home"));
    let port = free_port();

    // The relay holds the post-listener window open for a second before its final registry write, so a stop that only
    // waits for /version can't get away with deleting the root before that write lands.
    let mut relay = Guard(
        browse(&home, port)
            .env("OPENCODE_BROWSER_TEST_SHUTDOWN_DELAY_MS", "1000")
            .arg("serve")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("browse serve starts"),
    );
    wait_for("the relay", Duration::from_secs(15), || paths.relay_state(port).is_file());

    let output = browse(&home, port).arg("uninstall").output().expect("browse uninstall runs");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "uninstall failed:\n{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
    assert!(!paths.config.exists(), "uninstall must remove browse's root: {}", paths.config.display());
    wait_for("the relay process to exit", Duration::from_secs(15), || !relay.alive());

    // The relay persists its tabs and writes relay.shutdown.closed while it stops. Neither may recreate the root.
    std::thread::sleep(Duration::from_secs(2));
    assert!(!paths.config.exists(), "a stopping relay recreated {}", paths.config.display());
    assert!(!paths.tab_registry(port).exists(), "the relay recreated its tab registry");
    assert!(!paths.relay_log().exists(), "the relay recreated its log");

    let _ = std::fs::remove_dir_all(&home);
}

/// S9: `install --client omp --mcp` writes omp's MCP entry to one config and records that file; a reinstall after
/// omp's config moved (OPENCODE_BROWSER_OMP_DIR) keeps using the recorded file, and `uninstall --client omp` removes
/// the entry from it, so no entry is stranded where uninstall doesn't look.
#[test]
fn omp_install_and_uninstall_use_the_recorded_mcp_config() {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("browse-omp-mcp-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let paths = Paths::rooted(home.join("browse-home"));
    let port = free_port();
    let _relay = Guard(browse(&home, port).arg("serve").stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("browse serve starts"));
    wait_for("the relay", Duration::from_secs(15), || paths.relay_state(port).is_file());

    let (first, moved) = (home.join("omp-first"), home.join("omp-moved"));
    let run = |omp_dir: &Path, args: &[&str]| {
        let output = browse(&home, port).env("OPENCODE_BROWSER_OMP_DIR", omp_dir).args(args).output().expect("browse runs");
        assert!(output.status.success(), "{args:?} failed:\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    };
    let browse_entry = |file: &Path| -> serde_json::Value {
        let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        config["mcpServers"]["browse"].clone()
    };
    let install = ["install", "--client", "omp", "--mcp", "--no-wait", "--no-open"];
    run(&first, &install);
    assert!(browse_entry(&first.join("mcp.json")).is_object(), "the first install writes omp's entry");

    run(&moved, &install);
    assert!(!moved.join("mcp.json").exists(), "a reinstall keeps writing the recorded config");
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(paths.data.join("omp.json")).unwrap()).unwrap();
    assert_eq!(manifest["mcpConfig"].as_str().map(Path::new), Some(first.join("mcp.json").as_path()));
    assert!(browse_entry(&first.join("mcp.json")).is_object());

    run(&moved, &["uninstall", "--client", "omp"]);
    assert!(browse_entry(&first.join("mcp.json")).is_null(), "uninstall removes the entry from the recorded config");
    assert!(!moved.join("mcp.json").exists());

    let _ = std::fs::remove_dir_all(&home);
}
