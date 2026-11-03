//! 采集线程：轮询连接表、读 RTT 和进程表，每秒把一帧 JSON 交给调用方。

use crate::engine::Engine;
use crate::flows::Shared;
use crate::model::CaptureInfo;
use crate::{capture, elevation, etw, procs, tables};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const POLL_EVERY: Duration = Duration::from_millis(250);
const PROCS_EVERY: Duration = Duration::from_secs(5);
const PROCS_MIN_GAP: Duration = Duration::from_secs(1);
const RTT_EVERY: Duration = Duration::from_secs(2);
const PRUNE_EVERY: Duration = Duration::from_secs(60);

pub struct Options {
    /// ETW 会话名。不同的程序要用不同的名字，否则一个启动时会把另一个的会话清掉
    pub session: &'static str,
    /// 把前 N 条网络 ETW 事件打印到 stderr，用来排查
    pub diag_etw: u32,
}

pub struct Collector {
    engine: Arc<Mutex<Engine>>,
    session: &'static str,
    elevated: bool,
    _etw: Option<etw::EtwSession>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Collector {
    /// 启动采集。`on_frame` 在采集线程里每秒调用一次，不能阻塞
    pub fn start(options: Options, on_frame: impl Fn(Arc<str>) + Send + 'static) -> Self {
        let shared = Arc::new(Shared::default());
        let elevated = elevation::is_elevated();
        let mut capture = CaptureInfo { elevated, rtt: elevated, ..Default::default() };

        let mut etw_session = None;
        if elevated {
            etw::stop_session(options.session);
            match etw::start(shared.clone(), options.session, options.diag_etw) {
                Ok(session) => {
                    capture.rates = true;
                    capture.dns = true;
                    etw_session = Some(session);
                }
                Err(err) => capture.errors.push(format!("ETW 启动失败，速率和域名不可用：{err}")),
            }
            match capture::start(shared.clone()) {
                Ok(()) => capture.payload = true,
                Err(err) => capture.errors.push(format!("抓包启动失败，协议只能按端口推断：{err}")),
            }
        }

        let mut engine = Engine::default();
        engine.capture = capture;
        engine.resolver = Some(procs::image_name);
        let engine = Arc::new(Mutex::new(engine));

        let thread_engine = engine.clone();
        std::thread::Builder::new()
            .name("collector".into())
            .spawn(move || run_loop(thread_engine, shared, on_frame, elevated))
            .expect("无法启动采集线程");

        Collector { engine, session: options.session, elevated, _etw: etw_session }
    }

    /// 新客户端连上时的初始数据：进程表、历史曲线、最近的事件
    pub fn hello(&self) -> String {
        self.engine.lock().unwrap().hello(now_ms())
    }

    pub fn capture(&self) -> CaptureInfo {
        self.engine.lock().unwrap().capture.clone()
    }

    /// 退出前调用：显式结束 ETW 会话，否则它会残留在系统里
    pub fn shutdown(&self) {
        if self.elevated {
            etw::stop_session(self.session);
        }
    }
}

/// 250ms 轮询连接表，整秒结算一次并推送
fn run_loop(engine: Arc<Mutex<Engine>>, shared: Arc<Shared>, on_frame: impl Fn(Arc<str>), rtt_enabled: bool) {
    let mut reader = procs::ProcReader::new();
    engine.lock().unwrap().set_procs(reader.read());

    let mut last_procs = Instant::now();
    let mut last_rtt = Instant::now();
    let mut last_prune = Instant::now();
    let mut last_tick = Instant::now();
    // 帧时间对齐到整秒，前端按秒聚合时不会缺点或重复
    let mut next_tick = now_ms() / 1000 * 1000 + 1000;
    let mut scopes: HashMap<(SocketAddr, SocketAddr), (u32, u32)> = HashMap::new();

    loop {
        let poll_started = Instant::now();
        let tcp = tables::read_tcp();
        let udp = tables::read_udp();
        if rtt_enabled {
            scopes.clear();
            scopes.extend(tcp.iter().filter(|r| r.local.is_ipv6()).map(|r| ((r.local, r.remote), (r.local_scope, r.remote_scope))));
        }
        let now = now_ms();
        let (unknown, established) = {
            let mut e = engine.lock().unwrap();
            e.apply_tables(tcp, udp, now);
            (e.unknown_pid, if rtt_enabled && last_rtt.elapsed() >= RTT_EVERY { Some(e.established()) } else { None })
        };

        if let Some(keys) = established {
            last_rtt = Instant::now();
            // 系统调用放在锁外，不阻塞新客户端的 hello
            let rtts: Vec<_> = keys
                .into_iter()
                .filter_map(|k| {
                    let scope = scopes.get(&k).copied().unwrap_or((0, 0));
                    tables::read_rtt(k.0, k.1, scope).map(|ms| (k, ms))
                })
                .collect();
            let mut e = engine.lock().unwrap();
            for (k, ms) in rtts {
                e.set_rtt(k, ms);
            }
        }

        let refresh_due = last_procs.elapsed() >= PROCS_EVERY || (unknown && last_procs.elapsed() >= PROCS_MIN_GAP);
        if refresh_due {
            let list = reader.read();
            engine.lock().unwrap().set_procs(list);
            last_procs = Instant::now();
        }

        if last_prune.elapsed() >= PRUNE_EVERY {
            shared.prune_flows(now);
            last_prune = Instant::now();
        }

        if now_ms() >= next_tick {
            let elapsed = last_tick.elapsed().as_secs_f64();
            last_tick = Instant::now();
            let json = engine.lock().unwrap().tick(&shared, next_tick, elapsed);
            on_frame(Arc::from(json));
            next_tick = (now_ms() / 1000 + 1) * 1000;
        }

        std::thread::sleep(POLL_EVERY.saturating_sub(poll_started.elapsed()));
    }
}
