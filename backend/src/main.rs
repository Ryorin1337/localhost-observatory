//! 可独立运行的本地服务：只监听 127.0.0.1，用浏览器访问。
//! 桌面应用见 src-tauri，它和这里共用 observatory_core。

mod server;

use observatory_core::collector::{Collector, Options};
use observatory_core::elevation;
use server::AppState;
use std::sync::Arc;
use tokio::sync::broadcast;

const DEFAULT_PORT: u16 = 9470;
/// 和桌面应用用不同的名字，两个可以同时运行
const ETW_SESSION: &str = "LocalhostObservatory";

struct Args {
    port: u16,
    dev: bool,
    diag_etw: u32,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args { port: DEFAULT_PORT, dev: false, diag_etw: 0 };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--port" => {
                args.port = it.next().and_then(|v| v.parse().ok()).ok_or("--port 需要一个端口号")?;
            }
            "--dev" => args.dev = true,
            "--diag-etw" => {
                args.diag_etw = it.next().and_then(|v| v.parse().ok()).ok_or("--diag-etw 需要事件条数")?;
            }
            "-h" | "--help" => {
                println!("用法: observatory [--port {DEFAULT_PORT}] [--dev] [--diag-etw N]");
                println!("  --dev        允许 Vite 开发服务器 (localhost:5173) 连接");
                println!("  --diag-etw N 打印前 N 条网络 ETW 事件，用于排查");
                std::process::exit(0);
            }
            other => return Err(format!("未知参数 {other}，用 --help 查看用法")),
        }
    }
    Ok(args)
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };

    let (frames, _) = broadcast::channel::<Arc<str>>(16);
    let tx = frames.clone();
    // 没有客户端时 send 返回错误，属于正常情况
    let collector = Arc::new(Collector::start(Options { session: ETW_SESSION, diag_etw: args.diag_etw }, move |json| {
        let _ = tx.send(json);
    }));

    if !elevation::is_elevated() {
        eprintln!("未以管理员身份运行：只有连接、状态和进程树可用。");
        eprintln!("速率、域名、RTT 和协议识别需要从管理员终端启动。");
    }
    for err in collector.capture().errors {
        eprintln!("{err}");
    }

    let app = server::router(AppState { collector: collector.clone(), frames, port: args.port, dev: args.dev });
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await {
        Ok(l) => l,
        Err(err) => {
            eprintln!("无法监听 127.0.0.1:{}：{err}。可以用 --port 换一个端口。", args.port);
            std::process::exit(1);
        }
    };
    println!("Localhost Observatory 已启动：http://127.0.0.1:{}", args.port);

    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Err(err) = axum::serve(listener, app).with_graceful_shutdown(shutdown).await {
        eprintln!("服务异常退出：{err}");
    }
    collector.shutdown();
    std::process::exit(0);
}
