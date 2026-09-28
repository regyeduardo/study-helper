use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

use tungstenite::handshake::server::{ErrorResponse, Request as Handshake, Response};
use tungstenite::http::StatusCode;
use tungstenite::{accept_hdr, Error, Message};

use crate::capture::{list_sources, os_name, Capture};
use crate::protocol::{origin_allowed, Reply, Request};

pub fn serve(listener: TcpListener) {
    for stream in listener.incoming().flatten() {
        std::thread::spawn(move || handle(stream));
    }
}

fn check_origin(request: &Handshake, response: Response) -> Result<Response, ErrorResponse> {
    let origin = request.headers().get("origin").and_then(|value| value.to_str().ok()).unwrap_or("");
    if origin_allowed(origin) {
        return Ok(response);
    }
    let mut refusal = ErrorResponse::new(Some("origin not allowed".into()));
    *refusal.status_mut() = StatusCode::FORBIDDEN;
    Err(refusal)
}

fn reply(socket: &mut tungstenite::WebSocket<TcpStream>, message: &Reply) -> bool {
    let text = serde_json::to_string(message).unwrap_or_default();
    socket.send(Message::text(text)).is_ok()
}

fn handle(stream: TcpStream) {
    let Ok(mut socket) = accept_hdr(stream, check_origin) else { return };
    let _ = socket.get_ref().set_read_timeout(Some(Duration::from_millis(10)));
    let (frames, received) = mpsc::channel::<Vec<u8>>();
    let mut capture: Option<Capture> = None;
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let answer = match serde_json::from_str::<Request>(text.as_str()) {
                    Ok(Request::Hello) => Reply::Hello { version: env!("CARGO_PKG_VERSION").into(), os: os_name().into() },
                    Ok(Request::Sources) => {
                        let (listing, windows) = list_sources();
                        Reply::Sources { listing, windows }
                    }
                    Ok(Request::Start { source }) => {
                        capture = None;
                        while received.try_recv().is_ok() {}
                        match Capture::start(source.clone(), frames.clone()) {
                            Ok(started) => {
                                capture = Some(started);
                                Reply::Started { source }
                            }
                            Err(message) => Reply::Error { message },
                        }
                    }
                    Ok(Request::Stop) => {
                        capture = None;
                        Reply::Stopped
                    }
                    Err(problem) => Reply::Error { message: problem.to_string() },
                };
                if !reply(&mut socket, &answer) {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(Error::Io(problem)) if matches!(problem.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
        while let Ok(frame) = received.try_recv() {
            if capture.is_some() && socket.send(Message::binary(frame)).is_err() {
                return;
            }
        }
    }
}
