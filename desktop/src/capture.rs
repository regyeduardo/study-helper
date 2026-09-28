use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::protocol::{Listing, Source, WindowEntry};

#[cfg(target_os = "linux")]
use crate::linux as platform;
#[cfg(windows)]
use crate::windows_audio as platform;

pub struct Capture {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    pub fn start(source: Source, frames: Sender<Vec<u8>>) -> Result<Capture, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let (ready, started) = mpsc::channel();
        let flag = stop.clone();
        let thread = std::thread::spawn(move || platform::run(source, frames, flag, ready));
        let capture = Capture { stop, thread: Some(thread) };
        match started.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(capture),
            Ok(Err(message)) => Err(message),
            Err(_) => Err("O som do computador não respondeu.".into()),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn list_sources() -> (Listing, Vec<WindowEntry>) {
    platform::list_sources()
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}
