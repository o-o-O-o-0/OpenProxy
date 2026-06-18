// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend_urls;
mod config_utils;

use arboard::Clipboard;
use backend_urls::derive_openai_model_candidates;
use config_utils::{migrate_api_key_value, API_KEY_PREFIX};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "macos")]
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Size, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt};
use uuid::Uuid;

const SETTINGS_WINDOW_LABEL: &str = "main";
const TRAY_MENU_QUIT: &str = "quit";
const TRAY_ICON_ID: &str = "openproxy-tray";
const FIXED_PROXY_PORT: u16 = 3210;
const PANEL_WIDTH: f64 = 372.0;
const PANEL_MIN_HEIGHT: f64 = 620.0;
const PANEL_MAX_HEIGHT: f64 = 860.0;
const PANEL_HEIGHT_RATIO: f64 = 0.88;
const PANEL_SCREEN_MARGIN: f64 = 16.0;

fn debug_log(message: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] {}\n", timestamp, message);
    let path = std::env::temp_dir().join("openproxy-debug.log");

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn node_log_path() -> PathBuf {
    std::env::temp_dir().join("openproxy-node.log")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ProxyStatus {
    running: bool,
    pid: Option<u32>,
    port: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct AppConfig {
    proxy: ProxyConfig,
    model: ModelConfig,
    backend: BackendConfig,
    #[serde(default)]
    ui: UiConfig,
    #[serde(default)]
    privacy: PrivacyConfig,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ProxyConfig {
    host: String,
    port: u16,
    lan_access: bool,
    api_key: String,
    timeout: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ModelConfig {
    #[serde(default)]
    available: Vec<ModelListEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ModelListEntry {
    id: String,
    name: String,
    source: Option<String>,
    upstream_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct BackendConfig {
    opencode: Option<OpencodeBackendConfig>,
    custom: Option<CustomBackendConfig>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct OpencodeBackendConfig {
    base_url: Option<String>,
    upstream_api_key: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct CustomBackendConfig {
    base_url: Option<String>,
    api_key: Option<String>,
    resolved_base_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct UiConfig {
    model_source: String,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            model_source: "opencode".to_string(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct PrivacyConfig {
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_true")]
    redact_assistant_messages: bool,
    #[serde(default = "default_true")]
    redact_tool_results: bool,
    #[serde(default = "default_true")]
    log_hits: bool,
}

fn default_true() -> bool {
    true
}

impl Default for PrivacyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            redact_assistant_messages: true,
            redact_tool_results: true,
            log_hits: true,
        }
    }
}

struct AppState {
    proxy: Mutex<Option<Child>>,
    config: Mutex<AppConfig>,
    config_path: PathBuf,
    tray_animating: Arc<Mutex<bool>>,
    /// 上游能力探测缓存，10 秒 TTL，避免重复触发上游限流
    probe_cache: Mutex<Option<(UpstreamCapabilities, Instant)>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ToolModelConfig {
    id: String,
    name: String,
    input_modalities: Vec<String>,
    reasoning: bool,
    context_window: Option<u64>,
    max_output_tokens: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct ClaudeModelMapping {
    opus: Option<String>,
    sonnet: Option<String>,
    haiku: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct ToolStatus {
    tool: String,
    label: String,
    installed: bool,
    binary_path: Option<String>,
    version: Option<String>,
    config_path: String,
    configured: bool,
    configured_models: Vec<String>,
    claude_mapping: Option<ClaudeModelMapping>,
    supported: bool,
    support_reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct UpstreamCapabilities {
    anthropic_supported: bool,
    anthropic_supports_streaming: bool,
    anthropic_supports_tools: bool,
    anthropic_reason: String,
    openai_supported: bool,
    openai_reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct OpenAIModelResponse {
    data: Vec<OpenAIModelItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct OpenAIModelItem {
    id: String,
    object: Option<String>,
    owned_by: Option<String>,
}

async fn detect_custom_openai_models_direct(
    base_url: String,
    api_key: String,
) -> Result<Vec<ToolModelConfig>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let candidates = derive_openai_model_candidates(&base_url);
    let mut last_error = None;

    for url in &candidates {
        let result = client
            .get(url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await;

        match result {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    let parsed: Result<OpenAIModelResponse, _> = resp.json().await;
                    match parsed {
                        Ok(data) => {
                            let models = data
                                .data
                                .into_iter()
                                .map(|item| {
                                    let id = item.id;
                                    ToolModelConfig {
                                        id: id.clone(),
                                        name: id,
                                        input_modalities: vec!["text".to_string()],
                                        reasoning: false,
                                        context_window: Some(128000),
                                        max_output_tokens: Some(32000),
                                    }
                                })
                                .collect();
                            return Ok(models);
                        }
                        Err(e) => {
                            last_error = Some(format!("Failed to parse model list response: {}", e));
                        }
                    }
                } else {
                    last_error = Some(format!("HTTP {} from {}", status.as_u16(), url));
                }
            }
            Err(e) => {
                last_error = Some(format!("Request to {} failed: {}", url, e));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "No valid model endpoint succeeded".to_string()))
}


fn resize_settings_window_for_current_monitor(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) else {
        return Ok(());
    };

    let available_height = window
        .current_monitor()?
        .map(|monitor| monitor.work_area().size.height as f64 / monitor.scale_factor())
        .unwrap_or(PANEL_MAX_HEIGHT + PANEL_SCREEN_MARGIN);
    let adaptive_height = (available_height * PANEL_HEIGHT_RATIO)
        .min(PANEL_MAX_HEIGHT)
        .max(PANEL_MIN_HEIGHT)
        .min((available_height - PANEL_SCREEN_MARGIN).max(480.0));

    window.set_size(Size::Logical(LogicalSize {
        width: PANEL_WIDTH,
        height: adaptive_height,
    }))?;

    Ok(())
}

fn toggle_settings_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let visible = window.is_visible()?;
        let minimized = window.is_minimized()?;

        if visible && !minimized {
            window.hide()?;
        } else {
            resize_settings_window_for_current_monitor(app)?;
            if minimized {
                window.unminimize()?;
            }
            if !visible {
                window.show()?;
            }
            resize_settings_window_for_current_monitor(app)?;
            let _ = window.move_window_constrained(Position::TrayCenter);
            window.set_focus()?;
            emit_proxy_status(app);
        }
    }
    Ok(())
}

fn clear_probe_cache(state: &AppState) {
    if let Ok(mut cache) = state.probe_cache.lock() {
        *cache = None;
    }
}

fn infer_upstream_capabilities(_config: &AppConfig) -> UpstreamCapabilities {
    UpstreamCapabilities {
        anthropic_supported: true,
        anthropic_supports_streaming: true,
        anthropic_supports_tools: true,
        anthropic_reason: String::new(),
        openai_supported: true,
        openai_reason: String::new(),
    }
}

fn is_proxy_running(state: &AppState, port: u16) -> Result<bool, String> {
    let mut proxy = state.proxy.lock().map_err(|e| e.to_string())?;

    if let Some(ref mut child) = *proxy {
        let dead = match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(_) => true,
        };
        if dead {
            *proxy = None;
        }
    }

    Ok(proxy.is_some() || (is_local_port_in_use(port) && is_existing_openproxy_instance(port)))
}

fn current_proxy_status(app: &AppHandle) -> Result<ProxyStatus, String> {
    let state = app.state::<AppState>();
    let config = state.config.lock().map_err(|e| e.to_string())?;

    let port = config.proxy.port;
    drop(config);

    let running = is_proxy_running(&state, port)?;

    Ok(ProxyStatus {
        running,
        pid: None,
        port,
    })
}

fn emit_proxy_status(app: &AppHandle) {
    if let Ok(status) = current_proxy_status(app) {
        sync_tray_icon(app, status.running);
        let _ = app.emit("proxy-status-changed", status);
    }
}

fn load_tray_icon_image(app: &AppHandle, file_name: &str) -> tauri::Result<Image<'static>> {
    let path = resolve_tray_asset_path(app, file_name)?;
    let bytes = fs::read(&path)
        .map_err(|e| tauri::Error::AssetNotFound(format!("{}: {}", path.display(), e)))?;
    Image::from_bytes(&bytes)
}

fn apply_tray_icon(app: &AppHandle, file_name: &str) {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };

    match load_tray_icon_image(app, file_name) {
        Ok(icon) => {
            let _ = tray.set_icon(Some(icon));
        }
        Err(err) => {
            eprintln!("[LOG] Failed to load tray icon {}: {}", file_name, err);
        }
    }
}

fn sync_tray_icon(app: &AppHandle, running: bool) {
    let state = app.state::<AppState>();

    if running {
        let mut animating = state
            .tray_animating
            .lock()
            .expect("tray animation state poisoned");
        if *animating {
            return;
        }
        *animating = true;
        drop(animating);

        let app_handle = app.clone();
        let animating_flag = Arc::clone(&state.tray_animating);
        thread::spawn(move || {
            let frames = ["trayWoodpeckerRunA.png", "trayWoodpeckerRunB.png"];
            let mut index = 0usize;

            loop {
                let should_continue = {
                    let guard = animating_flag
                        .lock()
                        .expect("tray animation state poisoned");
                    *guard
                };

                if !should_continue {
                    apply_tray_icon(&app_handle, "trayWoodpeckerIdle.png");
                    break;
                }

                apply_tray_icon(&app_handle, frames[index % frames.len()]);
                index = index.wrapping_add(1);
                thread::sleep(Duration::from_millis(450));
            }
        });
    } else {
        let mut animating = state
            .tray_animating
            .lock()
            .expect("tray animation state poisoned");
        *animating = false;
        drop(animating);
        apply_tray_icon(app, "trayWoodpeckerIdle.png");
    }
}

fn redact_cmd_args(_args: &[String]) -> Vec<String> {
    // Sensitive values are passed via environment variables, not CLI args.
    // CLI args contain only non-sensitive configuration (port, host, URLs, booleans).
    _args.to_vec()
}

fn start_proxy_with_handle(app: &AppHandle) -> Result<ProxyStatus, String> {
    eprintln!("[LOG] start_proxy called");

    let state = app.state::<AppState>();
    let mut proxy = state.proxy.lock().map_err(|e| e.to_string())?;
    let config = state.config.lock().map_err(|e| e.to_string())?;

    clear_probe_cache(&state);

    if proxy.is_some() {
        let port = config.proxy.port;
        drop(config);
        eprintln!("[LOG] Proxy already running on port {}", port);
        return Ok(ProxyStatus {
            running: true,
            pid: None,
            port,
        });
    }

    let port = config.proxy.port;
    let lan_access = config.proxy.lan_access;
    let api_key = config.proxy.api_key.clone();
    let host = config.proxy.host.clone();
    let opencode_base_url = config
        .backend
        .opencode
        .as_ref()
        .and_then(|value| value.base_url.clone())
        .unwrap_or_else(|| "https://opencode.ai/zen/v1/chat/completions".to_string());
    let opencode_upstream_api_key = config
        .backend
        .opencode
        .as_ref()
        .and_then(|value| value.upstream_api_key.clone())
        .unwrap_or_else(|| "public".to_string());
    let custom_base_url = config
        .backend
        .custom
        .as_ref()
        .and_then(|value| value.base_url.clone())
        .unwrap_or_default();
    let custom_api_key = config
        .backend
        .custom
        .as_ref()
        .and_then(|value| value.api_key.clone())
        .unwrap_or_default();
    let privacy_enabled = config.privacy.enabled;
    let privacy_redact_assistant_messages = config.privacy.redact_assistant_messages;
    let privacy_redact_tool_results = config.privacy.redact_tool_results;
    let privacy_log_hits = config.privacy.log_hits;
    drop(config);

    if is_local_port_in_use(port) {
        if is_existing_openproxy_instance(port) {
            eprintln!("[LOG] Existing OpenProxy instance detected on port {}, shutting it down before start", port);
            debug_log(&format!(
                "start_proxy shutting down existing OpenProxy instance on port {} before spawning current version",
                port
            ));
            shutdown_existing_openproxy_instance(port, &api_key)?;
        } else {
            let err = format!(
                "Port {} is already in use by another process. Stop the conflicting process and try again.",
                port
            );
            eprintln!("[LOG] ERROR: {}", err);
            return Err(err);
        }

        if is_local_port_in_use(port) {
            let err = format!(
                "Port {} is still in use after attempting to stop the existing OpenProxy instance.",
                port
            );
            eprintln!("[LOG] ERROR: {}", err);
            return Err(err);
        }
    }

    let mut cmd_args = vec!["src/index.js".to_string()];
    cmd_args.push("--port".to_string());
    cmd_args.push(port.to_string());
    cmd_args.push("--host".to_string());
    cmd_args.push(host);
    cmd_args.push("--opencode-base-url".to_string());
    cmd_args.push(opencode_base_url);
    cmd_args.push("--custom-base-url".to_string());
    cmd_args.push(custom_base_url);
    if lan_access {
        cmd_args.push("--lan-access".to_string());
    }
    cmd_args.push("--privacy-enabled".to_string());
    cmd_args.push(privacy_enabled.to_string());
    cmd_args.push("--privacy-redact-assistant-messages".to_string());
    cmd_args.push(privacy_redact_assistant_messages.to_string());
    cmd_args.push("--privacy-redact-tool-results".to_string());
    cmd_args.push(privacy_redact_tool_results.to_string());
    cmd_args.push("--privacy-log-hits".to_string());
    cmd_args.push(privacy_log_hits.to_string());

    let app_dir = resolve_app_dir(app, &state.config_path);
    eprintln!("[LOG] app_dir: {}", app_dir.display());

    let node_cmd = resolve_node_cmd().unwrap_or_else(|| "node".to_string());
    eprintln!("[LOG] node_cmd: {}", node_cmd);

    let node_modules_path = app_dir.join("node_modules");
    eprintln!("[LOG] node_modules_path: {}", node_modules_path.display());

    let script_path = app_dir.join("src/index.js");
    if !script_path.exists() {
        let err = format!("Proxy script not found: {}", script_path.display());
        eprintln!("[LOG] ERROR: {}", err);
        return Err(err);
    }
    eprintln!("[LOG] script_path exists: {}", script_path.display());

    if !node_modules_path.exists() {
        let err = format!("node_modules not found: {}", node_modules_path.display());
        eprintln!("[LOG] ERROR: {}", err);
        return Err(err);
    }
    eprintln!("[LOG] node_modules exists");

    let node_check = silent_command(&node_cmd).arg("--version").output();
    match node_check {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            eprintln!("[LOG] node version: {}", version);
        }
        Ok(_) => {
            eprintln!("[LOG] ERROR: node --version failed");
        }
        Err(e) => {
            let err = format!("node command not found: {}", e);
            eprintln!("[LOG] ERROR: {}", err);
            return Err(err);
        }
    }

    eprintln!("[LOG] Spawning node process with args: {:?}", redact_cmd_args(&cmd_args));
    let mut cmd = Command::new(&node_cmd);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let node_log_path = node_log_path();
    let stdout_log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&node_log_path)
        .map_err(|e| format!("Failed to open node log {}: {}", node_log_path.display(), e))?;
    let stderr_log = stdout_log
        .try_clone()
        .map_err(|e| format!("Failed to clone node log handle {}: {}", node_log_path.display(), e))?;

    cmd.env("NODE_PATH", &node_modules_path)
        .env("OPENPROXY_NODE_LOG_PATH", &node_log_path)
        .env("OPENPROXY_CONFIG_PATH", &state.config_path)
        .env("OPENPROXY_API_KEY", &api_key)
        .env("OPENPROXY_OPENCODE_UPSTREAM_API_KEY", &opencode_upstream_api_key)
        .env("OPENPROXY_CUSTOM_API_KEY", &custom_api_key)
        .args(&cmd_args)
        .current_dir(&app_dir)
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));

    debug_log(&format!("node stdout/stderr redirected to {}", node_log_path.display()));

    // DEBUG_STREAM defaults to "1" so per-chunk streaming logs land in
    // openproxy-node.log without the user having to set it manually.
    // The user can still override (e.g. set DEBUG_STREAM=0 in the parent
    // environment) before launching the tray app.
    let debug_stream_value = std::env::var("DEBUG_STREAM").unwrap_or_else(|_| "1".to_string());
    cmd.env("DEBUG_STREAM", debug_stream_value);

    match cmd.spawn() {
        Ok(mut child) => {
            let child_pid = child.id();
            eprintln!(
                "[LOG] Proxy started successfully (child pid: {})",
                child_pid
            );
            debug_log(&format!("start_proxy spawned node pid={}", child_pid));

            // Spawn-success only means the OS forked the process; it does NOT
            // mean the HTTP listener bound successfully. If 0.0.0.0:<port> was
            // already taken (e.g. legacy node instance from a prior install),
            // node will print FATAL and exit immediately. Without this check
            // we'd happily mark proxy-status-changed:running, the tray would
            // turn green, and the user would be silently routed to the legacy
            // process — which is exactly the symptom investigated 2026-06-18.
            //
            // Poll the listener for up to 4s while watching for early exit.
            let listen_ok = wait_for_node_listen(&mut child, port, Duration::from_secs(4));
            if !listen_ok {
                let exit_status = child.try_wait().ok().flatten();
                let _ = child.kill();
                let _ = child.wait();
                let detail = match exit_status {
                    Some(status) => format!("node exited early: {}", status),
                    None => "node did not start listening within 4s".to_string(),
                };
                let err = format!(
                    "Failed to start proxy: {}. Check {} for details.",
                    detail,
                    node_log_path.display()
                );
                debug_log(&format!("start_proxy listen verification failed pid={} reason={}", child_pid, detail));
                eprintln!("[LOG] ERROR: {}", err);
                return Err(err);
            }

            debug_log(&format!("start_proxy listen verified pid={}", child_pid));
            *proxy = Some(child);
            drop(proxy);
            let status = ProxyStatus {
                running: true,
                pid: None,
                port,
            };
            sync_tray_icon(app, true);
            let _ = app.emit("proxy-status-changed", status.clone());
            Ok(status)
        }
        Err(e) => {
            let err = format!("Failed to spawn node process: {}", e);
            eprintln!("[LOG] ERROR: {}", err);
            Err(err)
        }
    }
}

/// Wait until the node child process is actually listening on `port`, or it
/// exits early, or `timeout` elapses. Returns true only when a TCP probe to
/// the port succeeds AND the child is still running.
fn wait_for_node_listen(child: &mut std::process::Child, port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    let probe_addrs = [
        std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port)),
        std::net::SocketAddr::from((std::net::Ipv4Addr::UNSPECIFIED, port)),
    ];
    while std::time::Instant::now() < deadline {
        // Bail out if the child already died.
        match child.try_wait() {
            Ok(Some(_status)) => return false,
            Ok(None) => {}
            Err(_) => {}
        }

        for addr in probe_addrs.iter() {
            if TcpStream::connect_timeout(addr, Duration::from_millis(150)).is_ok() {
                return true;
            }
        }

        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

fn is_local_port_in_use(port: u16) -> bool {
    // Probe both the wildcard and loopback addresses. Windows treats
    // 0.0.0.0:<port> and 127.0.0.1:<port> as separate bind targets, so a
    // legacy OpenProxy listening on 0.0.0.0 would NOT prevent a fresh bind on
    // 127.0.0.1 from succeeding. If we only checked 127.0.0.1 here we would
    // wrongly conclude the port is free, skip the shutdown_existing_openproxy
    // path, then spawn node which immediately fails with EADDRINUSE while the
    // tray UI still claims "running". See investigation 2026-06-18.
    if TcpListener::bind(((std::net::Ipv4Addr::UNSPECIFIED), port)).is_err() {
        return true;
    }
    TcpListener::bind(((std::net::Ipv4Addr::LOCALHOST), port)).is_err()
}

fn is_existing_openproxy_instance(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        port
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.contains("\"status\":\"ok\"") || response.contains("\"status\": \"ok\"")
}

fn wait_for_openproxy_shutdown(port: u16, timeout: Duration) -> bool {
    let started = std::time::Instant::now();

    while started.elapsed() < timeout {
        if !is_local_port_in_use(port) || !is_existing_openproxy_instance(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }

    !is_local_port_in_use(port) || !is_existing_openproxy_instance(port)
}

#[cfg(windows)]
fn find_listening_pid_on_port(port: u16) -> Option<u32> {
    let script = format!(
        "$owningProcessId = Get-NetTCPConnection -State Listen -LocalPort {} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($owningProcessId) {{ $owningProcessId }}",
        port
    );

    let output = silent_command("powershell")
        .arg("-NoProfile")
        .arg("-Command")
        .arg(&script)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8(output.stdout)
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
}

#[cfg(windows)]
fn kill_process_on_port(port: u16) -> Result<(), String> {
    let pid = find_listening_pid_on_port(port)
        .ok_or_else(|| format!("Failed to find PID listening on port {}", port))?;

    let output = silent_command("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .output()
        .map_err(|e| format!("Failed to execute taskkill for PID {}: {}", pid, e))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };

    // The listener may have already exited or been replaced between lookup and taskkill.
    let current_pid = find_listening_pid_on_port(port);
    if current_pid.is_none() || current_pid != Some(pid) {
        debug_log(&format!(
            "taskkill reported failure for PID {}, but listener changed to {:?}; treating as success",
            pid, current_pid
        ));
        return Ok(());
    }

    debug_log(&format!("taskkill failed for PID {}: {}", pid, detail));
    Err(format!(
        "Failed to kill legacy OpenProxy instance on port {}",
        port
    ))
}

fn shutdown_existing_openproxy_instance(port: u16, api_key: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("Failed to connect to running OpenProxy: {}", e))?;

    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let request = format!(
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        port,
        api_key,
    );

    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("Failed to send shutdown request: {}", e))?;

    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let first_line = response.lines().next().unwrap_or("");

    if first_line.contains(" 401 ") {
        return Err("Running OpenProxy rejected shutdown request (API key mismatch)".to_string());
    }

    if first_line.contains(" 404 ") {
        debug_log("shutdown endpoint returned 404, trying Windows port-kill fallback");
        #[cfg(windows)]
        {
            kill_process_on_port(port)?;
            if wait_for_openproxy_shutdown(port, Duration::from_secs(5)) {
                return Ok(());
            }
            return Err(
                "Port-kill fallback completed but running OpenProxy did not stop in time"
                    .to_string(),
            );
        }
        #[cfg(not(windows))]
        {
            return Err("Running OpenProxy is too old to support /shutdown".to_string());
        }
    }

    if wait_for_openproxy_shutdown(port, Duration::from_secs(5)) {
        return Ok(());
    }

    if first_line.is_empty() {
        Err("Shutdown request sent but running OpenProxy did not stop in time".to_string())
    } else {
        Err(format!(
            "Shutdown request returned unexpected response and proxy is still running: {}",
            first_line
        ))
    }
}

fn stop_proxy_with_handle(app: &AppHandle) -> Result<(), String> {
    eprintln!("[LOG] stop_proxy called");
    debug_log("stop_proxy entered");
    let state = app.state::<AppState>();
    clear_probe_cache(&state);
    debug_log("stop_proxy acquiring proxy lock");
    let mut proxy = match state.proxy.lock() {
        Ok(proxy) => {
            debug_log("stop_proxy proxy lock acquired");
            proxy
        }
        Err(err) => {
            let message = err.to_string();
            debug_log(&format!(
                "stop_proxy failed to acquire proxy lock: {}",
                message
            ));
            return Err(message);
        }
    };

    if let Some(mut child) = proxy.take() {
        eprintln!("[LOG] Killing proxy (pid: {})", child.id());
        debug_log(&format!("stop_proxy child found pid={}", child.id()));
        match child.kill() {
            Ok(()) => debug_log("stop_proxy kill sent"),
            Err(err) => debug_log(&format!("stop_proxy kill failed: {}", err)),
        }

        // 等待进程退出，最多 5 秒，防止 child.wait() 卡死 UI
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        debug_log("stop_proxy spawning wait thread");
        std::thread::spawn(move || {
            debug_log("stop_proxy wait thread started");
            match child.wait() {
                Ok(status) => debug_log(&format!("stop_proxy wait thread completed: {}", status)),
                Err(err) => debug_log(&format!("stop_proxy wait thread failed: {}", err)),
            }
            let _ = tx.send(());
        });
        debug_log("stop_proxy waiting for child exit up to 5s");
        if rx.recv_timeout(Duration::from_secs(5)).is_err() {
            eprintln!("[LOG] Timeout waiting for proxy to exit");
            debug_log("stop_proxy wait timed out");
        } else {
            eprintln!("[LOG] Proxy exited");
            debug_log("stop_proxy wait completed before timeout");
        }

        debug_log("stop_proxy releasing proxy lock");
        drop(proxy);
        debug_log("stop_proxy emitting proxy status");
        emit_proxy_status(app);
        debug_log("stop_proxy returning Ok after child branch");
        Ok(())
    } else {
        eprintln!("[LOG] No proxy running to stop");
        debug_log("stop_proxy found no tracked child");
        drop(proxy);
        debug_log("stop_proxy proxy lock released before unmanaged shutdown");

        let config = state.config.lock().map_err(|e| e.to_string())?;
        let port = config.proxy.port;
        let api_key = config.proxy.api_key.clone();
        drop(config);

        if is_local_port_in_use(port) && is_existing_openproxy_instance(port) {
            debug_log("stop_proxy attempting shutdown of unmanaged running instance");
            shutdown_existing_openproxy_instance(port, &api_key)?;
            debug_log("stop_proxy unmanaged running instance shutdown completed");
        }

        debug_log("stop_proxy emitting proxy status");
        emit_proxy_status(app);
        debug_log("stop_proxy returning Ok after empty branch");
        Ok(())
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, TRAY_MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;

    let mut tray_builder = TrayIconBuilder::with_id(TRAY_ICON_ID);

    if let Ok(tray_icon) = load_tray_icon_image(app, "trayWoodpeckerIdle.png") {
        tray_builder = tray_builder.icon(tray_icon);
    } else if let Some(default_icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(default_icon.clone());
    }

    tray_builder
        .tooltip("OpenProxy")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_MENU_QUIT => {
                debug_log("tray quit requested, stopping proxy before exit");
                if let Err(err) = stop_proxy_with_handle(app) {
                    debug_log(&format!("failed to stop proxy during tray quit: {}", err));
                    eprintln!("[LOG] Failed to stop proxy during quit: {}", err);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            tauri_plugin_positioner::on_tray_event(&app, &event);

            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = toggle_settings_window(&app);
            }
        })
        .build(app)?;

    Ok(())
}

fn resolve_tray_asset_path(app: &AppHandle, file_name: &str) -> tauri::Result<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_path) = app
        .path()
        .resolve(format!("icons/{}", file_name), BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    if let Ok(resource_path) = app
        .path()
        .resolve(format!("_up_/icons/{}", file_name), BaseDirectory::Resource)
    {
        candidates.push(resource_path);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(
                parent
                    .join("..")
                    .join("Resources")
                    .join("icons")
                    .join(file_name),
            );
            candidates.push(
                parent
                    .join("..")
                    .join("Resources")
                    .join("_up_")
                    .join("icons")
                    .join(file_name),
            );
            candidates.push(parent.join("icons").join(file_name));
        }
    }

    if let Ok(dir) = std::env::current_dir() {
        candidates.push(dir.join("icons").join(file_name));
        candidates.push(dir.join("src-tauri").join("icons").join(file_name));
        candidates.push(
            dir.join("..")
                .join("src-tauri")
                .join("icons")
                .join(file_name),
        );
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| tauri::Error::AssetNotFound(file_name.to_string()))
}

/// 读取配置文件
fn read_config(config_path: &PathBuf) -> Result<AppConfig, String> {
    let content =
        fs::read_to_string(config_path).map_err(|e| format!("Failed to read config: {}", e))?;
    let mut value: Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))?;
    migrate_config_value(&mut value);
    let full_config: AppConfig =
        serde_json::from_value(value).map_err(|e| format!("Failed to parse config: {}", e))?;

    Ok(full_config)
}

fn generate_api_key() -> String {
    format!("{}{}", API_KEY_PREFIX, Uuid::new_v4().simple())
}

fn migrate_config_value(value: &mut Value) {
    let Some(root) = value.as_object_mut() else {
        return;
    };

    let backend = root
        .entry("backend".to_string())
        .or_insert_with(|| json!({}));
    if let Some(backend_map) = backend.as_object_mut() {
        if !backend_map.contains_key("custom") {
            if let Some(legacy_openai) = backend_map.remove("openai") {
                backend_map.insert("custom".to_string(), legacy_openai);
            }
        } else {
            backend_map.remove("openai");
        }
        backend_map.remove("type");
    }

    let ui = root
        .entry("ui".to_string())
        .or_insert_with(|| json!({}));
    if let Some(ui_map) = ui.as_object_mut() {
        if !matches!(ui_map.get("modelSource").and_then(|item| item.as_str()), Some("custom") | Some("opencode")) {
            ui_map.insert("modelSource".to_string(), Value::String("opencode".to_string()));
        }
    }
}

fn default_app_config() -> AppConfig {
    AppConfig {
        proxy: ProxyConfig {
            host: "127.0.0.1".to_string(),
            port: FIXED_PROXY_PORT,
            lan_access: false,
            api_key: generate_api_key(),
            timeout: Some(3_000_000),
        },
        model: ModelConfig {
            available: Vec::new(),
        },
        backend: BackendConfig {
            opencode: Some(OpencodeBackendConfig {
                base_url: Some("https://opencode.ai/zen/v1/chat/completions".to_string()),
                upstream_api_key: Some("public".to_string()),
            }),
            custom: Some(CustomBackendConfig {
                base_url: Some(String::new()),
                api_key: Some(String::new()),
                resolved_base_url: Some(String::new()),
            }),
        },
        ui: UiConfig::default(),
        privacy: PrivacyConfig::default(),
    }
}

/// 保存配置到文件
fn save_config_to_file(config_path: &PathBuf, config: &AppConfig) -> Result<(), String> {
    ensure_parent_dir(config_path)?;
    fs::write(
        config_path,
        serde_json::to_string_pretty(config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write config: {}", e))?;

    Ok(())
}

fn migrate_config_api_key(config: &mut AppConfig) -> Option<String> {
    let old_api_key = config.proxy.api_key.clone();
    let migrated = migrate_api_key_value(&old_api_key)?;
    config.proxy.api_key = migrated;
    Some(old_api_key)
}

fn openproxy_openai_base_url(config: &AppConfig) -> String {
    format!("http://127.0.0.1:{}/v1", config.proxy.port)
}

fn openproxy_anthropic_base_url(config: &AppConfig) -> String {
    format!("http://127.0.0.1:{}", config.proxy.port)
}

fn normalize_app_config(config: &mut AppConfig) -> bool {
    let mut changed = false;

    if config.proxy.port != FIXED_PROXY_PORT {
        config.proxy.port = FIXED_PROXY_PORT;
        changed = true;
    }

    let expected_host = if config.proxy.lan_access {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    if config.proxy.host != expected_host {
        config.proxy.host = expected_host.to_string();
        changed = true;
    }

    if config.ui.model_source != "custom" && config.ui.model_source != "opencode" {
        config.ui.model_source = "opencode".to_string();
        changed = true;
    }

    changed
}

fn resolve_app_dir(app: &AppHandle, config_path: &Path) -> PathBuf {
    if let Ok(resource_root) = app.path().resolve("_up_", BaseDirectory::Resource) {
        if resource_root.join("src/index.js").exists()
            && resource_root.join("node_modules").exists()
        {
            return resource_root;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let mut candidates = Vec::new();
            #[cfg(windows)]
            {
                candidates.push(parent.join("_up_"));
                candidates.push(parent.join("resources").join("_up_"));
            }
            candidates.push(parent.join("..").join("Resources").join("_up_"));
            candidates.push(parent.join("..").join("Resources"));

            for candidate in &candidates {
                if candidate.join("src/index.js").exists()
                    && candidate.join("node_modules").exists()
                {
                    return candidate.clone();
                }
            }

            #[cfg(windows)]
            if parent.join("src/index.js").exists() && parent.join("node_modules").exists() {
                return parent.to_path_buf();
            }
        }
    }

    if let Ok(dir) = std::env::current_dir() {
        let candidates = [dir.clone(), dir.join("..")];

        for candidate in candidates {
            if candidate.join("src/index.js").exists() && candidate.join("node_modules").exists() {
                return candidate;
            }
        }
    }

    config_path
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Windows: 创建不弹控制台窗口的子进程
fn silent_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn resolve_command_path(name: &str, env_override: Option<&str>) -> Option<String> {
    if let Some(env_name) = env_override {
        if let Ok(value) = std::env::var(env_name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && Path::new(trimmed).exists() {
                return Some(trimmed.to_string());
            }
        }
    }

    let which_output = {
        let (tx, rx) = std::sync::mpsc::channel::<Option<std::process::Output>>();
        let cmd_name = name.to_string();
        std::thread::spawn(move || {
            let _ = tx.send(
                silent_command(if cfg!(windows) { "where" } else { "which" })
                    .arg(&cmd_name)
                    .output()
                    .ok(),
            );
        });
        rx.recv_timeout(Duration::from_secs(5))
            .ok()
            .flatten()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .map(|stdout| {
                let lines: Vec<&str> = stdout
                    .lines()
                    .map(|line| line.trim())
                    .filter(|line| !line.is_empty())
                    .collect();
                lines
                    .iter()
                    .copied()
                    .find(|line| !line.to_lowercase().ends_with(".cmd"))
                    .or_else(|| lines.first().copied())
                    .unwrap_or("")
                    .to_string()
            })
            .filter(|path| !path.is_empty())
    };

    if which_output.is_some() {
        #[cfg(windows)]
        if let Some(ref path) = which_output {
            let lower = path.to_lowercase();
            if !lower.ends_with(".exe") && !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
                let cmd_path = format!("{}.cmd", path);
                if Path::new(&cmd_path).exists() {
                    return Some(cmd_path);
                }
            }
        }
        return which_output;
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        if let Some(home) = dirs::home_dir() {
            candidates.push(
                home.join("AppData")
                    .join("Roaming")
                    .join("nvm")
                    .join(format!("{}.cmd", name)),
            );
            candidates.push(
                home.join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join(format!("{}.cmd", name)),
            );
            candidates.push(PathBuf::from(format!(
                "C:\\Program Files\\nodejs\\{}.exe",
                name
            )));
            candidates.push(PathBuf::from(format!("{}.exe", name)));
        }
    }

    #[cfg(not(windows))]
    {
        candidates.extend(vec![
            PathBuf::from(format!("/opt/homebrew/bin/{name}")),
            PathBuf::from(format!("/usr/local/bin/{name}")),
            PathBuf::from(format!("/opt/homebrew/opt/node/bin/{name}")),
            PathBuf::from(format!("/usr/bin/{name}")),
            PathBuf::from(format!("/usr/local/sbin/{name}")),
        ]);
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local").join("bin").join(name));
        candidates.push(home.join(".nvm/current/bin").join(name));

        let nvm_versions_dir = home.join(".nvm").join("versions").join("node");
        if let Ok(entries) = fs::read_dir(nvm_versions_dir) {
            let mut version_dirs = entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.join("bin").join(name).exists())
                .collect::<Vec<_>>();
            version_dirs.sort();
            version_dirs.reverse();

            for version_dir in version_dirs {
                candidates.push(version_dir.join("bin").join(name));
            }
        }
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .map(|path| path.display().to_string())
}

fn resolve_node_cmd() -> Option<String> {
    resolve_command_path("node", Some("OPENPROXY_NODE_PATH"))
}

fn claude_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Failed to resolve home directory")?;
    Ok(home.join(".claude").join("settings.json"))
}

fn opencode_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Failed to resolve home directory")?;
    Ok(home.join(".config").join("opencode").join("opencode.json"))
}

fn pi_models_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Failed to resolve home directory")?;
    Ok(home.join(".pi").join("agent").join("models.json"))
}

fn detect_binary(name: &str) -> Option<String> {
    resolve_command_path(name, None)
}

fn detect_version(name: &str) -> Option<String> {
    let binary = detect_binary(name)?;

    // Windows: skip desktop app paths, only detect CLI tools
    #[cfg(windows)]
    {
        let binary_lower = binary.to_lowercase();
        if binary_lower.contains("program files")
            || binary_lower.contains(r"\appdata\local\programs")
        {
            return None;
        }
    }

    let (tx, rx) = std::sync::mpsc::channel::<Option<std::process::Output>>();
    let binary_clone = binary.clone();
    std::thread::spawn(move || {
        let _ = tx.send(silent_command(&binary_clone).arg("--version").output().ok());
    });

    let output = rx.recv_timeout(Duration::from_secs(5)).ok().flatten()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if !stdout.is_empty() {
        return Some(stdout);
    }

    let stderr = String::from_utf8(output.stderr).ok()?.trim().to_string();
    if stderr.is_empty() {
        None
    } else {
        Some(stderr)
    }
}

fn read_json_or_empty(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }

    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    Ok(())
}

fn backup_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let backup_name = format!(
        "{}.openproxy.bak",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config")
    );
    let backup_path = path.with_file_name(backup_name);
    fs::copy(path, &backup_path)
        .map_err(|e| format!("Failed to backup {}: {}", path.display(), e))?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent_dir(path)?;
    fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

fn sync_claude_api_key_if_needed(config: &AppConfig, old_api_key: &str) -> Result<bool, String> {
    let path = claude_config_path()?;
    let mut value = read_json_or_empty(&path)?;
    let Some(env) = value.get_mut("env").and_then(|env| env.as_object_mut()) else {
        return Ok(false);
    };

    let base_matches = env
        .get("ANTHROPIC_BASE_URL")
        .and_then(|value| value.as_str())
        .map(|value| value == openproxy_anthropic_base_url(config))
        .unwrap_or(false);
    let key_matches = env
        .get("ANTHROPIC_AUTH_TOKEN")
        .and_then(|value| value.as_str())
        .map(|value| value == old_api_key)
        .unwrap_or(false);

    if !base_matches || !key_matches {
        return Ok(false);
    }

    backup_file(&path)?;
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        Value::String(config.proxy.api_key.clone()),
    );
    write_json(&path, &value)?;
    Ok(true)
}

fn sync_opencode_api_key_if_needed(config: &AppConfig, old_api_key: &str) -> Result<bool, String> {
    let path = opencode_config_path()?;
    let mut value = read_json_or_empty(&path)?;
    let Some(options) = value
        .get_mut("provider")
        .and_then(|providers| providers.get_mut("openproxy"))
        .and_then(|provider| provider.get_mut("options"))
        .and_then(|options| options.as_object_mut())
    else {
        return Ok(false);
    };

    let base_matches = options
        .get("baseURL")
        .and_then(|value| value.as_str())
        .map(|value| value == openproxy_openai_base_url(config))
        .unwrap_or(false);
    let key_matches = options
        .get("apiKey")
        .and_then(|value| value.as_str())
        .map(|value| value == old_api_key)
        .unwrap_or(false);

    if !base_matches || !key_matches {
        return Ok(false);
    }

    backup_file(&path)?;
    options.insert(
        "apiKey".to_string(),
        Value::String(config.proxy.api_key.clone()),
    );
    write_json(&path, &value)?;
    Ok(true)
}

fn sync_pi_api_key_if_needed(config: &AppConfig, old_api_key: &str) -> Result<bool, String> {
    let path = pi_models_path()?;
    let mut value = read_json_or_empty(&path)?;
    let Some(provider) = value
        .get_mut("providers")
        .and_then(|providers| providers.get_mut("openproxy"))
        .and_then(|provider| provider.as_object_mut())
    else {
        return Ok(false);
    };

    let base_matches = provider
        .get("baseUrl")
        .and_then(|value| value.as_str())
        .map(|value| value == openproxy_openai_base_url(config))
        .unwrap_or(false);
    let key_matches = provider
        .get("apiKey")
        .and_then(|value| value.as_str())
        .map(|value| value == old_api_key)
        .unwrap_or(false);

    if !base_matches || !key_matches {
        return Ok(false);
    }

    backup_file(&path)?;
    provider.insert(
        "apiKey".to_string(),
        Value::String(config.proxy.api_key.clone()),
    );
    write_json(&path, &value)?;
    Ok(true)
}

fn sync_migrated_tool_api_keys(config: &AppConfig, old_api_key: &str) {
    for (label, result) in [
        ("Claude", sync_claude_api_key_if_needed(config, old_api_key)),
        (
            "OpenCode",
            sync_opencode_api_key_if_needed(config, old_api_key),
        ),
        ("Pi", sync_pi_api_key_if_needed(config, old_api_key)),
    ] {
        match result {
            Ok(true) => eprintln!("[LOG] Migrated {} tool API key to new prefix", label),
            Ok(false) => {}
            Err(err) => eprintln!("[LOG] Failed to migrate {} tool API key: {}", label, err),
        }
    }
}

fn merge_json_value(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                match target_map.get_mut(&key) {
                    Some(existing) => merge_json_value(existing, patch_value),
                    None => {
                        target_map.insert(key, patch_value);
                    }
                }
            }
        }
        (target_slot, patch_value) => {
            *target_slot = patch_value;
        }
    }
}

fn build_openproxy_models_object(models: &[ToolModelConfig]) -> Value {
    let mut map = serde_json::Map::new();
    for model in models {
        map.insert(
            model.id.clone(),
            json!({
                "name": model.name,
                "limit": {
                    "context": model.context_window.unwrap_or(128000),
                    "output": model.max_output_tokens.unwrap_or(32000)
                },
                "options": {
                    "store": false
                },
                "variants": {
                    "high": {},
                    "low": {},
                    "medium": {}
                }
            }),
        );
    }
    Value::Object(map)
}

fn resolve_claude_mapping(
    models: &[ToolModelConfig],
    mapping: Option<ClaudeModelMapping>,
) -> Result<ClaudeModelMapping, String> {
    let mapping = mapping.ok_or("Claude 模型 ID 不能为空")?;
    let available_ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();

    let validate = |value: Option<String>, label: &str| -> Result<String, String> {
        let value = value
            .map(|item| item.trim().to_string())
            .filter(|item| !item.is_empty())
            .ok_or_else(|| format!("Claude {} 模型 ID 不能为空", label))?;

        if !value.starts_with("opencode/") && !value.starts_with("custom/") {
            return Err(format!(
                "Claude {} 模型 ID 需要使用 opencode/ 或 custom/ 前缀",
                label
            ));
        }

        if !available_ids.iter().any(|item| item == &value.as_str()) {
            return Err(format!(
                "Claude {} 模型 ID 不在当前模型列表中，请先刷新模型列表",
                label
            ));
        }

        Ok(value)
    };

    Ok(ClaudeModelMapping {
        opus: Some(validate(mapping.opus, "Opus")?),
        sonnet: Some(validate(mapping.sonnet, "Sonnet")?),
        haiku: Some(validate(mapping.haiku, "Haiku")?),
    })
}

fn configure_claude(
    config: &AppConfig,
    models: &[ToolModelConfig],
    mapping: Option<ClaudeModelMapping>,
) -> Result<(), String> {
    let path = claude_config_path()?;
    let mut value = read_json_or_empty(&path)?;
    if !value.is_object() {
        value = json!({});
    }

    backup_file(&path)?;

    let root = value
        .as_object_mut()
        .ok_or("Claude settings root must be an object")?;
    let env = root
        .entry("env")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Claude settings env must be an object")?;

    env.insert(
        "ANTHROPIC_BASE_URL".to_string(),
        Value::String(openproxy_anthropic_base_url(config)),
    );
    env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        Value::String(config.proxy.api_key.clone()),
    );
    env.insert(
        "API_TIMEOUT_MS".to_string(),
        Value::String(config.proxy_timeout_ms().to_string()),
    );
    env.insert(
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".to_string(),
        Value::String("1".to_string()),
    );

    let mapping = resolve_claude_mapping(models, mapping)?;
    let slots = [
        (
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            mapping.opus,
        ),
        (
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            mapping.sonnet,
        ),
        (
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
            mapping.haiku,
        ),
    ];

    for (model_key, name_key, model_id) in slots {
        if let Some(model_id) = model_id {
            env.insert(model_key.to_string(), Value::String(model_id.clone()));
            env.insert(name_key.to_string(), Value::String(model_id));
        }
    }

    write_json(&path, &value)
}

fn configure_opencode(config: &AppConfig, models: &[ToolModelConfig]) -> Result<(), String> {
    let path = opencode_config_path()?;
    let mut value = read_json_or_empty(&path)?;
    if !value.is_object() {
        value = json!({});
    }

    backup_file(&path)?;

    let root = value
        .as_object_mut()
        .ok_or("OpenCode config root must be an object")?;
    root.insert(
        "$schema".to_string(),
        Value::String("https://opencode.ai/config.json".to_string()),
    );

    let provider = root
        .entry("provider")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("OpenCode provider must be an object")?;

    provider.insert(
        "openproxy".to_string(),
        json!({
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "apiKey": config.proxy.api_key,
                "baseURL": openproxy_openai_base_url(config),
                "setCacheKey": true
            },
            "models": build_openproxy_models_object(models)
        }),
    );

    if !root.contains_key("model") {
        if let Some(model) = models.first() {
            root.insert(
                "model".to_string(),
                Value::String(format!("openproxy/{}", model.id)),
            );
        }
    }

    write_json(&path, &value)
}

fn sanitize_pi_input_modalities(input_modalities: &[String]) -> Vec<String> {
    let mut sanitized = Vec::new();

    for modality in input_modalities {
        let normalized = modality.trim().to_ascii_lowercase();
        if matches!(normalized.as_str(), "text" | "image") && !sanitized.contains(&normalized) {
            sanitized.push(normalized);
        }
    }

    if sanitized.is_empty() {
        sanitized.push("text".to_string());
    }

    sanitized
}

fn configure_pi(config: &AppConfig, models: &[ToolModelConfig]) -> Result<(), String> {
    let path = pi_models_path()?;
    let mut value = read_json_or_empty(&path)?;
    if !value.is_object() {
        value = json!({});
    }

    backup_file(&path)?;

    let root = value
        .as_object_mut()
        .ok_or("Pi models root must be an object")?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("Pi providers must be an object")?;

    let pi_models: Vec<Value> = models
        .iter()
        .map(|model| {
            json!({
                "id": model.id,
                "name": model.name,
                "reasoning": model.reasoning,
                "input": sanitize_pi_input_modalities(&model.input_modalities),
                "cost": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0
                },
                "contextWindow": model.context_window.unwrap_or(128000),
                "maxTokens": model.max_output_tokens.unwrap_or(32000)
            })
        })
        .collect();

    providers.insert(
        "openproxy".to_string(),
        json!({
            "baseUrl": openproxy_openai_base_url(config),
            "api": "openai-completions",
            "apiKey": config.proxy.api_key,
            "authHeader": true,
            "models": pi_models
        }),
    );

    write_json(&path, &value)
}

fn build_claude_status(config: &AppConfig, capabilities: &UpstreamCapabilities) -> ToolStatus {
    let path = claude_config_path().unwrap_or_else(|_| PathBuf::from("~/.claude/settings.json"));
    let binary_path = detect_binary("claude");
    let version = detect_version("claude");
    let mut configured = false;
    let mut configured_models = Vec::new();
    let mut claude_mapping = ClaudeModelMapping::default();

    if let Ok(value) = read_json_or_empty(&path) {
        if let Some(env) = value.get("env").and_then(|env| env.as_object()) {
            let expected_base = openproxy_anthropic_base_url(config);
            let expected_key = &config.proxy.api_key;
            let base_matches = env
                .get("ANTHROPIC_BASE_URL")
                .and_then(|value| value.as_str())
                .map(|value| value == expected_base)
                .unwrap_or(false);
            let key_matches = env
                .get("ANTHROPIC_AUTH_TOKEN")
                .and_then(|value| value.as_str())
                .map(|value| value == expected_key)
                .unwrap_or(false);
            configured = base_matches && key_matches;

            claude_mapping.opus = env
                .get("ANTHROPIC_DEFAULT_OPUS_MODEL")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            claude_mapping.sonnet = env
                .get("ANTHROPIC_DEFAULT_SONNET_MODEL")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());
            claude_mapping.haiku = env
                .get("ANTHROPIC_DEFAULT_HAIKU_MODEL")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string());

            for model in [
                claude_mapping.opus.as_ref(),
                claude_mapping.sonnet.as_ref(),
                claude_mapping.haiku.as_ref(),
            ] {
                if let Some(model) = model {
                    if !configured_models.iter().any(|item| item == model) {
                        configured_models.push(model.clone());
                    }
                }
            }
        }
    }

    let supported = capabilities.anthropic_supported && capabilities.anthropic_supports_tools;
    let support_reason = if !supported {
        capabilities.anthropic_reason.clone()
    } else {
        "Claude 可使用 opencode/ 模型经 OpenProxy bridge 接入，也可使用 custom/ 模型透传到自定义 Anthropic /v1/messages。".to_string()
    };

    ToolStatus {
        tool: "claude".to_string(),
        label: "Claude Code".to_string(),
        installed: binary_path.is_some(),
        binary_path: binary_path
            .as_ref()
            .map(|p| p.strip_suffix(".cmd").unwrap_or(p).to_string()),
        version,
        config_path: path.display().to_string(),
        configured,
        configured_models,
        claude_mapping: Some(claude_mapping),
        supported,
        support_reason,
    }
}

fn build_opencode_status(config: &AppConfig, capabilities: &UpstreamCapabilities) -> ToolStatus {
    let path = opencode_config_path()
        .unwrap_or_else(|_| PathBuf::from("~/.config/opencode/opencode.json"));
    let binary_path = detect_binary("opencode");
    let version = detect_version("opencode");
    let mut configured = false;
    let mut configured_models = Vec::new();

    if let Ok(value) = read_json_or_empty(&path) {
        if let Some(provider) = value
            .get("provider")
            .and_then(|provider| provider.get("openproxy"))
        {
            let base_matches = provider
                .get("options")
                .and_then(|options| options.get("baseURL"))
                .and_then(|value| value.as_str())
                .map(|value| value == openproxy_openai_base_url(config))
                .unwrap_or(false);
            let key_matches = provider
                .get("options")
                .and_then(|options| options.get("apiKey"))
                .and_then(|value| value.as_str())
                .map(|value| value == config.proxy.api_key)
                .unwrap_or(false);

            configured = base_matches && key_matches;

            if let Some(models) = provider.get("models").and_then(|models| models.as_object()) {
                configured_models.extend(models.keys().cloned());
            }
            if let Some(model) = value.get("model").and_then(|value| value.as_str()) {
                if let Some(stripped) = model.strip_prefix("openproxy/") {
                    if !configured_models.iter().any(|item| item == stripped) {
                        configured_models.push(stripped.to_string());
                    }
                }
            }
        }
    }

    let supported = capabilities.openai_supported;
    let support_reason = if !supported {
        capabilities.openai_reason.clone()
    } else {
        String::new()
    };

    ToolStatus {
        tool: "opencode".to_string(),
        label: "OpenCode".to_string(),
        installed: binary_path.is_some(),
        binary_path: binary_path
            .as_ref()
            .map(|p| p.strip_suffix(".cmd").unwrap_or(p).to_string()),
        version,
        config_path: path.display().to_string(),
        configured,
        configured_models,
        claude_mapping: None,
        supported,
        support_reason,
    }
}

fn build_pi_status(config: &AppConfig, capabilities: &UpstreamCapabilities) -> ToolStatus {
    let path = pi_models_path().unwrap_or_else(|_| PathBuf::from("~/.pi/agent/models.json"));
    let binary_path = detect_binary("pi");
    let version = detect_version("pi");
    let mut configured = false;
    let mut configured_models = Vec::new();

    if let Ok(value) = read_json_or_empty(&path) {
        if let Some(provider) = value
            .get("providers")
            .and_then(|providers| providers.get("openproxy"))
        {
            let base_matches = provider
                .get("baseUrl")
                .and_then(|value| value.as_str())
                .map(|value| value == openproxy_openai_base_url(config))
                .unwrap_or(false);
            let key_matches = provider
                .get("apiKey")
                .and_then(|value| value.as_str())
                .map(|value| value == config.proxy.api_key)
                .unwrap_or(false);
            configured = base_matches && key_matches;

            if let Some(models) = provider.get("models").and_then(|models| models.as_array()) {
                for model in models {
                    if let Some(id) = model.get("id").and_then(|value| value.as_str()) {
                        configured_models.push(id.to_string());
                    }
                }
            }
        }
    }

    let supported = capabilities.openai_supported;
    let support_reason = if !supported {
        capabilities.openai_reason.clone()
    } else {
        String::new()
    };

    ToolStatus {
        tool: "pi".to_string(),
        label: "Pi Agent".to_string(),
        installed: binary_path.is_some(),
        binary_path: binary_path
            .as_ref()
            .map(|p| p.strip_suffix(".cmd").unwrap_or(p).to_string()),
        version,
        config_path: path.display().to_string(),
        configured,
        configured_models,
        claude_mapping: None,
        supported,
        support_reason,
    }
}

impl AppConfig {
    fn proxy_timeout_ms(&self) -> u64 {
        self.proxy.timeout.unwrap_or(3_000_000)
    }
}

#[tauri::command]
async fn start_proxy(app: tauri::AppHandle) -> Result<ProxyStatus, String> {
    start_proxy_with_handle(&app)
}

#[tauri::command]
async fn stop_proxy(app: tauri::AppHandle) -> Result<(), String> {
    stop_proxy_with_handle(&app)
}

#[tauri::command]
async fn get_proxy_status(app: tauri::AppHandle) -> Result<ProxyStatus, String> {
    let status = current_proxy_status(&app)?;
    eprintln!(
        "[LOG] get_proxy_status: running={}, port={}",
        status.running, status.port
    );
    Ok(status)
}

#[tauri::command]
async fn get_config(state: tauri::State<'_, AppState>) -> Result<AppConfig, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.clone())
}

#[tauri::command]
async fn save_config(state: tauri::State<'_, AppState>, patch: Value) -> Result<(), String> {
    if !patch.is_object() {
        return Err("Config patch must be a JSON object".to_string());
    }

    let current_config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let mut next_value = serde_json::to_value(&current_config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    merge_json_value(&mut next_value, patch);
    migrate_config_value(&mut next_value);

    let mut new_config: AppConfig =
        serde_json::from_value(next_value).map_err(|e| format!("Invalid config patch: {}", e))?;

    normalize_app_config(&mut new_config);

    // 验证端口范围
    if new_config.proxy.port < 1024 {
        return Err("Port must be between 1024 and 65535".to_string());
    }

    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    *config = new_config.clone();
    drop(config);

    clear_probe_cache(state.inner());

    // 持久化到文件
    save_config_to_file(&state.config_path, &new_config)?;

    Ok(())
}

#[tauri::command]
async fn get_api_key(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.proxy.api_key.clone())
}

#[tauri::command]
async fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut clipboard =
        Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("Failed to write clipboard: {}", e))
}

#[tauri::command]
async fn open_path_in_finder(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let open_target = if target.is_dir() {
        target
    } else {
        target
            .parent()
            .map(|value| value.to_path_buf())
            .ok_or_else(|| format!("Path has no parent directory: {}", path))?
    };

    if !open_target.exists() {
        return Err(format!("Path does not exist: {}", open_target.display()));
    }

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(windows)]
    let cmd = "explorer";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    Command::new(cmd)
        .arg(&open_target)
        .spawn()
        .map_err(|e| format!("Failed to open path: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn detect_tool_configs(state: tauri::State<'_, AppState>) -> Result<Vec<ToolStatus>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    let capabilities = infer_upstream_capabilities(&config);

    Ok(vec![
        build_claude_status(&config, &capabilities),
        build_pi_status(&config, &capabilities),
        build_opencode_status(&config, &capabilities),
    ])
}

#[tauri::command]
async fn configure_tool(
    state: tauri::State<'_, AppState>,
    tool: String,
    models: Vec<ToolModelConfig>,
    claude_mapping: Option<ClaudeModelMapping>,
) -> Result<ToolStatus, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();

    match tool.as_str() {
        "claude" => configure_claude(&config, &models, claude_mapping)?,
        "pi" => configure_pi(&config, &models)?,
        "opencode" => configure_opencode(&config, &models)?,
        _ => return Err(format!("Unsupported tool: {}", tool)),
    }

    clear_probe_cache(state.inner());
    let capabilities = infer_upstream_capabilities(&config);

    let status = match tool.as_str() {
        "claude" => build_claude_status(&config, &capabilities),
        "pi" => build_pi_status(&config, &capabilities),
        "opencode" => build_opencode_status(&config, &capabilities),
        _ => unreachable!(),
    };

    Ok(status)
}

#[tauri::command]
async fn get_upstream_capabilities(
    state: tauri::State<'_, AppState>,
) -> Result<UpstreamCapabilities, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    Ok(infer_upstream_capabilities(&config))
}

/// 获取本机局域网 IP 地址
#[tauri::command]
async fn detect_custom_service_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<ToolModelConfig>, String> {
    let trimmed_base_url = base_url.trim().to_string();
    let trimmed_api_key = api_key.trim().to_string();

    if trimmed_base_url.is_empty() || trimmed_api_key.is_empty() {
        return Err("请填写 Base URL 和 API Key".to_string());
    }

    detect_custom_openai_models_direct(trimmed_base_url, trimmed_api_key).await
}

#[tauri::command]
async fn get_lan_ip() -> Result<String, String> {
    use std::net::UdpSocket;
    let socket =
        UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("Failed to bind UDP socket: {}", e))?;
    socket
        .connect("8.8.8.8:80")
        .map_err(|e| format!("Failed to connect: {}", e))?;
    match socket.local_addr() {
        Ok(addr) => Ok(addr.ip().to_string()),
        Err(e) => Err(format!("Failed to get local address: {}", e)),
    }
}

fn get_config_path(app_handle: &tauri::AppHandle) -> PathBuf {
    // Strategy 1: Try Tauri resource path resolution (bundled resources)
    if let Ok(resource_path) = app_handle
        .path()
        .resolve("config/default.json", BaseDirectory::Resource)
    {
        if resource_path.exists() {
            return resource_path;
        }
    }

    // Strategy 2: Try relative to executable (app bundle layout)
    // In a macOS app bundle:
    //   openproxy.app/Contents/MacOS/openproxy  (executable)
    //   openproxy.app/Contents/Resources/_up_/config/default.json  (bundled resource)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            // parent = Contents/MacOS
            let candidate1 = parent
                .join("..")
                .join("Resources")
                .join("_up_")
                .join("config")
                .join("default.json");
            if candidate1.exists() {
                return candidate1;
            }

            // Also try without _up_ prefix
            let candidate2 = parent
                .join("..")
                .join("Resources")
                .join("config")
                .join("default.json");
            if candidate2.exists() {
                return candidate2;
            }

            // Try one level up from MacOS (for some bundle layouts)
            let candidate3 = parent
                .join("..")
                .join("..")
                .join("config")
                .join("default.json");
            if candidate3.exists() {
                return candidate3;
            }
        }
    }

    // Strategy 3: Development mode - relative to current dir
    // In `tauri dev`, cwd is `src-tauri/`, config is at project root `config/default.json`
    if let Ok(dir) = std::env::current_dir() {
        let candidates = [
            dir.join("config").join("default.json"), // project root
            dir.join("..").join("config").join("default.json"), // src-tauri/../config
        ];
        for candidate in candidates {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    // Strategy 4: User home directory fallback
    if let Some(home) = dirs::home_dir() {
        let candidate = home.join(".openproxy").join("config.json");
        if candidate.exists() {
            return candidate;
        }
    }

    // Absolute fallback
    if let Some(home) = dirs::home_dir() {
        return home.join(".openproxy").join("config.json");
    }

    std::env::current_dir()
        .expect("Cannot get current dir")
        .join("config.json")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .on_window_event(|window, event| {
            if window.label() == SETTINGS_WINDOW_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let config_path = get_config_path(app.handle());
            let mut config = read_config(&config_path).unwrap_or_else(|e| {
                eprintln!("Failed to read config: {}, using defaults", e);
                default_app_config()
            });

            let normalized = normalize_app_config(&mut config);

            if !config_path.exists() {
                if let Err(err) = save_config_to_file(&config_path, &config) {
                    eprintln!("[LOG] Failed to persist default config: {}", err);
                }
            }

            if let Some(old_api_key) = migrate_config_api_key(&mut config) {
                match save_config_to_file(&config_path, &config) {
                    Ok(()) => {
                        eprintln!("[LOG] Migrated API key prefix from legacy format");
                    }
                    Err(err) => {
                        eprintln!("[LOG] Failed to persist migrated API key: {}", err);
                    }
                }
                sync_migrated_tool_api_keys(&config, &old_api_key);
            } else if normalized {
                if let Err(err) = save_config_to_file(&config_path, &config) {
                    eprintln!("[LOG] Failed to persist normalized config: {}", err);
                }
            }

            // Store AppState with config_path
            app.manage(AppState {
                proxy: Mutex::new(None),
                config: Mutex::new(config),
                config_path,
                tray_animating: Arc::new(Mutex::new(false)),
                probe_cache: Mutex::new(None),
            });

            if let Err(err) = build_tray(app.handle()) {
                eprintln!("[LOG] Failed to build tray: {}", err);
            }

            // 自动启动代理服务
            if let Err(e) = start_proxy_with_handle(app.handle()) {
                eprintln!("[LOG] Failed to auto-start proxy: {}", e);
            }

            #[cfg(target_os = "macos")]
            {
                let app_handle = app.handle().clone();
                let _ = catch_unwind(AssertUnwindSafe(move || {
                    let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }))
                .map_err(|_| eprintln!("[LOG] Failed to set macOS activation policy"));
            }

            if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
                if let Err(err) = window.set_title("OpenProxy Panel") {
                    eprintln!("[LOG] Failed to set window title: {}", err);
                }
                if let Err(err) = window.set_background_color(Some(Color(0, 0, 0, 0))) {
                    eprintln!("[LOG] Failed to set window background color: {}", err);
                }
                if let Err(err) = window.hide() {
                    eprintln!("[LOG] Failed to hide window during setup: {}", err);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_proxy,
            stop_proxy,
            get_proxy_status,
            get_config,
            save_config,
            get_api_key,
            copy_to_clipboard,
            open_path_in_finder,
            detect_tool_configs,
            configure_tool,
            get_upstream_capabilities,
            detect_custom_service_models,
            get_lan_ip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
