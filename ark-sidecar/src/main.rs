use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use data_encoding::{HEXLOWER, HEXLOWER_PERMISSIVE};
use hmac::{Hmac, Mac};
use jupyter_protocol::{
    CommId, CommOpen, ConnectionInfo, Header, JupyterMessage, JupyterMessageContent,
};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::env;
use std::fs;
use std::str::FromStr;
use std::time::{Duration, Instant};
use tokio::runtime::Builder;
use uuid::Uuid;
use zeromq::util::PeerIdentity;
use zeromq::{
    DealerSocket, Socket as ZmqSocket, SocketOptions, SocketRecv, SocketSend, SubSocket,
    ZmqMessage,
};

const LSP_COMM_TARGET: &str = "positron.lsp";
const DEFAULT_TIMEOUT_MS: u64 = 15000;
const SUPPORTED_SIGNATURE_SCHEME: &str = "hmac-sha256";
const DELIMITER: &[u8] = b"<IDS|MSG>";

type HmacSha256 = Hmac<Sha256>;

struct JupyterConnection<S> {
    socket: S,
    key: Option<Vec<u8>>,
    session_id: String,
}

impl<S> JupyterConnection<S> {
    fn new(socket: S, key: &str, session_id: &str) -> Self {
        let key = if key.is_empty() {
            None
        } else {
            Some(key.as_bytes().to_vec())
        };
        Self {
            socket,
            key,
            session_id: session_id.to_string(),
        }
    }
}

impl<S: SocketSend> JupyterConnection<S> {
    async fn send(&mut self, message: JupyterMessage) -> Result<()> {
        let message = message.with_session(&self.session_id);
        let zmq_message = encode_jupyter_message(&message, self.key.as_deref())?;
        self.socket.send(zmq_message).await?;
        Ok(())
    }
}

impl<S: SocketRecv> JupyterConnection<S> {
    async fn read(&mut self) -> Result<JupyterMessage> {
        let zmq_message = self.socket.recv().await?;
        decode_jupyter_message(zmq_message, self.key.as_deref())
    }
}

#[derive(Debug)]
struct Args {
    connection_file: String,
    ip_address: String,
    timeout_ms: u64,
}

fn debug_enabled() -> bool {
    env::var("ARK_SIDECAR_DEBUG").map(|val| val != "0").unwrap_or(false)
}

fn log_debug(message: &str) {
    if debug_enabled() {
        eprintln!("{message}");
    }
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

    let runtime = Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .context("Failed to build Tokio runtime")?;

    runtime.block_on(async move {
        let session_id = Uuid::new_v4().to_string();
        let mut iopub = create_iopub_connection(&connection, &session_id)
            .await
            .context("Failed to connect iopub")?;
        let mut shell = create_shell_connection(&connection, &session_id)
            .await
            .context("Failed to connect shell")?;

        wait_for_iopub_welcome(&mut iopub, Duration::from_millis(args.timeout_ms)).await?;

        let comm_id = Uuid::new_v4().to_string();
        send_comm_open(&mut shell, &comm_id, &args.ip_address).await?;
        log_debug("Sidecar: sent comm_open.");

        let port = wait_for_comm_port(&mut iopub, &comm_id, Duration::from_millis(args.timeout_ms))
            .await?;
        let payload = json!({
            "event": "lsp_port",
            "port": port,
        });
        println!("{payload}");

        Ok::<(), anyhow::Error>(())
    })
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

async fn create_iopub_connection(
    connection_info: &ConnectionInfo,
    session_id: &str,
) -> Result<JupyterConnection<SubSocket>> {
    let mut socket = SubSocket::new();
    socket.subscribe("").await?;
    socket
        .connect(&connection_info.iopub_url())
        .await
        .context("Failed to connect iopub socket")?;

    Ok(JupyterConnection::new(
        socket,
        &connection_info.key,
        session_id,
    ))
}

async fn send_comm_open(
    shell: &mut JupyterConnection<DealerSocket>,
    comm_id: &str,
    ip_address: &str,
) -> Result<()> {
    let mut data = Map::new();
    data.insert("ip_address".to_string(), Value::String(ip_address.to_string()));
    let comm_open = CommOpen {
        comm_id: CommId(comm_id.to_string()),
        target_name: LSP_COMM_TARGET.to_string(),
        data,
        target_module: None,
    };
    let message = JupyterMessage::new(comm_open, None);
    shell.send(message).await.context("Failed to send comm_open")
}

fn encode_jupyter_message(message: &JupyterMessage, key: Option<&[u8]>) -> Result<ZmqMessage> {
    let header = serde_json::to_vec(&message.header)?;
    let parent = match &message.parent_header {
        Some(parent) => serde_json::to_vec(parent)?,
        None => b"{}".to_vec(),
    };
    let metadata = serde_json::to_vec(&message.metadata)?;
    let content = serde_json::to_vec(&message.content)?;

    let mut jparts: Vec<Bytes> = vec![
        Bytes::from(header),
        Bytes::from(parent),
        Bytes::from(metadata),
        Bytes::from(content),
    ];
    jparts.extend(message.buffers.iter().cloned());

    let signature = sign_message(key, &jparts[..4])?;

    let mut frames = Vec::new();
    frames.extend(message.zmq_identities.iter().cloned());
    frames.push(Bytes::from_static(DELIMITER));
    frames.push(signature);
    frames.extend(jparts);

    ZmqMessage::try_from(frames).map_err(|_| anyhow!("Failed to build ZMQ message"))
}

fn decode_jupyter_message(message: ZmqMessage, key: Option<&[u8]>) -> Result<JupyterMessage> {
    let parts = message.into_vec();
    let delimiter_index = parts
        .iter()
        .position(|part| part.as_ref() == DELIMITER)
        .ok_or_else(|| anyhow!("Missing Jupyter delimiter"))?;

    if parts.len() < delimiter_index + 6 {
        return Err(anyhow!("Malformed Jupyter message"));
    }

    let signature = parts
        .get(delimiter_index + 1)
        .ok_or_else(|| anyhow!("Missing Jupyter signature"))?;
    let jparts = &parts[(delimiter_index + 2)..];
    if jparts.len() < 4 {
        return Err(anyhow!("Malformed Jupyter message parts"));
    }

    if let Some(key) = key {
        if signature.is_empty() {
            return Err(anyhow!("Missing HMAC signature"));
        }
        verify_message(key, signature, &jparts[..4])?;
    }

    let header: Header = serde_json::from_slice(&jparts[0])?;
    let parent_value: Value = serde_json::from_slice(&jparts[1])?;
    let parent_header = match parent_value {
        Value::Null => None,
        Value::Object(ref map) if map.is_empty() => None,
        _ => Some(serde_json::from_value(parent_value)?),
    };
    let metadata: Value = serde_json::from_slice(&jparts[2])?;
    let content_value: Value = serde_json::from_slice(&jparts[3])?;
    let content =
        JupyterMessageContent::from_type_and_content(&header.msg_type, content_value).map_err(
            |err| anyhow!("Failed to decode Jupyter content: {err}"),
        )?;
    let buffers = if jparts.len() > 4 {
        jparts[4..].iter().cloned().collect()
    } else {
        Vec::new()
    };

    Ok(JupyterMessage {
        zmq_identities: parts[..delimiter_index].to_vec(),
        header,
        parent_header,
        metadata,
        content,
        buffers,
        channel: None,
    })
}

fn sign_message(key: Option<&[u8]>, parts: &[Bytes]) -> Result<Bytes> {
    let Some(key) = key else {
        return Ok(Bytes::from_static(b""));
    };

    let mut mac = HmacSha256::new_from_slice(key).context("Invalid HMAC key")?;
    for part in parts {
        mac.update(part);
    }
    let digest = mac.finalize().into_bytes();
    Ok(Bytes::from(HEXLOWER.encode(&digest)))
}

fn verify_message(key: &[u8], signature: &Bytes, parts: &[Bytes]) -> Result<()> {
    let expected = HEXLOWER_PERMISSIVE
        .decode(signature.as_ref())
        .context("Invalid HMAC encoding")?;

    let mut mac = HmacSha256::new_from_slice(key).context("Invalid HMAC key")?;
    for part in parts {
        mac.update(part);
    }
    mac.verify_slice(&expected)
        .context("HMAC verification failed")?;
    Ok(())
}

async fn create_shell_connection(
    connection_info: &ConnectionInfo,
    session_id: &str,
) -> Result<JupyterConnection<DealerSocket>> {
    let mut options = SocketOptions::default();
    let identity = PeerIdentity::from_str(&format!("sidecar-{}", Uuid::new_v4()))
        .context("Failed to create peer identity")?;
    options.peer_identity(identity);

    let mut socket = DealerSocket::with_options(options);
    socket
        .connect(&connection_info.shell_url())
        .await
        .context("Failed to connect shell socket")?;

    Ok(JupyterConnection::new(
        socket,
        &connection_info.key,
        session_id,
    ))
}

async fn wait_for_iopub_welcome(
    iopub: &mut JupyterConnection<SubSocket>,
    timeout: Duration,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::from_millis(0));
        if remaining.is_zero() {
            return Err(anyhow!("Timed out waiting for iopub_welcome"));
        }
        let message = tokio::time::timeout(remaining, iopub.read())
            .await
            .map_err(|_| anyhow!("Timed out waiting for iopub_welcome"))??;
        if debug_enabled() {
            log_debug(&format!(
                "Sidecar: iopub message while waiting for welcome: {}",
                message.content.message_type()
            ));
        }
        if matches!(message.content, JupyterMessageContent::IoPubWelcome(_)) {
            log_debug("Sidecar: received iopub_welcome");
            return Ok(());
        }
    }
}

async fn wait_for_comm_port(
    iopub: &mut JupyterConnection<SubSocket>,
    comm_id: &str,
    timeout: Duration,
) -> Result<u16> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::from_millis(0));
        if remaining.is_zero() {
            return Err(anyhow!("Timed out waiting for Ark LSP comm response"));
        }
        let message = tokio::time::timeout(remaining, iopub.read())
            .await
            .map_err(|_| anyhow!("Timed out waiting for Ark LSP comm response"))??;
        let JupyterMessage { content, .. } = message;
        if debug_enabled() {
            log_debug(&format!(
                "Sidecar: iopub message while waiting for port: {}",
                content.message_type()
            ));
        }
        if let JupyterMessageContent::StreamContent(stream) = &content {
            if debug_enabled() {
                log_debug(&format!(
                    "Sidecar: iopub stream ({:?}): {}",
                    stream.name, stream.text
                ));
            }
        }
        let JupyterMessageContent::CommMsg(comm_msg) = content else {
            if let JupyterMessageContent::CommClose(comm_close) = content {
                if comm_close.comm_id.0 == comm_id {
                    return Err(anyhow!("Comm closed before LSP port was received"));
                }
            }
            continue;
        };
        if comm_msg.comm_id.0 != comm_id {
            continue;
        }
        if debug_enabled() {
            log_debug(&format!("Sidecar: comm_msg data: {}", Value::Object(comm_msg.data.clone())));
        }
        if let Some(port) = extract_comm_port(&comm_msg.data) {
            return Ok(port);
        }
    }
}

fn extract_comm_port(data: &Map<String, Value>) -> Option<u16> {
    if let Some(Value::Object(params)) = data.get("params") {
        if let Some(port) = find_port(&Value::Object(params.clone())) {
            return Some(port);
        }
    }
    if let Some(Value::Object(content)) = data.get("content") {
        if let Some(port) = find_port(&Value::Object(content.clone())) {
            return Some(port);
        }
    }
    find_port(&Value::Object(data.clone()))
}

fn find_port(value: &Value) -> Option<u16> {
    match value {
        Value::Object(map) => {
            if let Some(port) = parse_port_value(map.get("port")) {
                return Some(port);
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

fn parse_port_value(value: Option<&Value>) -> Option<u16> {
    match value? {
        Value::Number(num) => num.as_u64().and_then(|port| u16::try_from(port).ok()),
        Value::String(text) => text.parse::<u16>().ok(),
        _ => None,
    }
}
