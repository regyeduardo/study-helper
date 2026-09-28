use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;

use wasapi::{get_default_device, initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};

use crate::protocol::{encode_frame, Listing, Source, WindowEntry, MICROPHONE, SAMPLE_RATE, SOURCE};

enum Endpoint {
    Microphone,
    System,
    Process(u32),
}

fn open(endpoint: &Endpoint) -> Result<AudioClient, String> {
    let client = match endpoint {
        Endpoint::Microphone => get_default_device(&Direction::Capture).and_then(|device| device.get_iaudioclient()),
        Endpoint::System => get_default_device(&Direction::Render).and_then(|device| device.get_iaudioclient()),
        Endpoint::Process(pid) => AudioClient::new_application_loopback_client(*pid, true),
    };
    client.map_err(|problem| problem.to_string())
}

fn stream(endpoint: Endpoint, channel: u8, frames: Sender<Vec<u8>>, stop: Arc<AtomicBool>, opened: Sender<Result<(), String>>) {
    let _ = initialize_mta().ok();
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE as usize, 2, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
    let prepared = open(&endpoint).and_then(|mut client| {
        client.initialize_client(&format, &Direction::Capture, &mode).map_err(|problem| problem.to_string())?;
        let event = client.set_get_eventhandle().map_err(|problem| problem.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|problem| problem.to_string())?;
        client.start_stream().map_err(|problem| problem.to_string())?;
        Ok((client, event, capture))
    });
    let (client, event, capture) = match prepared {
        Ok(parts) => {
            let _ = opened.send(Ok(()));
            parts
        }
        Err(message) => {
            let _ = opened.send(Err(message));
            return;
        }
    };
    let mut queue: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::SeqCst) {
        if event.wait_for_event(100).is_err() {
            continue;
        }
        while let Ok(Some(size)) = capture.get_next_packet_size() {
            if size == 0 || capture.read_from_device_to_deque(&mut queue).is_err() {
                break;
            }
        }
        let whole = queue.len() / 8 * 8;
        let bytes: Vec<u8> = queue.drain(..whole).collect();
        let mono: Vec<f32> = bytes
            .chunks_exact(8)
            .map(|pair| {
                let left = f32::from_le_bytes([pair[0], pair[1], pair[2], pair[3]]);
                let right = f32::from_le_bytes([pair[4], pair[5], pair[6], pair[7]]);
                (left + right) / 2.0
            })
            .collect();
        if !mono.is_empty() && frames.send(encode_frame(channel, &mono)).is_err() {
            break;
        }
    }
    let _ = client.stop_stream();
}

pub fn run(source: Source, frames: Sender<Vec<u8>>, stop: Arc<AtomicBool>, ready: Sender<Result<(), String>>) {
    let mut endpoints = vec![(Endpoint::Microphone, MICROPHONE)];
    match source {
        Source::System => endpoints.push((Endpoint::System, SOURCE)),
        Source::Window { pid } => endpoints.push((Endpoint::Process(pid), SOURCE)),
        Source::None => {}
    }
    let (opened, reports) = mpsc::channel();
    let threads: Vec<_> = endpoints
        .into_iter()
        .map(|(endpoint, channel)| {
            let (frames, stop, opened) = (frames.clone(), stop.clone(), opened.clone());
            std::thread::spawn(move || stream(endpoint, channel, frames, stop, opened))
        })
        .collect();
    let mut result = Ok(());
    for _ in 0..threads.len() {
        match reports.recv() {
            Ok(Ok(())) => {}
            Ok(Err(message)) => result = Err(message),
            Err(_) => result = Err("O som do computador não abriu.".into()),
        }
    }
    if result.is_err() {
        stop.store(true, Ordering::SeqCst);
    }
    let _ = ready.send(result);
    for thread in threads {
        let _ = thread.join();
    }
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let named = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(handle);
        if !named {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        path.rsplit('\\').next().unwrap_or_default().trim_end_matches(".exe").to_string()
    }
}

unsafe extern "system" fn collect(window: HWND, found: LPARAM) -> BOOL {
    let windows = unsafe { &mut *(found.0 as *mut Vec<WindowEntry>) };
    unsafe {
        if !IsWindowVisible(window).as_bool() || GetWindow(window, GW_OWNER).is_ok() {
            return true.into();
        }
        if GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
            return true.into();
        }
        let mut buffer = [0u16; 512];
        let length = GetWindowTextW(window, &mut buffer);
        if length <= 0 {
            return true.into();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return true.into();
        }
        let title = String::from_utf16_lossy(&buffer[..length as usize]);
        windows.push(WindowEntry { id: format!("hwnd:{}", window.0 as usize), title, app: process_name(pid), pid });
    }
    true.into()
}

pub fn list_sources() -> (Listing, Vec<WindowEntry>) {
    let mut windows: Vec<WindowEntry> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut windows as *mut Vec<WindowEntry> as isize));
    }
    (Listing::Windows, windows)
}
