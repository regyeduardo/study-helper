use std::path::{Path, PathBuf};
use std::process::Command;

const NAME: &str = "study-helper-audio";

#[cfg(target_os = "linux")]
fn running_copy() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from)
}

#[cfg(windows)]
fn running_copy() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

#[cfg(target_os = "linux")]
fn installed_copy() -> Option<PathBuf> {
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".local/share")))?;
    Some(data.join(NAME).join(format!("{NAME}.AppImage")))
}

#[cfg(windows)]
fn installed_copy() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| Path::new(&base).join("StudyHelperAudio").join(format!("{NAME}.exe")))
}

#[cfg(target_os = "linux")]
fn start_with_login(installed: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(installed, std::fs::Permissions::from_mode(0o755))?;
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".config")))
        .ok_or_else(|| std::io::Error::other("no home"))?;
    let autostart = config.join("autostart");
    std::fs::create_dir_all(&autostart)?;
    std::fs::write(autostart.join(format!("{NAME}.desktop")), desktop_entry(installed))
}

#[cfg(windows)]
fn start_with_login(installed: &Path) -> std::io::Result<()> {
    let run = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")?.0;
    run.set_value("StudyHelperAudio", &format!("\"{}\"", installed.display()))
}

#[cfg(target_os = "linux")]
pub fn desktop_entry(installed: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Study Helper Áudio\nComment=Grava o som do computador e o microfone para o Study Helper\nExec=\"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        installed.display()
    )
}

pub fn install_and_relaunch() -> bool {
    let (Some(running), Some(installed)) = (running_copy(), installed_copy()) else { return false };
    if running == installed {
        return false;
    }
    let copied = installed
        .parent()
        .map(std::fs::create_dir_all)
        .transpose()
        .and_then(|_| std::fs::copy(&running, &installed).map(|_| ()))
        .and_then(|_| start_with_login(&installed));
    if copied.is_err() {
        return false;
    }
    Command::new(&installed).spawn().is_ok()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn the_login_entry_runs_the_installed_copy() {
        let entry = desktop_entry(Path::new("/home/pessoa/.local/share/study-helper-audio/study-helper-audio.AppImage"));
        assert!(entry.starts_with("[Desktop Entry]\n"));
        assert!(entry.contains("Exec=\"/home/pessoa/.local/share/study-helper-audio/study-helper-audio.AppImage\"\n"));
        assert!(entry.contains("Terminal=false\n"));
    }
}
