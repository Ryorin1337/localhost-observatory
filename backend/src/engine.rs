//! 状态引擎：把每次轮询到的连接表和 ETW 计数合并成带生命周期的连接。
//! 不直接调用系统 API，可以用构造的数据做单元测试。

use crate::flows::{Counters, FlowKey, Shared};
use crate::model::*;
use crate::parse::{infer_l7, Proto};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};

const HISTORY_POINTS: usize = 300;
const MAX_EVENTS: usize = 300;
const RETAIN_CLOSED_MS: u64 = 5 * 60_000;
const MAX_CLOSED: usize = 800;
/// UDP 没有关闭信号，这么久没有流量就算流结束
const UDP_IDLE_MS: u64 = 30_000;

#[derive(Clone, Debug)]
pub struct TcpRow {
    pub state: &'static str,
    pub local: SocketAddr,
    pub remote: SocketAddr,
    pub pid: u32,
    pub created_at: Option<u64>,
    pub local_scope: u32,
    pub remote_scope: u32,
}

#[derive(Clone, Debug)]
pub struct UdpRow {
    pub local: SocketAddr,
    pub pid: u32,
    pub created_at: Option<u64>,
}

struct Track {
    conn: Conn,
    history: VecDeque<(u64, f64, f64)>,
    last_active: u64,
    generation: u64,
}

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
struct UdpFlowId(u32, SocketAddr, SocketAddr);

#[derive(Default)]
pub struct Engine {
    tcp: HashMap<(SocketAddr, SocketAddr), Track>,
    udp_bound: HashMap<(SocketAddr, u32), Track>,
    udp_flows: HashMap<UdpFlowId, Track>,
    closed: VecDeque<Track>,
    seq: u64,
    generation: u64,
    new_events: Vec<StateEvent>,
    events: VecDeque<StateEvent>,
    pub procs: Vec<ProcInfo>,
    proc_names: HashMap<u32, String>,
    /// 出现了进程表里没有的 PID，需要尽快刷新进程表
    pub unknown_pid: bool,
    procs_changed: bool,
    pub capture: CaptureInfo,
    /// 进程表里没有这个 PID 时的补救查询，测试里换成假的
    pub resolver: Option<fn(u32) -> Option<String>>,
    /// 最近一帧的时间。hello 要用它，客户端才能丢掉已经包含在历史里的帧
    last_t: u64,
}

fn is_unspecified(ip: IpAddr) -> bool {
    ip.is_unspecified()
}

impl Engine {
    pub fn set_procs(&mut self, procs: Vec<ProcInfo>) {
        self.proc_names = procs.iter().map(|p| (p.pid, p.name.clone())).collect();
        // 连接可能比进程表先出现，这里补上当时还不知道的进程名
        for track in self.tcp.values_mut().chain(self.udp_bound.values_mut()).chain(self.udp_flows.values_mut()) {
            if track.conn.pid != 0 {
                if let Some(name) = self.proc_names.get(&track.conn.pid) {
                    track.conn.proc_name.clone_from(name);
                }
            }
        }
        self.procs = procs;
        self.procs_changed = true;
        self.unknown_pid = false;
    }

    fn proc_name(&mut self, pid: u32) -> String {
        // TIME_WAIT 行的 PID 是 0：所属进程已释放这个连接，并不属于 System Idle
        if pid == 0 {
            return "（已结束进程）".into();
        }
        if let Some(name) = self.proc_names.get(&pid) {
            return name.clone();
        }
        match self.resolver.and_then(|resolve| resolve(pid)) {
            Some(name) => {
                self.proc_names.insert(pid, name.clone());
                // 进程树要的是完整的进程表，所以仍然尽快刷新一次
                self.unknown_pid = true;
                name
            }
            None => {
                self.unknown_pid = true;
                format!("PID {pid}")
            }
        }
    }

    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("c{}", self.seq)
    }

    fn event(&mut self, conn: &Conn, t: u64, from: Option<&'static str>, to: &'static str) {
        self.new_events.push(StateEvent {
            t,
            conn_id: conn.id.clone(),
            proc_name: conn.proc_name.clone(),
            host: conn.host.clone(),
            from,
            to,
            failure: conn.failure,
        });
    }

    /// 处理一次轮询结果
    pub fn apply_tables(&mut self, tcp: Vec<TcpRow>, udp: Vec<UdpRow>, now: u64) {
        self.generation += 1;
        let generation = self.generation;
        let listening: HashSet<u16> = tcp.iter().filter(|r| r.state == "LISTEN").map(|r| r.local.port()).collect();

        for row in tcp {
            let key = (row.local, row.remote);
            if let Some(mut track) = self.tcp.remove(&key) {
                track.generation = generation;
                if row.pid != 0 && track.conn.pid != row.pid {
                    track.conn.pid = row.pid;
                    track.conn.proc_name = self.proc_name(row.pid);
                }
                if track.conn.state != row.state {
                    let from = track.conn.state;
                    track.conn.state = row.state;
                    track.conn.transitions.push(Transition { state: row.state, t: now });
                    let conn = track.conn.clone();
                    self.event(&conn, now, Some(from), row.state);
                }
                self.tcp.insert(key, track);
            } else {
                let track = self.new_tcp(&row, &listening, now, generation);
                self.tcp.insert(key, track);
            }
        }

        let gone: Vec<_> = self.tcp.iter().filter(|(_, t)| t.generation != generation).map(|(k, _)| *k).collect();
        for key in gone {
            let mut track = self.tcp.remove(&key).unwrap();
            let from = track.conn.state;
            // 只有握手没完成就消失才算建连失败。系统不告诉我们原因，所以不细分超时或被拒绝
            if matches!(from, "SYN_SENT" | "SYN_RCVD") {
                track.conn.failure = Some("failed");
            }
            self.close(&mut track, now, from);
            self.closed.push_back(track);
        }

        for row in udp {
            let key = (row.local, row.pid);
            if let Some(track) = self.udp_bound.get_mut(&key) {
                track.generation = generation;
            } else {
                let track = self.new_udp_bound(&row, now, generation);
                self.udp_bound.insert(key, track);
            }
        }
        let gone: Vec<_> = self.udp_bound.iter().filter(|(_, t)| t.generation != generation).map(|(k, _)| *k).collect();
        for key in gone {
            // 绑定的端口不是连接，解绑后直接移除，不进已关闭列表
            self.udp_bound.remove(&key);
        }
    }

    fn close(&mut self, track: &mut Track, now: u64, from: &'static str) {
        track.conn.state = "CLOSED";
        track.conn.ended_at = Some(now);
        track.conn.rx_rate = 0.0;
        track.conn.tx_rate = 0.0;
        track.conn.transitions.push(Transition { state: "CLOSED", t: now });
        let conn = track.conn.clone();
        self.event(&conn, now, Some(from), "CLOSED");
    }

    fn new_tcp(&mut self, row: &TcpRow, listening: &HashSet<u16>, now: u64, generation: u64) -> Track {
        let is_listen = row.state == "LISTEN";
        let direction = if is_listen {
            "listen"
        } else if listening.contains(&row.local.port()) {
            "in"
        } else {
            "out"
        };
        let start = row.created_at.filter(|c| *c <= now).unwrap_or(now);
        let conn = Conn {
            id: self.next_id(),
            pid: row.pid,
            proc_name: self.proc_name(row.pid),
            l4: "TCP",
            l7: "未识别".into(),
            direction,
            local_ip: row.local.ip().to_string(),
            local_port: row.local.port(),
            remote_ip: if is_listen { "*".into() } else { row.remote.ip().to_string() },
            remote_port: if is_listen { 0 } else { row.remote.port() },
            host: if is_listen { "监听中".into() } else { row.remote.ip().to_string() },
            state: row.state,
            transitions: vec![Transition { state: row.state, t: start }],
            started_at: start,
            ended_at: None,
            failure: None,
            rx_rate: 0.0,
            tx_rate: 0.0,
            rx_bytes: 0,
            tx_bytes: 0,
            rtt_ms: 0.0,
            retrans: 0,
            inspect: Inspection::default(),
        };
        if !is_listen {
            self.event(&conn, start, None, row.state);
        }
        Track { conn, history: VecDeque::new(), last_active: now, generation }
    }

    fn new_udp_bound(&mut self, row: &UdpRow, now: u64, generation: u64) -> Track {
        let start = row.created_at.filter(|c| *c <= now).unwrap_or(now);
        let conn = Conn {
            id: self.next_id(),
            pid: row.pid,
            proc_name: self.proc_name(row.pid),
            l4: "UDP",
            l7: "未识别".into(),
            direction: "listen",
            local_ip: row.local.ip().to_string(),
            local_port: row.local.port(),
            remote_ip: "*".into(),
            remote_port: 0,
            host: "已绑定".into(),
            state: "UDP_BOUND",
            transitions: vec![Transition { state: "UDP_BOUND", t: start }],
            started_at: start,
            ended_at: None,
            failure: None,
            rx_rate: 0.0,
            tx_rate: 0.0,
            rx_bytes: 0,
            tx_bytes: 0,
            rtt_ms: 0.0,
            retrans: 0,
            inspect: Inspection { identified_by: "已绑定的 UDP 端口，没有流量可供识别".into(), ..Default::default() },
        };
        Track { conn, history: VecDeque::new(), last_active: now, generation }
    }

    fn new_udp_flow(&mut self, id: UdpFlowId, now: u64) -> Track {
        let UdpFlowId(pid, local, remote) = id;
        let conn = Conn {
            id: self.next_id(),
            pid,
            proc_name: self.proc_name(pid),
            l4: "UDP",
            l7: "未识别".into(),
            direction: "out",
            local_ip: local.ip().to_string(),
            local_port: local.port(),
            remote_ip: remote.ip().to_string(),
            remote_port: remote.port(),
            host: remote.ip().to_string(),
            state: "UDP_ACTIVE",
            transitions: vec![Transition { state: "UDP_ACTIVE", t: now }],
            started_at: now,
            ended_at: None,
            failure: None,
            rx_rate: 0.0,
            tx_rate: 0.0,
            rx_bytes: 0,
            tx_bytes: 0,
            rtt_ms: 0.0,
            retrans: 0,
            inspect: Inspection::default(),
        };
        self.event(&conn, now, None, "UDP_ACTIVE");
        Track { conn, history: VecDeque::new(), last_active: now, generation: 0 }
    }

    /// 需要测 RTT 的 TCP 连接
    pub fn established(&self) -> Vec<(SocketAddr, SocketAddr)> {
        self.tcp
            .iter()
            .filter(|(k, t)| t.conn.state == "ESTABLISHED" && !k.1.ip().is_loopback() && !is_unspecified(k.1.ip()))
            .map(|(k, _)| *k)
            .collect()
    }

    pub fn set_rtt(&mut self, key: (SocketAddr, SocketAddr), ms: f64) {
        if let Some(t) = self.tcp.get_mut(&key) {
            t.conn.rtt_ms = ms;
        }
    }

    /// 每秒一次：结算速率，生成要推送的帧
    pub fn tick(&mut self, shared: &Shared, t: u64, elapsed_secs: f64) -> String {
        self.last_t = t;
        let tcp_counts = std::mem::take(&mut *shared.tcp.lock().unwrap());
        let udp_counts = std::mem::take(&mut *shared.udp.lock().unwrap());
        let dns = shared.dns.lock().unwrap();
        let flows = shared.flows.lock().unwrap();

        // 通过 ETW 新发现的 UDP 流
        for (key, counts) in &udp_counts {
            let id = UdpFlowId(key.0, key.1, key.2);
            if !self.udp_flows.contains_key(&id) {
                let track = self.new_udp_flow(id, t);
                self.udp_flows.insert(id, track);
            }
            if counts.rx + counts.tx > 0 {
                self.udp_flows.get_mut(&id).unwrap().last_active = t;
            }
        }

        let elapsed = elapsed_secs.max(0.001);
        let settle = |track: &mut Track, counts: Counters| {
            let c = &mut track.conn;
            c.rx_rate = counts.rx as f64 / elapsed;
            c.tx_rate = counts.tx as f64 / elapsed;
            c.rx_bytes += counts.rx;
            c.tx_bytes += counts.tx;
            c.retrans += counts.retrans;
            if counts.rx + counts.tx > 0 {
                track.last_active = t;
            }
            track.history.push_back((t, c.rx_rate, c.tx_rate));
            if track.history.len() > HISTORY_POINTS {
                track.history.pop_front();
            }
        };

        for (key, track) in self.tcp.iter_mut() {
            if track.conn.direction == "listen" {
                continue;
            }
            settle(track, tcp_counts.get(key).copied().unwrap_or_default());
            enrich(&mut track.conn, Proto::Tcp, key.0, key.1, &dns, &flows);
        }
        for (id, track) in self.udp_flows.iter_mut() {
            settle(track, udp_counts.get(&(id.0, id.1, id.2)).copied().unwrap_or_default());
            enrich(&mut track.conn, Proto::Udp, id.1, id.2, &dns, &flows);
        }
        drop(dns);
        drop(flows);

        let idle: Vec<_> = self.udp_flows.iter().filter(|(_, tr)| t.saturating_sub(tr.last_active) > UDP_IDLE_MS).map(|(k, _)| *k).collect();
        for id in idle {
            let mut track = self.udp_flows.remove(&id).unwrap();
            self.close(&mut track, t, "UDP_ACTIVE");
            self.closed.push_back(track);
        }

        while self.closed.len() > MAX_CLOSED {
            self.closed.pop_front();
        }
        while self.closed.front().is_some_and(|tr| t.saturating_sub(tr.conn.ended_at.unwrap_or(t)) > RETAIN_CLOSED_MS) {
            self.closed.pop_front();
        }

        let events = std::mem::take(&mut self.new_events);
        let conns: Vec<Conn> = self
            .tcp
            .values()
            .chain(self.udp_bound.values())
            .chain(self.udp_flows.values())
            .chain(self.closed.iter())
            .map(|tr| tr.conn.clone())
            .collect();
        let frame = Frame {
            kind: "frame",
            t,
            procs: self.procs_changed.then_some(&self.procs[..]),
            conns,
            events: &events,
            capture: &self.capture,
        };
        let json = serde_json::to_string(&frame).unwrap_or_default();
        self.procs_changed = false;
        self.events.extend(events);
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
        json
    }

    /// 给新连上的客户端：进程表、历史曲线、事件
    pub fn hello(&self, now: u64) -> String {
        let t = if self.last_t != 0 { self.last_t } else { now };
        let history = self
            .tcp
            .values()
            .chain(self.udp_flows.values())
            .chain(self.closed.iter())
            .filter(|tr| !tr.history.is_empty())
            .map(|tr| ConnHistory { id: &tr.conn.id, points: tr.history.iter().copied().collect() })
            .collect();
        serde_json::to_string(&Hello {
            kind: "hello",
            t,
            procs: &self.procs,
            events: self.events.iter().rev().collect(),
            history,
            capture: &self.capture,
        })
        .unwrap_or_default()
    }
}

/// 填上域名和协议信息：优先抓包结果，其次 DNS 映射，最后按端口推断
fn enrich(
    conn: &mut Conn,
    proto: Proto,
    local: SocketAddr,
    remote: SocketAddr,
    dns: &HashMap<IpAddr, String>,
    flows: &HashMap<FlowKey, crate::flows::FlowInfo>,
) {
    let flow = flows.get(&FlowKey::new(proto, local, remote));
    let ip = remote.ip();

    if let Some(host) = flow.and_then(|f| f.host.as_ref()) {
        conn.host = host.clone();
    } else if ip.is_loopback() {
        conn.host = "localhost".into();
    } else if let Some(name) = dns.get(&ip) {
        conn.host = name.clone();
    }

    if let Some((l7, f)) = flow.and_then(|f| f.l7.map(|l| (l, f))) {
        conn.l7 = l7.into();
        conn.inspect = f.inspection();
    } else if let Some(l7) = infer_l7(proto, remote.port(), local.port()) {
        conn.l7 = l7.into();
        conn.inspect = Inspection {
            identified_by: format!("按端口 {} 推断，没有看到握手报文", remote.port()),
            fields: Vec::new(),
            requests: None,
        };
    } else {
        conn.inspect = Inspection { identified_by: "未匹配到已知特征".into(), fields: Vec::new(), requests: None };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(state: &'static str, local: &str, remote: &str, pid: u32) -> TcpRow {
        TcpRow { state, local: local.parse().unwrap(), remote: remote.parse().unwrap(), pid, created_at: None, local_scope: 0, remote_scope: 0 }
    }

    const L: &str = "192.168.1.2:50000";
    const R: &str = "203.0.113.9:443";

    fn frame(e: &mut Engine, s: &Shared, t: u64) -> serde_json::Value {
        serde_json::from_str(&e.tick(s, t, 1.0)).unwrap()
    }

    #[test]
    fn records_state_transitions_in_order() {
        let (mut e, s) = (Engine::default(), Shared::default());
        e.apply_tables(vec![row("SYN_SENT", L, R, 7)], vec![], 1000);
        e.apply_tables(vec![row("ESTABLISHED", L, R, 7)], vec![], 1250);
        e.apply_tables(vec![row("FIN_WAIT_1", L, R, 7)], vec![], 1500);
        e.apply_tables(vec![row("TIME_WAIT", L, R, 0)], vec![], 1750);
        e.apply_tables(vec![], vec![], 2000);
        let f = frame(&mut e, &s, 3000);
        let c = &f["conns"][0];
        let states: Vec<_> = c["transitions"].as_array().unwrap().iter().map(|x| x["state"].as_str().unwrap()).collect();
        assert_eq!(states, ["SYN_SENT", "ESTABLISHED", "FIN_WAIT_1", "TIME_WAIT", "CLOSED"]);
        assert_eq!(c["endedAt"], 2000);
        // TIME_WAIT 行 PID 是 0，不能覆盖掉已知进程
        assert_eq!(c["pid"], 7);
        assert!(c.get("failure").is_none());
        assert_eq!(f["events"].as_array().unwrap().len(), 5);
    }

    #[test]
    fn syn_that_vanishes_is_a_failure() {
        let (mut e, s) = (Engine::default(), Shared::default());
        e.apply_tables(vec![row("SYN_SENT", L, R, 7)], vec![], 1000);
        e.apply_tables(vec![], vec![], 3000);
        let f = frame(&mut e, &s, 4000);
        assert_eq!(f["conns"][0]["failure"], "failed");
        assert_eq!(f["conns"][0]["state"], "CLOSED");
    }

    #[test]
    fn port_reuse_starts_a_new_connection() {
        let (mut e, s) = (Engine::default(), Shared::default());
        e.apply_tables(vec![row("ESTABLISHED", L, R, 7)], vec![], 1000);
        e.apply_tables(vec![], vec![], 1250);
        e.apply_tables(vec![row("ESTABLISHED", L, R, 8)], vec![], 1500);
        let f = frame(&mut e, &s, 2000);
        let conns = f["conns"].as_array().unwrap();
        assert_eq!(conns.len(), 2);
        assert_ne!(conns[0]["id"], conns[1]["id"]);
    }

    #[test]
    fn rates_come_from_counters_for_the_exact_direction() {
        let (mut e, s) = (Engine::default(), Shared::default());
        // 回环连接的两端都在表里，字节必须记到正确的一端
        let (a, b) = ("127.0.0.1:50000", "127.0.0.1:5173");
        e.apply_tables(vec![row("LISTEN", "127.0.0.1:5173", "0.0.0.0:0", 2), row("ESTABLISHED", a, b, 1), row("ESTABLISHED", b, a, 2)], vec![], 1000);
        s.tcp.lock().unwrap().insert((a.parse().unwrap(), b.parse().unwrap()), Counters { rx: 100, tx: 900, retrans: 2 });
        let f = frame(&mut e, &s, 2000);
        let conns = f["conns"].as_array().unwrap();
        let client = conns.iter().find(|c| c["pid"] == 1).unwrap();
        let server = conns.iter().find(|c| c["pid"] == 2 && c["state"] == "ESTABLISHED").unwrap();
        assert_eq!(client["txRate"], 900.0);
        assert_eq!(client["retrans"], 2);
        assert_eq!(client["direction"], "out");
        assert_eq!(client["host"], "localhost");
        assert_eq!(server["txRate"], 0.0);
        assert_eq!(server["direction"], "in");
    }

    #[test]
    fn udp_flow_appears_from_etw_and_closes_when_idle() {
        let (mut e, s) = (Engine::default(), Shared::default());
        let key = (9u32, "192.168.1.2:6000".parse().unwrap(), "198.51.100.1:443".parse().unwrap());
        s.udp.lock().unwrap().insert(key, Counters { rx: 5, tx: 5, retrans: 0 });
        let f = frame(&mut e, &s, 1000);
        assert_eq!(f["conns"][0]["state"], "UDP_ACTIVE");
        assert_eq!(f["conns"][0]["l7"], "QUIC");
        assert!(f["conns"][0]["inspect"]["identifiedBy"].as_str().unwrap().contains("推断"));
        let f = frame(&mut e, &s, 1000 + UDP_IDLE_MS + 1);
        assert_eq!(f["conns"][0]["state"], "CLOSED");
    }

    #[test]
    fn dns_name_replaces_ip_as_host_and_hello_keeps_history() {
        let (mut e, s) = (Engine::default(), Shared::default());
        s.remember_dns("Example.test", ["203.0.113.9".parse().unwrap()]);
        e.apply_tables(vec![row("ESTABLISHED", L, R, 7)], vec![], 1000);
        let f = frame(&mut e, &s, 2000);
        assert_eq!(f["conns"][0]["host"], "example.test");
        let hello: serde_json::Value = serde_json::from_str(&e.hello(2000)).unwrap();
        assert_eq!(hello["history"][0]["points"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn listeners_and_bound_udp_are_not_flows() {
        let (mut e, s) = (Engine::default(), Shared::default());
        e.apply_tables(
            vec![row("LISTEN", "0.0.0.0:80", "0.0.0.0:0", 4)],
            vec![UdpRow { local: "0.0.0.0:5353".parse().unwrap(), pid: 4, created_at: None }],
            1000,
        );
        let f = frame(&mut e, &s, 2000);
        assert_eq!(f["events"].as_array().unwrap().len(), 0);
        for c in f["conns"].as_array().unwrap() {
            assert_eq!(c["direction"], "listen");
            assert_eq!(c["remoteIp"], "*");
        }
    }

    #[test]
    fn unknown_pid_requests_a_process_refresh() {
        let mut e = Engine::default();
        e.apply_tables(vec![row("ESTABLISHED", L, R, 777)], vec![], 1000);
        assert!(e.unknown_pid);
        e.set_procs(vec![ProcInfo { pid: 777, ppid: 1, name: "x.exe".into(), exe: String::new(), cmd: String::new(), started_at: 0, memory_bytes: 0, cpu_percent: 0.0 }]);
        assert!(!e.unknown_pid);
        // 进程表到了之后，已有连接要补上真实进程名
        let f: serde_json::Value = serde_json::from_str(&e.tick(&Shared::default(), 2000, 1.0)).unwrap();
        assert_eq!(f["conns"][0]["procName"], "x.exe");
    }

    #[test]
    fn short_lived_process_is_named_by_asking_the_system() {
        let (mut e, s) = (Engine::default(), Shared::default());
        e.resolver = Some(|pid| (pid == 777).then(|| "curl.exe".to_string()));
        e.apply_tables(vec![row("ESTABLISHED", L, R, 777), row("ESTABLISHED", "192.168.1.2:50001", R, 778)], vec![], 1000);
        let f = frame(&mut e, &s, 2000);
        let names: Vec<_> = f["conns"].as_array().unwrap().iter().map(|c| c["procName"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"curl.exe".to_string()));
        assert!(names.contains(&"PID 778".to_string()));
        // 进程表里没有的进程名，在进程表刷新后也不会被覆盖回 PID
        e.set_procs(vec![]);
        let f = frame(&mut e, &s, 3000);
        assert!(f["conns"].as_array().unwrap().iter().any(|c| c["procName"] == "curl.exe"));
    }

    #[test]
    fn time_wait_without_owner_is_not_attributed_to_system_idle() {
        let (mut e, s) = (Engine::default(), Shared::default());
        e.set_procs(vec![ProcInfo { pid: 0, ppid: 0, name: "[System Process]".into(), exe: String::new(), cmd: String::new(), started_at: 0, memory_bytes: 0, cpu_percent: 0.0 }]);
        e.apply_tables(vec![row("TIME_WAIT", L, R, 0)], vec![], 1000);
        let f = frame(&mut e, &s, 2000);
        assert_eq!(f["conns"][0]["procName"], "（已结束进程）");
        assert!(!e.unknown_pid);
    }
}
