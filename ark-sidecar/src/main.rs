use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::time::{Duration, Instant};
use tokio::runtime::Builder;
use uuid::Uuid;

use runtimelib::{
    create_client_iopub_connection, CommId, CommOpen, Connection, ConnectionInfo, ExecuteRequest,
    ExecutionState, JupyterMessage, JupyterMessageContent,
};
use std::str::FromStr;
use zeromq::util::PeerIdentity;
use zeromq::{DealerSocket, Socket as ZmqSocket, SocketOptions};

const LSP_COMM_TARGET: &str = "positron.lsp";
const DEFAULT_TIMEOUT_MS: u64 = 15000;
const SUPPORTED_SIGNATURE_SCHEME: &str = "hmac-sha256";

#[derive(Debug)]
enum Mode {
    Lsp,
    Execute,
}

#[derive(Debug)]
struct Args {
    connection_file: String,
    ip_address: Option<String>,
    timeout_ms: u64,
    mode: Mode,
    code: Option<String>,
    code_is_base64: bool,
    wait_for_idle: bool,
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
        match args.mode {
            Mode::Lsp => {
                let ip_address = args
                    .ip_address
                    .clone()
                    .ok_or_else(|| anyhow!("--ip-address is required"))?;
                run_lsp(&connection, &session_id, &ip_address, args.timeout_ms).await?;
            }
            Mode::Execute => {
                let code = decode_code(&args)?;
                run_execute_request(
                    &connection,
                    &session_id,
                    &code,
                    args.timeout_ms,
                    args.wait_for_idle,
                )
                .await?;
            }
        }

        Ok::<(), anyhow::Error>(())
    })
}

fn parse_args() -> Result<Args> {
    let mut connection_file: Option<String> = None;
    let mut ip_address: Option<String> = None;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut mode = Mode::Lsp;
    let mut code: Option<String> = None;
    let mut code_is_base64 = false;
    let mut wait_for_idle = false;

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
            "--execute" => {
                mode = Mode::Execute;
            }
            "--code" => {
                code = args.next();
            }
            "--code-base64" => {
                code_is_base64 = true;
            }
            "--wait-for-idle" => {
                wait_for_idle = true;
            }
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            _ => {}
        }
    }

    let connection_file = connection_file.ok_or_else(|| anyhow!("--connection-file is required"))?;
    if matches!(mode, Mode::Execute) && code.is_none() {
        return Err(anyhow!("--code is required for --execute"));
    }
    if matches!(mode, Mode::Lsp) && ip_address.is_none() {
        return Err(anyhow!("--ip-address is required"));
    }

    Ok(Args {
        connection_file,
        ip_address,
        timeout_ms,
        mode,
        code,
        code_is_base64,
        wait_for_idle,
    })
}

fn print_usage() {
    eprintln!("Usage:");
    eprintln!("  vscode-r-ark-sidecar --connection-file <path> --ip-address <addr> [--timeout-ms <ms>]");
    eprintln!("  vscode-r-ark-sidecar --execute --connection-file <path> --code <text> [--code-base64] [--timeout-ms <ms>] [--wait-for-idle]");
}

fn read_connection(path: &str) -> Result<ConnectionInfo> {
    let content = fs::read_to_string(path)?;
    let info: ConnectionInfo = serde_json::from_str(&content)?;
    Ok(info)
}

fn decode_code(args: &Args) -> Result<String> {
    let code = args.code.clone().unwrap_or_default();
    if args.code_is_base64 {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(code.as_bytes())
            .context("Failed to decode base64 code")?;
        let decoded = String::from_utf8(bytes).context("Decoded code is not valid UTF-8")?;
        Ok(decoded)
    } else {
        Ok(code)
    }
}

async fn run_lsp(
    connection: &ConnectionInfo,
    session_id: &str,
    ip_address: &str,
    timeout_ms: u64,
) -> Result<()> {
    let mut iopub = create_client_iopub_connection(connection, "", session_id)
        .await
        .context("Failed to connect iopub")?;
    let mut shell = create_shell_connection(connection, session_id)
        .await
        .context("Failed to connect shell")?;

    wait_for_iopub_welcome(&mut iopub, Duration::from_millis(timeout_ms)).await?;

    let comm_id = Uuid::new_v4().to_string();
    send_comm_open(&mut shell, &comm_id, ip_address).await?;
    log_debug("Sidecar: sent comm_open.");

    let port = wait_for_comm_port(&mut iopub, &comm_id, Duration::from_millis(timeout_ms)).await?;
    let payload = json!({
        "event": "lsp_port",
        "port": port,
    });
    println!("{payload}");

    Ok(())
}

async fn run_execute_request(
    connection: &ConnectionInfo,
    session_id: &str,
    code: &str,
    timeout_ms: u64,
    wait_for_idle: bool,
) -> Result<()> {
    let mut iopub = create_client_iopub_connection(connection, "", session_id)
        .await
        .context("Failed to connect iopub")?;
    let mut shell = create_shell_connection(connection, session_id)
        .await
        .context("Failed to connect shell")?;

    wait_for_iopub_welcome(&mut iopub, Duration::from_millis(timeout_ms)).await?;

    let execute_request = ExecuteRequest::new(code.to_string());
    let message = JupyterMessage::new(execute_request, None);
    let msg_id = message.header.msg_id.clone();
    shell.send(message).await.context("Failed to send execute_request")?;

    if wait_for_idle {
        wait_for_iopub_idle(&mut iopub, &msg_id, Duration::from_millis(timeout_ms)).await?;
    }

    Ok(())
}

async fn send_comm_open(
    shell: &mut runtimelib::ClientShellConnection,
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

async fn create_shell_connection(
    connection_info: &ConnectionInfo,
    session_id: &str,
) -> Result<runtimelib::ClientShellConnection> {
    let mut options = SocketOptions::default();
    let identity = PeerIdentity::from_str(&format!("sidecar-{}", Uuid::new_v4()))
        .context("Failed to create peer identity")?;
    options.peer_identity(identity);

    let mut socket = DealerSocket::with_options(options);
    socket
        .connect(&connection_info.shell_url())
        .await
        .context("Failed to connect shell socket")?;

    Ok(Connection::new(socket, &connection_info.key, session_id))
}

async fn wait_for_iopub_welcome(
    iopub: &mut runtimelib::ClientIoPubConnection,
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

async fn wait_for_iopub_idle(
    iopub: &mut runtimelib::ClientIoPubConnection,
    msg_id: &str,
    timeout: Duration,
) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or(Duration::from_millis(0));
        if remaining.is_zero() {
            return Err(anyhow!("Timed out waiting for iopub idle"));
        }
        let message = tokio::time::timeout(remaining, iopub.read())
            .await
            .map_err(|_| anyhow!("Timed out waiting for iopub idle"))??;
        if message.parent_header.as_ref().map(|h| h.msg_id.as_str()) != Some(msg_id) {
            continue;
        }
        if let JupyterMessageContent::Status(status) = message.content {
            if status.execution_state == ExecutionState::Idle {
                return Ok(());
            }
        }
    }
}

async fn wait_for_comm_port(
    iopub: &mut runtimelib::ClientIoPubConnection,
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
        if let JupyterMessageContent::Stream(stream) = &content {
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
