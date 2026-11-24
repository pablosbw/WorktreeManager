//! A code-server left running by an app instance that ended without stopping it, such as a killed
//! dev build, keeps holding the workspace's saved port and makes the next start fail.

use std::fs;
use std::path::Path;
#[cfg(not(windows))]
use std::process::Command;
use std::time::{Duration, Instant};

const PID_FILE: &str = "server.pid";

pub fn record(profile: &Path, pid: u32) -> Result<(), String> {
    fs::write(profile.join(PID_FILE), pid.to_string()).map_err(|error| error.to_string())
}

pub fn forget(profile: &Path) {
    let _ = fs::remove_file(profile.join(PID_FILE));
}

/// Ends the recorded server when it is an orphan still running this profile, so its port is free
/// again. A pid reused by an unrelated process, or a server another app instance still owns, is
/// left alone.
pub fn reclaim(profile: &Path) {
    let recorded = fs::read_to_string(profile.join(PID_FILE))
        .ok()
        .and_then(|pid| pid.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 1);
    forget(profile);
    if let Some(pid) = recorded.filter(|pid| orphan_running(*pid, profile)) {
        terminate(pid);
    }
}

/// Windows keeps no command line in reach and never reparents to 1: an orphan is a process that
/// runs one of this app's editor runtimes and whose parent has exited.
#[cfg(windows)]
fn orphan_running(pid: i32, profile: &Path) -> bool {
    let pid = pid as u32;
    let Some(runtimes) = profile
        .parent()
        .and_then(Path::parent)
        .map(|root| root.join("runtime").to_string_lossy().to_lowercase())
    else {
        return false;
    };
    let runs_editor = crate::platform::process_image(pid).is_some_and(|image| {
        image
            .to_string_lossy()
            .to_lowercase()
            .starts_with(&runtimes)
    });
    let parent = crate::platform::parent_pids()
        .and_then(|pairs| pairs.into_iter().find(|(child, _)| *child == pid))
        .map(|(_, parent)| parent);
    runs_editor && parent.is_some_and(|parent| !crate::platform::process_alive(parent))
}

#[cfg(not(windows))]
fn orphan_running(pid: i32, profile: &Path) -> bool {
    let data = profile.join("data").to_string_lossy().into_owned();
    Command::new("/bin/ps")
        .args(["-ww", "-o", "ppid=,command=", "-p", &pid.to_string()])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .and_then(|listing| {
            let (parent, command) = listing.trim().split_once(char::is_whitespace)?;
            Some(parent == "1" && command.contains(&data))
        })
        .unwrap_or(false)
}

fn terminate(pid: i32) {
    let pid = pid as u32;
    for force in [false, true] {
        let _ = crate::platform::signal_tree(pid, force);
        let _ = crate::platform::signal_process(pid, force);
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline && crate::platform::process_alive(pid) {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
