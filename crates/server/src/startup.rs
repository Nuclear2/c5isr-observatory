use std::{
    env, io,
    path::{Path, PathBuf},
};

pub struct Resources {
    pub root: PathBuf,
    pub portable: bool,
}

impl Resources {
    pub fn locate() -> io::Result<Self> {
        let executable = env::current_exe()?;
        Self::beside(executable.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Executable directory is missing.")
        })?)
    }

    fn beside(directory: &Path) -> io::Result<Self> {
        if directory.join("dist").is_dir() {
            if !directory.join("dist/index.html").is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "Missing dist/index.html. Please extract the entire release ZIP.",
                ));
            }
            return Ok(Self {
                root: directory.to_owned(),
                portable: true,
            });
        }
        // Cargo builds normally live under the workspace's target directory.
        // Resolve from the executable so a source build also runs from another cwd.
        let workspace = workspace_containing(directory).or_else(|| {
            // A custom Cargo target directory may be outside the workspace.
            // Only an actual Cargo profile directory (or its deps directory)
            // may use the source tree under which cargo run/test was invoked.
            let cargo_output = directory
                .ancestors()
                .take(2)
                .any(|dir| dir.join(".cargo-lock").is_file());
            if cargo_output {
                workspace_containing(&env::current_dir().ok()?)
            } else {
                None
            }
        });
        workspace
            .map(|root| Self {
                root,
                portable: false,
            })
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "Application files are missing. Please extract the entire release ZIP.",
                )
            })
    }
}

fn workspace_containing(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|ancestor| {
            ancestor.join("crates/server/Cargo.toml").is_file()
                && ancestor.join("scripts/codex-bridge.mjs").is_file()
        })
        .map(Path::to_owned)
}

#[cfg(windows)]
pub fn open_browser(url: &str) -> io::Result<()> {
    use std::ptr::null;

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            window: isize,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the null-terminated URL lives through the call. Windows selects
    // its registered HTTP handler; no command shell parses the query string.
    let result = unsafe { ShellExecuteW(0, null(), url.as_ptr(), null(), null(), 1) };
    if result > 32 {
        Ok(())
    } else {
        Err(io::Error::other(format!("ShellExecuteW returned {result}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_files_take_precedence_over_workspace_ancestors() {
        let workspace = Resources::locate().unwrap();
        assert!(!workspace.portable);
        assert!(workspace.root.join("crates/server/Cargo.toml").is_file());

        let executable = env::current_exe().unwrap();
        let folder = executable
            .parent()
            .unwrap()
            .join(format!("portable test {}", std::process::id()));
        let dist = folder.join("dist");
        let index = dist.join("index.html");
        std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(&dist).unwrap();
        assert!(Resources::beside(&folder).is_err());
        std::fs::write(&index, "fixture").unwrap();
        let located = Resources::beside(&folder).unwrap();
        std::fs::remove_file(index).unwrap();
        std::fs::remove_dir(dist).unwrap();
        std::fs::remove_dir(&folder).unwrap();
        assert_eq!(located.root, folder);
        assert!(located.portable);
    }

    #[test]
    fn external_cargo_target_can_use_source_working_directory() {
        let folder = env::temp_dir().join(format!("c5isr-cargo-target-{}", std::process::id()));
        let lock = folder.join(".cargo-lock");
        std::fs::create_dir(&folder).unwrap();
        let standalone = Resources::beside(&folder);
        std::fs::write(&lock, "").unwrap();
        let cargo = Resources::beside(&folder);
        std::fs::remove_file(lock).unwrap();
        std::fs::remove_dir(folder).unwrap();
        assert!(standalone.is_err());
        let resources = cargo.unwrap();
        assert!(!resources.portable);
        assert_eq!(
            Some(resources.root),
            workspace_containing(&env::current_dir().unwrap())
        );
    }
}
