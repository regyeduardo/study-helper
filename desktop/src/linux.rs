use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Duration;

use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::introspect::SinkInputInfo;
use libpulse_binding::context::subscribe::{Facility, InterestMaskSet, Operation as Change};
use libpulse_binding::context::{Context, FlagSet as ContextFlags, State as ContextState};
use libpulse_binding::def::BufferAttr;
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::proplist::Proplist;
use libpulse_binding::sample::{Format, Spec};
use libpulse_binding::stream::{FlagSet as StreamFlags, PeekResult, Stream};
use x11rb::connection::Connection;
use x11rb::protocol::res::{ClientIdMask, ClientIdSpec, ConnectionExt as ResExt};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt};

use crate::mixer::Lanes;
use crate::protocol::{decode_samples, encode_frame, Listing, Source, WindowEntry, MICROPHONE, SAMPLE_RATE, SOURCE};

const SYSTEM_LANE: u64 = 1;
const FIRST_PROGRAM_LANE: u64 = 2;

struct Pulse {
    context: Rc<RefCell<Context>>,
    mainloop: Mainloop,
}

impl Drop for Pulse {
    fn drop(&mut self) {
        self.context.borrow_mut().disconnect();
    }
}

#[derive(Clone)]
struct Played {
    index: u32,
    client: Option<u32>,
    pid: Option<u32>,
    binary: Option<String>,
}

struct Target {
    pid: u32,
    binary: Option<String>,
}

impl Target {
    fn owns(&self, played: &Played) -> bool {
        if played.pid.is_some_and(|pid| process_tree(self.pid).contains(&pid)) {
            return true;
        }
        matches!((&self.binary, &played.binary), (Some(mine), Some(theirs)) if mine == theirs)
    }
}

fn connect() -> Result<Pulse, String> {
    let mut mainloop = Mainloop::new().ok_or("O som do computador não abriu.")?;
    let mut context = Context::new(&mainloop, "Study Helper").ok_or("O som do computador não abriu.")?;
    context.connect(None, ContextFlags::NOFLAGS, None).map_err(|problem| format!("O som do computador não abriu: {problem:?}"))?;
    loop {
        if !matches!(mainloop.iterate(true), IterateResult::Success(_)) {
            return Err("O som do computador parou.".into());
        }
        match context.get_state() {
            ContextState::Ready => break,
            ContextState::Failed | ContextState::Terminated => return Err("O som do computador recusou a conexão.".into()),
            _ => {}
        }
    }
    Ok(Pulse { context: Rc::new(RefCell::new(context)), mainloop })
}

fn wait(pulse: &mut Pulse, done: &Cell<bool>) {
    while !done.get() {
        if !matches!(pulse.mainloop.iterate(true), IterateResult::Success(_)) {
            return;
        }
    }
}

fn read_pid(proplist: &Proplist) -> Option<u32> {
    proplist.get_str("application.process.id").and_then(|pid| pid.parse().ok())
}

fn played_from(info: &SinkInputInfo) -> Played {
    Played { index: info.index, client: info.client, pid: read_pid(&info.proplist), binary: info.proplist.get_str("application.process.binary") }
}

fn with_client_owner(pulse: &mut Pulse, mut played: Vec<Played>) -> Vec<Played> {
    if played.iter().all(|entry| entry.pid.is_some() || entry.client.is_none()) {
        return played;
    }
    let owners: Rc<RefCell<HashMap<u32, (Option<u32>, Option<String>)>>> = Rc::new(RefCell::new(HashMap::new()));
    let done = Rc::new(Cell::new(false));
    let (into, finished) = (owners.clone(), done.clone());
    let _operation = pulse.context.borrow().introspect().get_client_info_list(move |result| match result {
        ListResult::Item(info) => {
            into.borrow_mut().insert(info.index, (read_pid(&info.proplist), info.proplist.get_str("application.process.binary")));
        }
        _ => finished.set(true),
    });
    wait(pulse, &done);
    let owners = owners.borrow();
    for entry in played.iter_mut().filter(|entry| entry.pid.is_none()) {
        if let Some((pid, binary)) = entry.client.and_then(|client| owners.get(&client)) {
            entry.pid = *pid;
            entry.binary = entry.binary.take().or_else(|| binary.clone());
        }
    }
    played
}

fn played_now(pulse: &mut Pulse) -> Vec<Played> {
    let found = Rc::new(RefCell::new(Vec::new()));
    let done = Rc::new(Cell::new(false));
    let (into, finished) = (found.clone(), done.clone());
    let _operation = pulse.context.borrow().introspect().get_sink_input_info_list(move |result| match result {
        ListResult::Item(info) => into.borrow_mut().push(played_from(info)),
        _ => finished.set(true),
    });
    wait(pulse, &done);
    let list = found.borrow().clone();
    list
}

fn parent_of(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = &stat[stat.rfind(')')? + 1..];
    after_name.split_whitespace().nth(1)?.parse().ok()
}

pub fn process_tree(root: u32) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            if let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) {
                if let Some(parent) = parent_of(pid) {
                    children.entry(parent).or_default().push(pid);
                }
            }
        }
    }
    let mut tree = HashSet::from([root]);
    let mut pending = vec![root];
    while let Some(pid) = pending.pop() {
        for child in children.get(&pid).into_iter().flatten() {
            if tree.insert(*child) {
                pending.push(*child);
            }
        }
    }
    tree
}

fn binary_of(pid: u32) -> Option<String> {
    let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    path.file_name().map(|name| name.to_string_lossy().into_owned())
}

fn record(
    pulse: &Pulse,
    name: &str,
    device: Option<&str>,
    monitored: Option<u32>,
    lanes: Rc<RefCell<[Lanes; 2]>>,
    channel: u8,
    lane: u64,
) -> Result<Rc<RefCell<Stream>>, String> {
    let spec = Spec { format: Format::F32le, channels: 1, rate: SAMPLE_RATE };
    let stream = Stream::new(&mut pulse.context.borrow_mut(), name, &spec, None).ok_or("Não deu para abrir o som.")?;
    let stream = Rc::new(RefCell::new(stream));
    if let Some(index) = monitored {
        stream.borrow_mut().set_monitor_stream(index).map_err(|problem| format!("{problem:?}"))?;
    }
    let reader = Rc::downgrade(&stream);
    stream.borrow_mut().set_read_callback(Some(Box::new(move |_| {
        let Some(stream) = reader.upgrade() else { return };
        let Ok(mut stream) = stream.try_borrow_mut() else { return };
        loop {
            let samples = match stream.peek() {
                Ok(PeekResult::Data(bytes)) => decode_samples(bytes),
                Ok(PeekResult::Hole(_)) => Vec::new(),
                _ => break,
            };
            lanes.borrow_mut()[channel as usize].push(lane, &samples);
            if stream.discard().is_err() {
                break;
            }
        }
    })));
    let attr = BufferAttr { maxlength: u32::MAX, tlength: u32::MAX, prebuf: u32::MAX, minreq: u32::MAX, fragsize: SAMPLE_RATE / 50 * 4 };
    stream
        .borrow_mut()
        .connect_record(device, Some(&attr), StreamFlags::ADJUST_LATENCY)
        .map_err(|problem| format!("Não deu para gravar {name}: {problem:?}"))?;
    Ok(stream)
}

pub fn run(source: Source, frames: Sender<Vec<u8>>, stop: Arc<AtomicBool>, ready: Sender<Result<(), String>>) {
    let mut pulse = match connect() {
        Ok(pulse) => pulse,
        Err(message) => {
            let _ = ready.send(Err(message));
            return;
        }
    };
    let lanes: Rc<RefCell<[Lanes; 2]>> = Rc::new(RefCell::new([Lanes::default(), Lanes::default()]));
    let mut streams: HashMap<u64, Rc<RefCell<Stream>>> = HashMap::new();
    match record(&pulse, "Microfone", None, None, lanes.clone(), MICROPHONE, 0) {
        Ok(stream) => {
            streams.insert(0, stream);
        }
        Err(message) => {
            let _ = ready.send(Err(message));
            return;
        }
    }
    if source == Source::System {
        match record(&pulse, "Som do computador", Some("@DEFAULT_MONITOR@"), None, lanes.clone(), SOURCE, SYSTEM_LANE) {
            Ok(stream) => {
                streams.insert(SYSTEM_LANE, stream);
            }
            Err(message) => {
                let _ = ready.send(Err(message));
                return;
            }
        }
    }
    let target = match source {
        Source::Window { pid } => Some(Target { pid, binary: binary_of(pid) }),
        _ => None,
    };
    let changes: Rc<RefCell<Vec<(bool, u32)>>> = Rc::new(RefCell::new(Vec::new()));
    let arrived: Rc<RefCell<Vec<Played>>> = Rc::new(RefCell::new(Vec::new()));
    if target.is_some() {
        let noted = changes.clone();
        pulse.context.borrow_mut().set_subscribe_callback(Some(Box::new(move |facility, change, index| {
            if facility == Some(Facility::SinkInput) {
                match change {
                    Some(Change::New) => noted.borrow_mut().push((true, index)),
                    Some(Change::Removed) => noted.borrow_mut().push((false, index)),
                    _ => {}
                }
            }
        })));
        let _ = pulse.context.borrow_mut().subscribe(InterestMaskSet::SINK_INPUT, |_| {});
        arrived.borrow_mut().extend(played_now(&mut pulse));
    }
    let _ = ready.send(Ok(()));
    while !stop.load(Ordering::SeqCst) {
        if matches!(pulse.mainloop.iterate(false), IterateResult::Quit(_) | IterateResult::Err(_)) {
            break;
        }
        let noted: Vec<(bool, u32)> = changes.borrow_mut().drain(..).collect();
        for (added, index) in noted {
            let lane = FIRST_PROGRAM_LANE + index as u64;
            if added {
                let into = arrived.clone();
                let _operation = pulse.context.borrow().introspect().get_sink_input_info(index, move |result| {
                    if let ListResult::Item(info) = result {
                        into.borrow_mut().push(played_from(info));
                    }
                });
            } else if let Some(stream) = streams.remove(&lane) {
                let _ = stream.borrow_mut().disconnect();
                lanes.borrow_mut()[SOURCE as usize].remove(lane);
            }
        }
        let candidates: Vec<Played> = arrived.borrow_mut().drain(..).collect();
        let candidates = with_client_owner(&mut pulse, candidates);
        if let Some(target) = &target {
            for played in candidates {
                let lane = FIRST_PROGRAM_LANE + played.index as u64;
                if streams.contains_key(&lane) || !target.owns(&played) {
                    continue;
                }
                if let Ok(stream) = record(&pulse, "Som da janela", None, Some(played.index), lanes.clone(), SOURCE, lane) {
                    streams.insert(lane, stream);
                }
            }
        }
        let drained = {
            let mut lanes = lanes.borrow_mut();
            [lanes[0].drain(), lanes[1].drain()]
        };
        for (channel, samples) in [(MICROPHONE, &drained[0]), (SOURCE, &drained[1])] {
            if !samples.is_empty() && frames.send(encode_frame(channel, samples)).is_err() {
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    for stream in streams.values() {
        let _ = stream.borrow_mut().disconnect();
    }
}

fn x11_windows() -> Result<Vec<WindowEntry>, String> {
    let (connection, screen) = x11rb::connect(None).map_err(|problem| problem.to_string())?;
    let root = connection.setup().roots[screen].root;
    let atom = |name: &str| -> Result<u32, String> {
        Ok(connection
            .intern_atom(false, name.as_bytes())
            .map_err(|problem| problem.to_string())?
            .reply()
            .map_err(|problem| problem.to_string())?
            .atom)
    };
    let (client_list, wm_name, utf8, wm_pid) = (atom("_NET_CLIENT_LIST")?, atom("_NET_WM_NAME")?, atom("UTF8_STRING")?, atom("_NET_WM_PID")?);
    let (window_type, dock, desktop) = (atom("_NET_WM_WINDOW_TYPE")?, atom("_NET_WM_WINDOW_TYPE_DOCK")?, atom("_NET_WM_WINDOW_TYPE_DESKTOP")?);
    let property = |window: u32, name: u32, kind: u32, length: u32| {
        connection.get_property(false, window, name, kind, 0, length).ok().and_then(|cookie| cookie.reply().ok())
    };
    let ids: Vec<u32> = property(root, client_list, AtomEnum::WINDOW.into(), u32::MAX)
        .and_then(|reply| reply.value32().map(|values| values.collect()))
        .unwrap_or_default();
    let own = std::process::id();
    let mut windows = Vec::new();
    for id in ids {
        let published = property(id, wm_pid, AtomEnum::CARDINAL.into(), 1).and_then(|reply| reply.value32().and_then(|mut values| values.next()));
        let Some(pid) = published.or_else(|| {
            connection
                .res_query_client_ids(&[ClientIdSpec { client: id, mask: ClientIdMask::LOCAL_CLIENT_PID }])
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .and_then(|reply| reply.ids.into_iter().find_map(|found| found.value.first().copied()))
        }) else {
            continue;
        };
        let mut title = property(id, wm_name, utf8, 1024).map(|reply| String::from_utf8_lossy(&reply.value).into_owned()).unwrap_or_default();
        if title.is_empty() {
            title = property(id, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into(), 1024)
                .map(|reply| String::from_utf8_lossy(&reply.value).into_owned())
                .unwrap_or_default();
        }
        let app = property(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into(), 1024)
            .map(|reply| String::from_utf8_lossy(&reply.value).split('\0').filter(|part| !part.is_empty()).last().unwrap_or_default().to_string())
            .unwrap_or_default();
        let kinds: Vec<u32> = property(id, window_type, AtomEnum::ATOM.into(), 16).and_then(|reply| reply.value32().map(|values| values.collect())).unwrap_or_default();
        if pid == own || title.trim().is_empty() || kinds.iter().any(|kind| *kind == dock || *kind == desktop) {
            continue;
        }
        windows.push(WindowEntry { id: format!("x11:{id}"), title, app, pid });
    }
    Ok(windows)
}

fn programs() -> Vec<WindowEntry> {
    let Ok(mut pulse) = connect() else { return Vec::new() };
    let found: Rc<RefCell<Vec<(u32, String)>>> = Rc::new(RefCell::new(Vec::new()));
    let done = Rc::new(Cell::new(false));
    let (into, finished) = (found.clone(), done.clone());
    let _operation = pulse.context.borrow().introspect().get_client_info_list(move |result| match result {
        ListResult::Item(info) => {
            if let Some(pid) = read_pid(&info.proplist) {
                let name = info.proplist.get_str("application.name").or_else(|| info.proplist.get_str("application.process.binary")).unwrap_or_default();
                into.borrow_mut().push((pid, name));
            }
        }
        _ => finished.set(true),
    });
    wait(&mut pulse, &done);
    let own = std::process::id();
    let mut seen = HashSet::new();
    let list = found.borrow().clone();
    list.into_iter()
        .filter(|(pid, name)| *pid != own && !name.is_empty() && seen.insert(*pid))
        .map(|(pid, name)| WindowEntry { id: format!("pulse:{pid}"), title: name.clone(), app: binary_of(pid).unwrap_or(name), pid })
        .collect()
}

pub fn list_sources() -> (Listing, Vec<WindowEntry>) {
    let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind == "wayland");
    if !wayland {
        if let Ok(windows) = x11_windows() {
            return (Listing::Windows, windows);
        }
    }
    (Listing::Programs, programs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_tree_holds_the_process_and_its_children() {
        let mut child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        let tree = process_tree(std::process::id());
        assert!(tree.contains(&std::process::id()));
        assert!(tree.contains(&child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn a_program_owns_the_sound_of_its_children_or_of_the_same_binary() {
        let mut child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        let target = Target { pid: std::process::id(), binary: Some("chrome".into()) };
        assert!(target.owns(&Played { index: 1, client: None, pid: Some(child.id()), binary: None }));
        assert!(target.owns(&Played { index: 2, client: None, pid: Some(1), binary: Some("chrome".into()) }));
        assert!(!target.owns(&Played { index: 3, client: None, pid: Some(1), binary: Some("firefox".into()) }));
        let _ = child.kill();
        let _ = child.wait();
    }
}
