use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};
use std::env;
use std::fs;
use std::time::{Duration, Instant};
use tokio::runtime::Builder;
use uuid::Uuid;

use runtimelib::{
    create_client_iopub_connection, create_client_shell_connection, CommId, CommOpen,
    ConnectionInfo, JupyterMessage, JupyterMessageContent,
};

const LSP_COMM_TARGET: &str = "lsp";
const DEFAULT_TIMEOUT_MS: u64 = 15000;
const SUPPORTED_SIGNATURE_SCHEME: &str = "hmac-sha256";

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

    let runtime = Builder::new_current_thread()
        .enable_all()
        .build()
        .context("Failed to build Tokio runtime")?;

    runtime.block_on(async move {
        let session_id = Uuid::new_v4().to_string();
        let mut iopub = create_client_iopub_connection(&connection, "", &session_id)
            .await
            .context("Failed to connect iopub")?;
        let mut shell = create_client_shell_connection(&connection, &session_id)
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
        if matches!(message.content, JupyterMessageContent::IoPubWelcome(_)) {
            return Ok(());
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
        let JupyterMessageContent::CommMsg(comm_msg) = content else {
            continue;
        };
        if comm_msg.comm_id.0 != comm_id {
            continue;
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
