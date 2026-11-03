//! 和前端 `src/lib/types.ts` 一一对应的数据契约。

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct Transition {
    pub state: &'static str,
    pub t: u64,
}

#[derive(Serialize, Clone, Debug)]
pub struct HttpRequest {
    pub t: u64,
    pub method: String,
    pub path: String,
    pub status: u16,
    pub ms: u64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub identified_by: String,
    pub fields: Vec<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<Vec<HttpRequest>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Conn {
    pub id: String,
    pub pid: u32,
    pub proc_name: String,
    pub l4: &'static str,
    pub l7: String,
    pub direction: &'static str,
    pub local_ip: String,
    pub local_port: u16,
    pub remote_ip: String,
    pub remote_port: u16,
    pub host: String,
    pub state: &'static str,
    pub transitions: Vec<Transition>,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<&'static str>,
    pub rx_rate: f64,
    pub tx_rate: f64,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// 0 表示未知
    pub rtt_ms: f64,
    pub retrans: u32,
    pub inspect: Inspection,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    /// 上报的父 PID。父进程可能已退出，PID 也可能被复用，前端建树时会用启动时间校验
    pub ppid: u32,
    pub name: String,
    pub exe: String,
    pub cmd: String,
    pub started_at: u64,
    pub memory_bytes: u64,
    pub cpu_percent: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub t: u64,
    pub conn_id: String,
    pub proc_name: String,
    pub host: String,
    pub from: Option<&'static str>,
    pub to: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<&'static str>,
}

/// 当前权限下哪些采集能力真正可用，前端据此如实提示
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub elevated: bool,
    pub rates: bool,
    pub dns: bool,
    pub payload: bool,
    pub rtt: bool,
    /// 采集没能启动的原因。桌面应用没有终端，只能靠界面告诉用户
    pub errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub t: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub procs: Option<&'a [ProcInfo]>,
    pub conns: Vec<Conn>,
    pub events: &'a [StateEvent],
    pub capture: &'a CaptureInfo,
}

#[derive(Serialize)]
pub struct ConnHistory<'a> {
    pub id: &'a str,
    /// [t, rx, tx]
    pub points: Vec<(u64, f64, f64)>,
}

/// 新客户端连上时补发的历史，刷新页面后曲线和时间线不会从零开始
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub t: u64,
    pub procs: &'a [ProcInfo],
    pub events: Vec<&'a StateEvent>,
    pub history: Vec<ConnHistory<'a>>,
    pub capture: &'a CaptureInfo,
}
