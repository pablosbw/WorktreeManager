//! The default extensions from WorktreeManager's settings. Before a workspace's editor server
//! starts, the missing ones are installed into the shared extensions folder from the editor's
//! marketplace (Open VSX). Nothing is uninstalled, and a failed install never blocks the editor.

use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use super::runtime;

#[derive(Default)]
pub struct Defaults {
    wanted: Mutex<Vec<String>>,
    /// Serializes installs, which share the extensions folder and the installer's process.
    installing: Mutex<()>,
    pub installer: runtime::Installation,
}

impl Defaults {
    pub fn set(&self, ids: Vec<String>) -> Result<(), String> {
        if let Some(invalid) = ids.iter().find(|id| !valid(id)) {
            return Err(format!("Not an extension ID: {invalid}"));
        }
        *self.wanted.lock().unwrap() = ids;
        Ok(())
    }

    /// Installs the missing extensions before a server starts, logging a failure instead of
    /// failing the start.
    pub fn prepare(&self, binary: &Path, root: &Path, user_data: &Path) {
        if let Err(error) = self.install(binary, root, user_data) {
            let message = format!("Default editor extensions were not installed: {error}");
            log::warn!("{message}");
        }
    }

    /// Installs the wanted extensions missing from `root`'s extensions folder with the editor
    /// at `binary`, logging to `extensions.log` beside that folder.
    fn install(&self, binary: &Path, root: &Path, user_data: &Path) -> Result<(), String> {
        let _installing = self.installing.lock().unwrap();
        let directory = root.join("extensions");
        let missing = missing(&directory, &self.wanted.lock().unwrap());
        if missing.is_empty() {
            return Ok(());
        }
        let mut command = runtime::command(binary);
        command
            .arg("--extensions-dir")
            .arg(&directory)
            .arg("--user-data-dir")
            .arg(user_data);
        for id in &missing {
            command.arg("--install-extension").arg(id);
        }
        runtime::scrub_environment(&mut command);
        runtime::run_checked(
            &mut command,
            &root.join("extensions.log"),
            Duration::from_secs(300),
            &self.installer,
        )
    }
}

/// `publisher.name`, as marketplaces name extensions. `--install-extension` also takes paths
/// and `.vsix` files, so anything else is refused.
fn valid(id: &str) -> bool {
    let part = |part: &str| {
        part.starts_with(|c: char| c.is_ascii_alphanumeric())
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    id.split_once('.')
        .is_some_and(|(publisher, name)| part(publisher) && part(name))
}

/// The `wanted` IDs absent from the folder's registry, compared without case like VS Code.
fn missing(directory: &Path, wanted: &[String]) -> Vec<String> {
    let installed: HashSet<String> = fs::read(directory.join("extensions.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(&bytes).ok())
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| entry["identifier"]["id"].as_str())
        .map(str::to_ascii_lowercase)
        .collect();
    wanted
        .iter()
        .filter(|id| !installed.contains(&id.to_ascii_lowercase()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).into()).collect()
    }

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(runtime::random_id().unwrap());
        fs::create_dir_all(root.join("extensions")).unwrap();
        root
    }

    #[test]
    fn only_marketplace_ids_are_accepted() {
        let defaults = Defaults::default();
        assert!(defaults
            .set(ids(&["rust-lang.rust-analyzer", "ms_python.Python3"]))
            .is_ok());
        for invalid in [
            "noperiod",
            "a.b.c",
            ".name",
            "publisher.",
            "-flag.name",
            "../x.vsix",
            "C:\\x.vsix",
        ] {
            assert_eq!(
                defaults.set(ids(&[invalid])),
                Err(format!("Not an extension ID: {invalid}"))
            );
        }
        assert_eq!(
            *defaults.wanted.lock().unwrap(),
            ids(&["rust-lang.rust-analyzer", "ms_python.Python3"])
        );
    }

    #[test]
    fn installed_extensions_are_matched_without_case_and_bad_registries_count_as_empty() {
        let root = root();
        let directory = root.join("extensions");
        let wanted = ids(&["Golang.Go", "redhat.vscode-yaml"]);
        assert_eq!(missing(&directory, &wanted), wanted);
        fs::write(directory.join("extensions.json"), "not json").unwrap();
        assert_eq!(missing(&directory, &wanted), wanted);
        fs::write(
            directory.join("extensions.json"),
            r#"[{"identifier":{"id":"golang.go"}},{"identifier":{}}]"#,
        )
        .unwrap();
        assert_eq!(missing(&directory, &wanted), ids(&["redhat.vscode-yaml"]));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nothing_runs_when_every_extension_is_installed() {
        let root = root();
        fs::write(
            root.join("extensions/extensions.json"),
            r#"[{"identifier":{"id":"golang.go"}}]"#,
        )
        .unwrap();
        let defaults = Defaults::default();
        defaults.set(ids(&["golang.go"])).unwrap();
        let binary = root.join("missing-editor");
        assert_eq!(defaults.install(&binary, &root, &root.join("data")), Ok(()));
        assert!(!root.join("extensions.log").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    fn editor(root: &Path, script: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let binary = root.join("code-server");
        fs::write(&binary, script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        binary
    }

    #[cfg(unix)]
    #[test]
    fn missing_extensions_install_in_one_run_into_the_shared_folder() {
        let root = root();
        let binary = editor(&root, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
        let defaults = Defaults::default();
        defaults
            .set(ids(&["golang.go", "redhat.vscode-yaml"]))
            .unwrap();
        let data = root.join("data");
        assert_eq!(defaults.install(&binary, &root, &data), Ok(()));
        let arguments = fs::read_to_string(root.join("extensions.log")).unwrap();
        let expected = [
            "--extensions-dir",
            &root.join("extensions").to_string_lossy(),
            "--user-data-dir",
            &data.to_string_lossy(),
            "--install-extension",
            "golang.go",
            "--install-extension",
            "redhat.vscode-yaml",
        ]
        .map(|argument| format!("{argument}\n"))
        .concat();
        assert_eq!(arguments, expected);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_install_reports_its_log() {
        let root = root();
        let binary = editor(&root, "#!/bin/sh\necho 'not found in Open VSX'\nexit 1\n");
        let defaults = Defaults::default();
        defaults.set(ids(&["unknown.extension"])).unwrap();
        let error = defaults
            .install(&binary, &root, &root.join("data"))
            .unwrap_err();
        assert!(error.contains("extensions.log"), "{error}");
        assert!(fs::read_to_string(root.join("extensions.log"))
            .unwrap()
            .contains("not found in Open VSX"));
        defaults.prepare(&binary, &root, &root.join("data"));
        fs::remove_dir_all(root).unwrap();
    }
}
