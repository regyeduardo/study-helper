#![cfg_attr(windows, windows_subsystem = "windows")]

mod capture;
mod install;
#[cfg(target_os = "linux")]
mod mixer;
mod protocol;
mod server;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
mod windows_audio;

use std::net::TcpListener;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if !arguments.iter().any(|argument| argument == "--no-install") && install::install_and_relaunch() {
        return;
    }
    let Ok(listener) = TcpListener::bind(("127.0.0.1", protocol::PORT)) else { return };
    server::serve(listener);
}
