use anyhow::{anyhow, Result};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::env;
use std::fs;
use std::time::{Duration, Instant};
use uuid::Uuid;

const LSP_COMM_TARGET: &str = "positron.lsp";
const DEFAULT_TIMEOUT_MS: u64 = 15000;
const IDS_DELIMITER: &str = "<IDS|MSG>";
const SUPPORTED_SIGNATURE_SCHEME: &str = "hmac-sha256";

#[derive(Debug, Deserialize)]
struct ConnectionInfo {
    shell_port: u16,
    iopub_port: u16,
    stdin_port: u16,
    control_port: u16,
    hb_port: u16,
    ip: String,
    key: String,
    transport: String,
    signature_scheme: String,
}

#[derive(Debug)]
struct Args {
    connection_file: String,
    ip_address: String,
    timeout_ms: u64,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("Ark sidecar error: {err}");
        let payload = json!({
            "event": "error",
            "message": err.to_string(),
        });
        println!("{payload}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args = parse_args()?;
    let connection = read_connection(&args.connection_file)?;

    if connection.signature_scheme != SUPPORTED_SIGNATURE_SCHEME {
        return Err(anyhow!(
            "Unsupported signature scheme: {}",
            connection.signature_scheme
        ));
    }

    let ctx = zmq::Context::new();
    let shell = ctx.socket(zmq::DEALER)?;
    let identity = Uuid::new_v4().to_string();
    shell.set_identity(identity.as_bytes())?;
    shell.connect(&format!(
        "{}://{}:{}",
        connection.transport, connection.ip, connection.shell_port
    ))?;

    let iopub = ctx.socket(zmq::SUB)?;
    iopub.set_subscribe(b"")?;
    iopub.connect(&format!(
        "{}://{}:{}",
        connection.transport, connection.ip, connection.iopub_port
    ))?;

    let session = Uuid::new_v4().to_string();
    let comm_id = Uuid::new_v4().to_string();
    send_comm_open(&shell, &connection.key, &session, &comm_id, &args.ip_address)?;

    let start = Instant::now();
    let timeout = Duration::from_millis(args.timeout_ms);
    let mut items = [iopub.as_poll_item(zmq::POLLIN)];

    loop {
        if start.elapsed() > timeout {
            return Err(anyhow!("Timed out waiting for Ark LSP comm response"));
        }

        zmq::poll(&mut items, 100)?;
        if items[0].is_readable() {
            let frames = iopub.recv_multipart(0)?;
            if let Some(port) = parse_comm_port(&frames, &comm_id) {
                let payload = json!({
                    "event": "lsp_port",
                    "port": port,
                });
                println!("{payload}");
                return Ok(());
            }
        }
    }
}

fn parse_args() -> Result<Args> {
    let mut connection_file: Option<String> = None;
    let mut ip_address: Option<String> = None;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--connection-file" => {
                connection_file = args.next();
            }
            "--ip-address" => {
                ip_address = args.next();
            }
            "--timeout-ms" => {
                if let Some(value) = args.next() {
                    timeout_ms = value.parse::<u64>().unwrap_or(DEFAULT_TIMEOUT_MS);
                }
            }
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            _ => {}
        }
    }

    let connection_file = connection_file.ok_or_else(|| anyhow!("--connection-file is required"))?;
    let ip_address = ip_address.ok_or_else(|| anyhow!("--ip-address is required"))?;

    Ok(Args {
        connection_file,
        ip_address,
        timeout_ms,
    })
}

fn print_usage() {
    eprintln!("Usage: vscode-r-ark-sidecar --connection-file <path> --ip-address <addr> [--timeout-ms <ms>]");
}

fn read_connection(path: &str) -> Result<ConnectionInfo> {
    let content = fs::read_to_string(path)?;
    let info: ConnectionInfo = serde_json::from_str(&content)?;
    Ok(info)
}

fn send_comm_open(shell: &zmq::Socket, key: &str, session: &str, comm_id: &str, ip_address: &str) -> Result<()> {
    let header = json!({
        "msg_id": Uuid::new_v4().to_string(),
        "username": "vscode-r",
        "session": session,
        "msg_type": "comm_open",
        "version": "5.3",
        "date": Utc::now().to_rfc3339(),
    });
    let parent_header = json!({});
    let metadata = json!({});
    let content = json!({
        "comm_id": comm_id,
        "target_name": LSP_COMM_TARGET,
        "data": {
            "ip_address": ip_address,
        }
    });

    let header_str = serde_json::to_string(&header)?;
    let parent_str = serde_json::to_string(&parent_header)?;
    let metadata_str = serde_json::to_string(&metadata)?;
    let content_str = serde_json::to_string(&content)?;
    let signature = sign_message(key, &header_str, &parent_str, &metadata_str, &content_str)?;

    let frames = vec![
        IDS_DELIMITER.as_bytes().to_vec(),
        signature.as_bytes().to_vec(),
        header_str.into_bytes(),
        parent_str.into_bytes(),
        metadata_str.into_bytes(),
        content_str.into_bytes(),
    ];

    shell.send_multipart(frames, 0)?;
    Ok(())
}

fn sign_message(key: &str, header: &str, parent: &str, metadata: &str, content: &str) -> Result<String> {
    if key.is_empty() {
        return Ok(String::new());
    }

    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes())
        .map_err(|_| anyhow!("Failed to initialize HMAC"))?;
    mac.update(header.as_bytes());
    mac.update(parent.as_bytes());
    mac.update(metadata.as_bytes());
    mac.update(content.as_bytes());
    let result = mac.finalize().into_bytes();
    Ok(hex::encode(result))
}

fn parse_comm_port(frames: &[Vec<u8>], comm_id: &str) -> Option<u16> {
    let delimiter_index = frames.iter().position(|frame| frame == IDS_DELIMITER.as_bytes())?;
    let header_index = delimiter_index.checked_add(2)?;
    let content_index = delimiter_index.checked_add(5)?;

    let header = frames.get(header_index)?;
    let content = frames.get(content_index)?;

    let header_value: Value = serde_json::from_slice(header).ok()?;
    let msg_type = header_value.get("msg_type")?.as_str()?;
    if msg_type != "comm_msg" {
        return None;
    }

    let content_value: Value = serde_json::from_slice(content).ok()?;
    let content_comm_id = content_value.get("comm_id")?.as_str()?;
    if content_comm_id != comm_id {
        return None;
    }

    find_port(&content_value)
}

fn find_port(value: &Value) -> Option<u16> {
    match value {
        Value::Object(map) => {
            if let Some(Value::Number(num)) = map.get("port") {
                if let Some(port) = num.as_u64() {
                    return u16::try_from(port).ok();
                }
            }
            for nested in map.values() {
                if let Some(port) = find_port(nested) {
                    return Some(port);
                }
            }
            None
        }
        Value::Array(values) => {
            for nested in values {
                if let Some(port) = find_port(nested) {
                    return Some(port);
                }
            }
            None
        }
        _ => None,
    }
}

