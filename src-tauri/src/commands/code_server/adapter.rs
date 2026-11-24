use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::Command;
use std::sync::Mutex;

use super::runtime;

static PREPARATION: Mutex<()> = Mutex::new(());
const WORKBENCH: &str = "lib/vscode/out/vs/code/browser/workbench/workbench.js";
const PTY_HOST: &str = "lib/vscode/out/vs/platform/terminal/node/ptyHostMain.js";
const PRELOADS: &[(&str, &str)] = &[
    ("lib/vscode/out/server-main.js", "../../../session.cjs"),
    (PTY_HOST, "../../../../../../../session.cjs"),
];
const PATCHES: &[(&str, &str, &str)] = &[
    (WORKBENCH, "options:r};return nW.set(e,c,l)", "options:{...r,extensionHostEnv:{...r?.extensionHostEnv,...globalThis.__wtmSessionEnv}}};return nW.set(e,c,l)"),
    (WORKBENCH, "e=t,eU.complete(t)", "e=t,globalThis.__wtmShutdown=()=>t.shutdown(),eU.complete(t)"),
    (PTY_HOST, "import{spawn as Pd}from\"node-pty\";", "import{spawn as wtmSpawn}from\"node-pty\";const Pd=(...args)=>globalThis.__wtmSpawnPty(wtmSpawn,...args);"),
];

pub fn prepare(root: &Path) -> Result<PathBuf, String> {
    let _guard = PREPARATION.lock().map_err(|error| error.to_string())?;
    let source = runtime::binary(root)?
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let fingerprint = format!(
        "{:x}",
        md5::compute(format!(
            "{PATCHES:?}{PRELOADS:?}{}",
            include_str!("session.cjs")
        ))
    );
    let target = source.with_file_name(format!(
        "wtm-{}-{fingerprint}",
        source.file_name().unwrap().to_string_lossy()
    ));
    if target.join("wtm-ready").is_file() {
        return Ok(runtime::release_executable(&target));
    }
    let temporary = target.with_extension(runtime::random_id()?);
    let result = (|| {
        clone_runtime(&source, &temporary)?;
        for (file, before, after) in PATCHES {
            let path = temporary.join(file);
            let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            rewrite(&path, replace_once(&source, before, after)?)?;
        }
        for (file, preload) in PRELOADS {
            let path = temporary.join(file);
            let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            rewrite(&path, format!("import {preload:?};\n{source}"))?;
        }
        fs::write(temporary.join("session.cjs"), include_str!("session.cjs"))
            .map_err(|error| error.to_string())?;
        fs::write(temporary.join("wtm-ready"), runtime::VERSION)
            .map_err(|error| error.to_string())?;
        fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
        Ok(runtime::release_executable(&target))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(temporary);
    }
    result
}

/// Copies the runtime without duplicating its files: APFS clones on macOS, hard links on Windows.
#[cfg(not(windows))]
fn clone_runtime(source: &Path, target: &Path) -> Result<(), String> {
    let output = Command::new("/bin/cp")
        .arg("-cR")
        .arg(source)
        .arg(target)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not prepare shared editor runtime: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn clone_runtime(source: &Path, target: &Path) -> Result<(), String> {
    fn link_tree(source: &Path, target: &Path) -> std::io::Result<()> {
        fs::create_dir(target)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let (from, to) = (entry.path(), target.join(entry.file_name()));
            if fs::metadata(&from)?.is_dir() {
                link_tree(&from, &to)?;
            } else if entry.file_type()?.is_symlink() {
                fs::copy(&from, &to)?;
            } else {
                fs::hard_link(&from, &to)?;
            }
        }
        Ok(())
    }
    link_tree(source, target)
        .map_err(|error| format!("Could not prepare shared editor runtime: {error}"))
}

/// Replaces `path` with new content without writing through to files it shares data with (hard
/// links or clones of the original runtime).
fn rewrite(path: &Path, content: String) -> Result<(), String> {
    fs::remove_file(path)
        .and_then(|_| fs::write(path, content))
        .map_err(|error| error.to_string())
}

fn replace_once(source: &str, before: &str, after: &str) -> Result<String, String> {
    if source.matches(before).count() != 1 {
        return Err(format!("The shared editor integration does not match code-server {}. Repair or update the editor before opening tasks.", runtime::VERSION));
    }
    Ok(source.replacen(before, after, 1))
}

#[cfg(all(test, target_os = "macos"))]
pub fn install_fake_runtime(root: &Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let binary = runtime::binary(root).unwrap();
    let original = binary.parent().unwrap().parent().unwrap();
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::write(&binary, script).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    for file in [WORKBENCH, PTY_HOST, "lib/vscode/out/server-main.js"] {
        let path = original.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let source = PATCHES
            .iter()
            .filter(|(target, _, _)| *target == file)
            .map(|(_, before, _)| *before)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(path, source).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_or_ambiguous_runtime_is_not_patched() {
        assert_eq!(replace_once("abc", "b", "B").unwrap(), "aBc");
        assert!(replace_once("abc", "d", "D").is_err());
        assert!(replace_once("bb", "b", "B").is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn prepares_a_reusable_copy_without_changing_the_original_runtime() {
        let root = std::env::temp_dir().join(runtime::random_id().unwrap());
        let binary = runtime::binary(&root).unwrap();
        let original = binary.parent().unwrap().parent().unwrap();
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        fs::write(&binary, "runtime").unwrap();
        for file in [WORKBENCH, PTY_HOST, "lib/vscode/out/server-main.js"] {
            let path = original.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let source = PATCHES
                .iter()
                .filter(|(target, _, _)| *target == file)
                .map(|(_, before, _)| *before)
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(path, source).unwrap();
        }
        let prepared = prepare(&root).unwrap();
        assert_ne!(prepared, binary);
        assert_eq!(prepare(&root).unwrap(), prepared);
        let directory = prepared.parent().unwrap().parent().unwrap();
        for (file, before, after) in PATCHES {
            assert!(fs::read_to_string(original.join(file))
                .unwrap()
                .contains(before));
            assert!(fs::read_to_string(directory.join(file))
                .unwrap()
                .contains(after));
        }
        for (file, preload) in PRELOADS {
            assert!(fs::read_to_string(directory.join(file))
                .unwrap()
                .starts_with(&format!("import {preload:?};")));
        }
        assert_eq!(
            fs::read_to_string(directory.join("session.cjs")).unwrap(),
            include_str!("session.cjs")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
