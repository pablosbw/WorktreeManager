use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};

use super::runtime::{random_id, write_new};

pub struct Profile {
    pub directory: PathBuf,
    pub password: String,
}

pub fn key(task_id: &str) -> String {
    format!("{:x}", md5::compute(task_id))
}

pub fn canonical_folders(folders: Vec<String>) -> Result<Vec<PathBuf>, String> {
    if folders.is_empty() {
        return Err("No folders to open".into());
    }
    folders
        .into_iter()
        .map(|folder| {
            let path = crate::platform::canonicalize(Path::new(&folder))
                .map_err(|error| format!("Cannot open {folder}: {error}"))?;
            if !path.is_dir() {
                return Err(format!("Not a folder: {folder}"));
            }
            Ok(path)
        })
        .collect()
}

/// A path as VS Code names it on the editor's server (a `vscode-remote` URI's path): the path
/// itself, or for a Windows path `C:\dir` the form VS Code gives remote Windows paths, `/c:/dir`.
pub fn server_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let bytes = text.as_bytes();
    if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":\\" {
        let drive = bytes[0].to_ascii_lowercase() as char;
        return format!("/{drive}{}", text[1..].replace('\\', "/"));
    }
    text.into_owned()
}

/// The local path a [`server_path`] names.
pub fn local_path(value: &str) -> PathBuf {
    local_path_on(value, cfg!(windows))
}

/// `/c:/dir` is `C:\dir` on Windows; elsewhere every value is already a local path.
fn local_path_on(value: &str, windows: bool) -> PathBuf {
    let bytes = value.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic();
    if windows && drive && bytes[2] == b':' && (bytes.len() == 3 || bytes[3] == b'/') {
        let letter = bytes[1].to_ascii_uppercase() as char;
        let rest = value[3..].replace('/', "\\");
        return PathBuf::from(format!(
            "{letter}:{}",
            if rest.is_empty() { "\\" } else { &rest }
        ));
    }
    PathBuf::from(value)
}

pub fn prepare(root: &Path, workspace_id: &str) -> Result<Profile, String> {
    let directory = root.join("workspaces").join(key(workspace_id));
    let user = directory.join("data/User");
    let preferences = root.join("preferences");
    fs::create_dir_all(&user)
        .and_then(|_| fs::create_dir_all(&preferences))
        .map_err(|error| error.to_string())?;
    let defaults = json!({
        "telemetry.telemetryLevel": "off",
        "chat.commandCenter.enabled": false,
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        "workbench.startupEditor": "none"
    });
    for (name, content) in [
        ("settings.json", defaults.to_string()),
        ("keybindings.json", "[]".into()),
    ] {
        let source = preferences.join(name);
        write_new(&source, content.as_bytes(), false)?;
        let target = user.join(name);
        if !target.try_exists().map_err(|error| error.to_string())? {
            crate::platform::shared_link(&source, &target).map_err(|error| error.to_string())?;
        }
        if !crate::platform::same_file(&target, &source) {
            return Err(format!(
                "Shared preferences were replaced at {}. Restore the link before reopening.",
                target.display()
            ));
        }
    }
    let password = random_id()?;
    let port_path = directory.join("port");
    let port = match fs::read_to_string(&port_path) {
        Ok(port) => port
            .trim()
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or("The saved editor port is invalid")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.to_string()),
    };
    let config = json!({
        "bind-addr":format!("127.0.0.1:{port}"), "auth":"password", "password":password,
        "cert":false, "cookie-suffix":format!("workspace-{}", key(workspace_id)), "disable-telemetry":true,
        "disable-update-check":true, "disable-proxy":true
    });
    let config_path = directory.join("config.yaml");
    write_new(&config_path, b"{}", true)?;
    fs::write(config_path, config.to_string()).map_err(|error| error.to_string())?;
    Ok(Profile {
        directory,
        password,
    })
}

pub fn task_workspace(root: &Path, task_id: &str, folders: &[PathBuf]) -> Result<PathBuf, String> {
    let directory = root.join("sessions").join(key(task_id));
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let workspace = directory.join("task.code-workspace");
    let document =
        json!({"folders": folders.iter().map(|path| json!({"path":path})).collect::<Vec<_>>()});
    if workspace.exists() {
        let mut previous: serde_json::Value =
            serde_json::from_slice(&fs::read(&workspace).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        if previous["folders"] == document["folders"] {
            return Ok(workspace);
        }
        if !stored_folders_match(&previous["folders"], &directory, folders) {
            return Err("This editor profile belongs to different folders. Its workspace cannot be switched while restoring the task.".into());
        }
        previous["folders"] = document["folders"].clone();
        replace_file(&workspace, previous.to_string().as_bytes())?;
    } else {
        fs::write(&workspace, document.to_string()).map_err(|error| error.to_string())?;
    }
    Ok(workspace)
}

fn stored_folders_match(stored: &serde_json::Value, base: &Path, expected: &[PathBuf]) -> bool {
    let Some(entries) = stored.as_array() else {
        return false;
    };
    entries.len() == expected.len()
        && entries.iter().zip(expected).all(|(entry, expected)| {
            entry["path"]
                .as_str()
                .is_some_and(|path| resolved_folder(&base.join(path)) == resolved_folder(expected))
        })
}

fn resolved_folder(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn replace_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let staging = path.with_extension("code-workspace.tmp");
    fs::write(&staging, content)
        .and_then(|_| fs::rename(&staging, path))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_round_trip_through_vs_code_server_paths() {
        assert_eq!(
            server_path(Path::new(r"C:\Users\me\task.code-workspace")),
            "/c:/Users/me/task.code-workspace"
        );
        assert_eq!(server_path(Path::new("/repos/a")), "/repos/a");
        assert_eq!(server_path(Path::new("C:relative")), "C:relative");
        assert_eq!(
            local_path_on("/c:/Users/me", true),
            PathBuf::from(r"C:\Users\me")
        );
        assert_eq!(local_path_on("/c:", true), PathBuf::from(r"C:\"));
        assert_eq!(
            local_path_on("/c:/Users", false),
            PathBuf::from("/c:/Users")
        );
        assert_eq!(local_path_on("/cd/Users", true), PathBuf::from("/cd/Users"));
        assert_eq!(local_path("/repos/a"), PathBuf::from("/repos/a"));
    }

    #[test]
    fn workspace_profiles_share_preferences_and_keep_separate_global_state() {
        let root = std::env::temp_dir().join(random_id().unwrap());
        let first = prepare(&root, "../one").unwrap();
        let second = prepare(&root, "two").unwrap();
        assert_ne!(first.directory, second.directory);
        assert!(first.directory.starts_with(root.join("workspaces")));
        assert_ne!(first.password, second.password);
        fs::write(
            first.directory.join("data/User/settings.json"),
            "{\"editor.fontSize\":18}",
        )
        .unwrap();
        assert_eq!(
            fs::read(second.directory.join("data/User/settings.json")).unwrap(),
            b"{\"editor.fontSize\":18}"
        );
        fs::write(first.directory.join("data/User/state.db"), "one").unwrap();
        fs::write(first.directory.join("port"), "53172").unwrap();
        let resumed = prepare(&root, "../one").unwrap();
        assert_eq!(
            fs::read(resumed.directory.join("data/User/state.db")).unwrap(),
            b"one"
        );
        assert!(!second.directory.join("data/User/state.db").exists());
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(resumed.directory.join("config.yaml")).unwrap())
                .unwrap();
        assert_eq!(config["bind-addr"], "127.0.0.1:53172");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tasks_keep_stable_workspaces_and_preserve_user_settings() {
        let root = std::env::temp_dir().join(random_id().unwrap());
        let first = task_workspace(&root, "a", &["/a".into(), "/b".into()]).unwrap();
        let second = task_workspace(&root, "b", &["/c".into()]).unwrap();
        assert_ne!(first, second);
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&first).unwrap()).unwrap();
        document["settings"] = json!({"editor.fontSize": 18});
        fs::write(&first, document.to_string()).unwrap();
        assert_eq!(
            task_workspace(&root, "a", &["/a".into(), "/b".into()]).unwrap(),
            first
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&first).unwrap()).unwrap(),
            document
        );
        assert!(task_workspace(&root, "a", &["/other".into()]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    fn task_workspace_with_relative_folders(
        root: &Path,
        task_id: &str,
        folders: &[PathBuf],
    ) -> PathBuf {
        let workspace = task_workspace(root, task_id, folders).unwrap();
        let directory = workspace.parent().unwrap();
        let relative = |folder: &PathBuf| {
            let depth = directory.strip_prefix(root).unwrap().components().count();
            let mut path = PathBuf::from("..");
            for _ in 1..depth {
                path.push("..");
            }
            path.join(folder.strip_prefix(root).unwrap())
        };
        let document = json!({
            "folders": folders.iter().map(|folder| json!({"path": relative(folder)})).collect::<Vec<_>>(),
            "settings": {"editor.fontSize": 18}
        });
        fs::write(&workspace, document.to_string()).unwrap();
        workspace
    }

    fn task_folders(root: &Path, names: &[&str]) -> Vec<PathBuf> {
        names
            .iter()
            .map(|name| {
                let folder = root.join(name);
                fs::create_dir_all(&folder).unwrap();
                fs::canonicalize(folder).unwrap()
            })
            .collect()
    }

    #[test]
    fn task_workspace_rewritten_with_relative_folders_reopens_with_absolute_folders() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(random_id().unwrap());
        let folders = task_folders(&root, &["repo-one", "repo-two"]);
        let workspace = task_workspace_with_relative_folders(&root, "a", &folders);

        assert_eq!(task_workspace(&root, "a", &folders).unwrap(), workspace);

        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&workspace).unwrap()).unwrap();
        assert_eq!(
            document,
            json!({
                "folders": folders.iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
                "settings": {"editor.fontSize": 18}
            })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_workspace_with_relative_folders_rejects_different_folders() {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(random_id().unwrap());
        let folders = task_folders(&root, &["repo-one", "repo-two"]);
        let workspace = task_workspace_with_relative_folders(&root, "a", &folders);
        let before = fs::read(&workspace).unwrap();

        let other = task_folders(&root, &["repo-one", "repo-three"]);
        assert!(task_workspace(&root, "a", &other).is_err());
        assert!(task_workspace(&root, "a", &folders[..1]).is_err());
        assert_eq!(fs::read(&workspace).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_workspace_with_malformed_folders_is_rejected() {
        let root = std::env::temp_dir().join(random_id().unwrap());
        let folders = task_folders(&root, &["repo-one"]);
        let workspace = task_workspace(&root, "a", &folders).unwrap();
        fs::write(
            &workspace,
            json!({"folders": [{"uri": "file:///repo-one"}]}).to_string(),
        )
        .unwrap();

        assert!(task_workspace(&root, "a", &folders).is_err());
        fs::write(&workspace, json!({"folders": "repo-one"}).to_string()).unwrap();
        assert!(task_workspace(&root, "a", &folders).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
