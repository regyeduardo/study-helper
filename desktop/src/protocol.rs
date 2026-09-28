use serde::{Deserialize, Serialize};

pub const PORT: u16 = 47811;
pub const SAMPLE_RATE: u32 = 48000;
pub const MICROPHONE: u8 = 0;
pub const SOURCE: u8 = 1;
pub const ALLOWED_ORIGIN: &str = "https://study.ryns.me";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    System,
    Window { pid: u32 },
    None,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Request {
    Hello,
    Sources,
    Start {
        source: Source,
        #[serde(default)]
        microphone: Option<String>,
    },
    Microphones,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Device {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowEntry {
    pub id: String,
    pub title: String,
    pub app: String,
    pub pid: u32,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Reply {
    Hello { version: String, os: String },
    Sources { listing: Listing, windows: Vec<WindowEntry> },
    Started { source: Source },
    Microphones { microphones: Vec<Device> },
    Stopped,
    Error { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Listing {
    Windows,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Programs,
}

pub fn origin_allowed(origin: &str) -> bool {
    if origin == ALLOWED_ORIGIN {
        return true;
    }
    ["http://localhost", "http://127.0.0.1"].iter().any(|base| {
        origin == *base
            || origin
                .strip_prefix(base)
                .and_then(|rest| rest.strip_prefix(':'))
                .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
    })
}

pub fn encode_frame(channel: u8, samples: &[f32]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + samples.len() * 4);
    frame.push(channel);
    for sample in samples {
        frame.extend_from_slice(&sample.to_le_bytes());
    }
    frame
}

#[cfg(any(test, target_os = "linux"))]
pub fn decode_samples(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_app_and_local_development() {
        assert!(origin_allowed("https://study.ryns.me"));
        assert!(origin_allowed("http://localhost:5182"));
        assert!(origin_allowed("http://127.0.0.1:5191"));
        assert!(origin_allowed("http://localhost"));
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("http://study.ryns.me"));
        assert!(!origin_allowed("https://study.ryns.me.evil.example"));
        assert!(!origin_allowed("http://localhost.evil.example"));
        assert!(!origin_allowed("http://localhost:"));
        assert!(!origin_allowed("http://localhost:80abc"));
        assert!(!origin_allowed(""));
    }

    #[test]
    fn frames_carry_the_channel_and_little_endian_floats() {
        let frame = encode_frame(SOURCE, &[0.5, -1.0]);
        assert_eq!(frame[0], SOURCE);
        assert_eq!(decode_samples(&frame[1..]), vec![0.5, -1.0]);
    }

    #[test]
    fn reads_the_requests_the_site_sends() {
        assert_eq!(serde_json::from_str::<Request>(r#"{"type":"hello"}"#).unwrap(), Request::Hello);
        assert_eq!(
            serde_json::from_str::<Request>(r#"{"type":"start","source":{"kind":"window","pid":42}}"#).unwrap(),
            Request::Start { source: Source::Window { pid: 42 }, microphone: None }
        );
        assert_eq!(
            serde_json::from_str::<Request>(r#"{"type":"start","source":{"kind":"system"},"microphone":"alsa_input.usb"}"#).unwrap(),
            Request::Start { source: Source::System, microphone: Some("alsa_input.usb".into()) }
        );
        assert_eq!(serde_json::from_str::<Request>(r#"{"type":"microphones"}"#).unwrap(), Request::Microphones);
    }

    #[test]
    fn writes_the_replies_the_site_reads() {
        let reply = Reply::Sources {
            listing: Listing::Windows,
            windows: vec![WindowEntry { id: "x11:1".into(), title: "Reunião".into(), app: "chrome".into(), pid: 7 }],
        };
        assert_eq!(
            serde_json::to_string(&reply).unwrap(),
            r#"{"type":"sources","listing":"windows","windows":[{"id":"x11:1","title":"Reunião","app":"chrome","pid":7}]}"#
        );
    }
}
