//! 只绑定回环地址的 HTTP + WebSocket 服务。
//! 网页可以向 127.0.0.1 发请求，所以必须校验 Host（防 DNS rebinding）和 Origin（防跨站读取），
//! 否则任何打开的网站都能读走本机的进程和连接信息。

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use observatory_core::collector::Collector;
use std::sync::Arc;
use tokio::sync::broadcast;

const UI: &str = include_str!(concat!(env!("OUT_DIR"), "/ui.html"));
const VITE_PORT: u16 = 5173;

#[derive(Clone)]
pub struct AppState {
    pub collector: Arc<Collector>,
    pub frames: broadcast::Sender<Arc<str>>,
    pub port: u16,
    pub dev: bool,
}

pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    host.is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"))
}

/// 没有 Origin 的是命令行工具等非浏览器客户端，它们本来就能直接读系统连接表
pub fn origin_allowed(origin: Option<&str>, port: u16, dev: bool) -> bool {
    let Some(origin) = origin else { return true };
    let allowed = |p: u16| origin == format!("http://127.0.0.1:{p}") || origin == format!("http://localhost:{p}");
    allowed(port) || (dev && allowed(VITE_PORT))
}

async fn guard(State(app): State<AppState>, req: Request, next: Next) -> Response {
    let headers = req.headers();
    let text = |name| headers.get(name).and_then(|v: &HeaderValue| v.to_str().ok());
    if !host_allowed(text(header::HOST), app.port) {
        return (StatusCode::FORBIDDEN, "Host 不被允许").into_response();
    }
    if !origin_allowed(text(header::ORIGIN), app.port, app.dev) {
        return (StatusCode::FORBIDDEN, "Origin 不被允许").into_response();
    }
    next.run(req).await
}

async fn index() -> impl IntoResponse {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    (headers, Html(UI))
}

async fn ws(State(app): State<AppState>, upgrade: WebSocketUpgrade) -> Response {
    upgrade.on_upgrade(move |socket| client(socket, app))
}

async fn client(mut socket: WebSocket, app: AppState) {
    // 先订阅再取历史，避免漏掉中间的帧
    let mut frames = app.frames.subscribe();
    let hello = app.collector.hello();
    if socket.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            frame = frames.recv() => match frame {
                Ok(json) => {
                    if socket.send(Message::Text(json.as_ref().into())).await.is_err() {
                        return;
                    }
                }
                // 客户端处理不过来：跳过积压的帧，下一帧仍然是完整快照
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/ws", get(ws))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_check_blocks_dns_rebinding() {
        assert!(host_allowed(Some("127.0.0.1:9470"), 9470));
        assert!(host_allowed(Some("localhost:9470"), 9470));
        assert!(!host_allowed(Some("evil.example:9470"), 9470));
        assert!(!host_allowed(Some("127.0.0.1:1"), 9470));
        assert!(!host_allowed(None, 9470));
    }

    #[test]
    fn origin_check_blocks_other_sites() {
        assert!(origin_allowed(Some("http://127.0.0.1:9470"), 9470, false));
        assert!(origin_allowed(None, 9470, false));
        assert!(!origin_allowed(Some("https://evil.example"), 9470, false));
        assert!(!origin_allowed(Some("http://localhost:9470.evil.example"), 9470, false));
        assert!(!origin_allowed(Some("null"), 9470, false));
        // Vite 开发服务器只在 --dev 时放行
        assert!(!origin_allowed(Some("http://localhost:5173"), 9470, false));
        assert!(origin_allowed(Some("http://localhost:5173"), 9470, true));
    }
}
