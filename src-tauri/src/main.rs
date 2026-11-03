// 发布版不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Localhost Observatory 桌面应用。采集核心和独立服务共用，区别是数据走应用内部的 IPC，
//! 不监听任何本地端口，其他程序和网页都没有办法连上来读取连接信息。

use observatory_core::collector::{Collector, Options};
use observatory_core::elevation;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use tauri::{AppHandle, Manager, RunEvent, State};

/// 和独立服务（observatory.exe）用不同的名字，两个可以同时运行
const ETW_SESSION: &str = "LocalhostObservatoryApp";
/// 以管理员身份重启时最多等旧进程退出多久
const PARENT_EXIT_WAIT_MS: u32 = 15_000;

type Subscribers = Arc<Mutex<Vec<Channel<InvokeResponseBody>>>>;

struct AppState {
    collector: Collector,
    subscribers: Subscribers,
}

/// 前端启动时调用：登记接收每秒一帧的通道，并返回进程表、历史曲线和最近的事件
#[tauri::command]
fn subscribe(on_frame: Channel<InvokeResponseBody>, state: State<'_, AppState>) -> Response {
    {
        let mut subscribers = state.subscribers.lock().unwrap();
        // 只有一个窗口。页面刷新后旧通道已经失效，留着只会白白发送
        subscribers.clear();
        subscribers.push(on_frame);
    }
    // 先登记再取历史，不会漏掉中间的帧；前端按时间戳丢掉重复的
    Response::new(state.collector.hello())
}

/// 以管理员身份重启。用户在系统弹窗里点“否”时返回错误，应用继续运行
#[tauri::command]
fn relaunch_elevated(app: AppHandle) -> Result<(), String> {
    elevation::relaunch_elevated()?;
    app.exit(0);
    Ok(())
}

fn main() {
    // 提权重启出来的新进程要等旧进程退出，否则单实例检查会把它当成第二个实例直接退出
    if let Some(pid) = elevation::parent_to_wait_for() {
        elevation::wait_for_exit(pid, PARENT_EXIT_WAIT_MS);
    }

    tauri::Builder::default()
        // 必须最先注册：第二个实例在这里退出，不能让它先去启动 ETW 会话，把第一个实例的会话清掉
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![subscribe, relaunch_elevated])
        .setup(|app| {
            let subscribers: Subscribers = Arc::default();
            let fanout = subscribers.clone();
            let collector = Collector::start(Options { session: ETW_SESSION, diag_etw: 0 }, move |json| {
                // 发送失败说明页面已经关闭
                fanout.lock().unwrap().retain(|channel| channel.send(InvokeResponseBody::Json(json.to_string())).is_ok());
            });
            app.manage(AppState { collector, subscribers });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动应用")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // 进程退出时 ETW 会话不会自己消失，要显式结束
                if let Some(state) = app.try_state::<AppState>() {
                    state.collector.shutdown();
                }
            }
        });
}
