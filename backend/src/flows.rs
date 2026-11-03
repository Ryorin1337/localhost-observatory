//! 采集线程（ETW、原始套接字）和状态引擎之间共享的数据。

use crate::model::{HttpRequest, Inspection};
use crate::parse::{self, HelloParse, Proto, Segment};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;

/// 与方向无关的流标识：抓包时分不清哪端是本地，回环连接两端又都是本地
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct FlowKey(pub Proto, pub SocketAddr, pub SocketAddr);

impl FlowKey {
    pub fn new(proto: Proto, a: SocketAddr, b: SocketAddr) -> Self {
        if a <= b {
            Self(proto, a, b)
        } else {
            Self(proto, b, a)
        }
    }
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Counters {
    pub rx: u64,
    pub tx: u64,
    pub retrans: u32,
}

const MAX_HELLO: usize = 16 * 1024;
const MAX_REQUESTS: usize = 8;
/// 这么多个载荷都认不出来就放弃，避免继续分析业务数据
const MAX_TRIES: u8 = 4;
const MAX_DNS_NAMES: usize = 50_000;
const MAX_FLOWS: usize = 50_000;
const FLOW_TTL_MS: u64 = 10 * 60_000;

#[derive(Default)]
pub struct FlowInfo {
    pub l7: Option<&'static str>,
    pub identified_by: String,
    pub fields: Vec<(String, String)>,
    pub requests: VecDeque<HttpRequest>,
    pub host: Option<String>,
    hello: Vec<u8>,
    hello_from: Option<SocketAddr>,
    hello_done: bool,
    tries: u8,
    pending: VecDeque<(String, String, u64)>,
    last_seq: Option<(SocketAddr, u32)>,
    last_seen: u64,
}

impl FlowInfo {
    pub fn inspection(&self) -> Inspection {
        Inspection {
            identified_by: self.identified_by.clone(),
            fields: self.fields.clone(),
            requests: self.request_list(),
        }
    }

    /// 已完成的请求加上还没看到响应的请求（status 为 0）。
    /// 入站报文可能被防火墙挡住，不能因为等不到响应就不显示请求
    fn request_list(&self) -> Option<Vec<HttpRequest>> {
        let waiting = self.pending.iter().map(|(method, path, t)| HttpRequest { t: *t, method: method.clone(), path: path.clone(), status: 0, ms: 0 });
        let all: Vec<_> = self.requests.iter().cloned().chain(waiting).collect();
        (!all.is_empty()).then_some(all)
    }

    fn set_field(&mut self, k: &str, v: String) {
        match self.fields.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = v,
            None => self.fields.push((k.into(), v)),
        }
    }
}

#[derive(Default)]
pub struct Shared {
    /// TCP 字节计数，按 (本地, 远端) 记录
    pub tcp: Mutex<HashMap<(SocketAddr, SocketAddr), Counters>>,
    /// UDP 字节计数：UDP 表里没有对端，只能从 ETW 事件得到完整的流
    pub udp: Mutex<HashMap<(u32, SocketAddr, SocketAddr), Counters>>,
    pub dns: Mutex<HashMap<IpAddr, String>>,
    pub flows: Mutex<HashMap<FlowKey, FlowInfo>>,
}

impl Shared {
    pub fn remember_dns(&self, name: &str, ips: impl IntoIterator<Item = IpAddr>) {
        let mut map = self.dns.lock().unwrap();
        if map.len() > MAX_DNS_NAMES {
            map.clear();
        }
        for ip in ips {
            map.insert(ip.to_canonical(), name.to_ascii_lowercase());
        }
    }

    pub fn prune_flows(&self, now: u64) {
        let mut flows = self.flows.lock().unwrap();
        flows.retain(|_, f| now.saturating_sub(f.last_seen) < FLOW_TTL_MS);
    }

    /// 处理抓到的一个报文。只看开头若干载荷，识别完就不再保留任何数据
    pub fn observe(&self, seg: &Segment<'_>, now: u64) {
        if seg.payload.is_empty() {
            return;
        }
        let key = FlowKey::new(seg.proto, seg.src, seg.dst);
        let mut flows = self.flows.lock().unwrap();
        if flows.len() > MAX_FLOWS {
            flows.clear();
        }
        let flow = flows.entry(key).or_default();
        flow.last_seen = now;

        match seg.proto {
            Proto::Udp => self.observe_udp(flow, seg),
            Proto::Tcp => observe_tcp(flow, seg, now),
        }
    }

    fn observe_udp(&self, flow: &mut FlowInfo, seg: &Segment<'_>) {
        let dns_port = |p: u16| matches!(p, 53 | 5353 | 5355);
        if dns_port(seg.src.port()) || dns_port(seg.dst.port()) {
            let Some(msg) = parse::parse_dns(seg.payload) else { return };
            flow.l7 = Some("DNS");
            flow.identified_by = "UDP DNS 端口 + DNS 报文头校验".into();
            flow.host = Some(msg.name.clone());
            flow.set_field("查询", msg.name.clone());
            flow.set_field("类型", parse::qtype_name(msg.qtype));
            if msg.response {
                flow.set_field("响应码", parse::rcode_name(msg.rcode));
                if let Some(first) = msg.answers.first() {
                    flow.set_field("应答", first.to_string());
                }
                if let Some(ttl) = msg.ttl {
                    flow.set_field("TTL", format!("{ttl} s"));
                }
                self.remember_dns(&msg.name, msg.answers);
            }
        } else if flow.l7.is_none() && (seg.src.port() == 443 || seg.dst.port() == 443) {
            if let Some(version) = parse::is_quic_long_header(seg.payload) {
                flow.l7 = Some("QUIC");
                flow.identified_by = "QUIC Initial 长包头（UDP 443）".into();
                flow.set_field("版本", version.into());
            }
        }
    }
}

fn observe_tcp(flow: &mut FlowInfo, seg: &Segment<'_>, now: u64) {
    // 重传和回环上的重复报文只算一次
    if flow.last_seq == Some((seg.src, seg.seq)) {
        return;
    }
    flow.last_seq = Some((seg.src, seg.seq));
    let p = seg.payload;

    match flow.l7 {
        Some("HTTP") => return observe_http(flow, p, now),
        Some("TLS") => return observe_tls(flow, seg),
        Some(_) => return,
        None => {}
    }
    if flow.tries >= MAX_TRIES {
        return;
    }
    flow.tries += 1;

    if p[0] == 0x16 && p.get(1) == Some(&3) {
        flow.l7 = Some("TLS");
        flow.identified_by = "TLS 握手记录".into();
        observe_tls(flow, seg);
    } else if parse::parse_http_request(p).is_some() || parse::parse_http_status(p).is_some() {
        flow.l7 = Some("HTTP");
        flow.identified_by = "HTTP/1.x 明文报文".into();
        observe_http(flow, p, now);
    } else if p.starts_with(b"SSH-") {
        flow.l7 = Some("SSH");
        flow.identified_by = "SSH 协议版本交换串".into();
        let banner = String::from_utf8_lossy(&p[..p.len().min(64)]);
        flow.set_field("版本串", banner.trim().to_string());
    } else if parse::is_postgres_startup(p) {
        flow.l7 = Some("PostgreSQL");
        flow.identified_by = "PostgreSQL 启动消息".into();
    } else if parse::is_tls_record(p) {
        flow.l7 = Some("TLS");
        flow.identified_by = "TLS 记录头（连接建立后才开始观察，没有看到握手）".into();
    }
}

fn observe_tls(flow: &mut FlowInfo, seg: &Segment<'_>) {
    if !flow.hello_done && flow.hello_from.is_none_or(|from| from == seg.src) {
        if flow.hello.len() + seg.payload.len() <= MAX_HELLO {
            flow.hello.extend_from_slice(seg.payload);
        }
        match parse::parse_client_hello(&flow.hello) {
            HelloParse::NeedMore if flow.hello.len() < MAX_HELLO => {
                flow.hello_from = Some(seg.src);
            }
            HelloParse::Done(hello) => {
                flow.identified_by = "TLS ClientHello".into();
                if let Some(sni) = hello.sni {
                    flow.host = Some(sni.clone());
                    flow.set_field("SNI", sni);
                }
                if !hello.alpn.is_empty() {
                    flow.set_field("ALPN", hello.alpn.join(", "));
                }
                if hello.tls13 {
                    flow.set_field("客户端支持", "TLS 1.3".into());
                }
                flow.hello_done = true;
                flow.hello = Vec::new();
            }
            _ => {
                flow.hello_done = true;
                flow.hello = Vec::new();
            }
        }
    }
    if let Some(server) = parse::parse_server_hello(seg.payload) {
        flow.set_field("版本", server.version.into());
        flow.set_field("密码套件", server.cipher);
    }
}

fn observe_http(flow: &mut FlowInfo, p: &[u8], now: u64) {
    if let Some(head) = parse::parse_http_request(p) {
        if let Some(host) = head.host {
            flow.set_field("Host", host);
        }
        if let Some(agent) = head.user_agent {
            flow.set_field("User-Agent", agent);
        }
        flow.pending.push_back((head.method, head.path, now));
        if flow.pending.len() > MAX_REQUESTS {
            flow.pending.pop_front();
        }
    } else if let Some(status) = parse::parse_http_status(p) {
        if let Some((method, path, t)) = flow.pending.pop_front() {
            flow.requests.push_back(HttpRequest { t, method, path, status, ms: now.saturating_sub(t) });
            if flow.requests.len() > MAX_REQUESTS {
                flow.requests.pop_front();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg<'a>(src: &str, dst: &str, seq: u32, payload: &'a [u8]) -> Segment<'a> {
        Segment { proto: Proto::Tcp, src: src.parse().unwrap(), dst: dst.parse().unwrap(), seq, payload }
    }

    fn flow(shared: &Shared, a: &str, b: &str) -> Inspection {
        let key = FlowKey::new(Proto::Tcp, a.parse().unwrap(), b.parse().unwrap());
        shared.flows.lock().unwrap().get(&key).unwrap().inspection()
    }

    #[test]
    fn pairs_http_responses_with_requests_once() {
        let s = Shared::default();
        let (c, srv) = ("127.0.0.1:50000", "127.0.0.1:5173");
        s.observe(&seg(c, srv, 1, b"GET /x?secret=1 HTTP/1.1\r\nHost: localhost\r\n\r\n"), 1000);
        // 回环上同一报文可能被看到两次
        s.observe(&seg(c, srv, 1, b"GET /x?secret=1 HTTP/1.1\r\nHost: localhost\r\n\r\n"), 1001);
        s.observe(&seg(srv, c, 9, b"HTTP/1.1 200 OK\r\n\r\n"), 1025);
        let reqs = flow(&s, c, srv).requests.unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].path, "/x");
        assert_eq!(reqs[0].status, 200);
        assert_eq!(reqs[0].ms, 25);
    }

    #[test]
    fn request_without_a_response_is_still_listed() {
        let s = Shared::default();
        let (c, srv) = ("10.0.0.1:50000", "93.184.216.34:80");
        s.observe(&seg(c, srv, 1, b"GET /only HTTP/1.1\r\nHost: x.test\r\n\r\n"), 1000);
        let reqs = flow(&s, c, srv).requests.unwrap();
        assert_eq!(reqs[0].path, "/only");
        assert_eq!(reqs[0].status, 0);
    }

    #[test]
    fn gives_up_on_unknown_payload_and_stays_unknown() {
        let s = Shared::default();
        for i in 0..10u32 {
            s.observe(&seg("10.0.0.1:50000", "10.0.0.2:9000", i, b"\x01\x02\x03\x04opaque"), 1000);
        }
        let key = FlowKey::new(Proto::Tcp, "10.0.0.1:50000".parse().unwrap(), "10.0.0.2:9000".parse().unwrap());
        let flows = s.flows.lock().unwrap();
        let f = flows.get(&key).unwrap();
        assert!(f.l7.is_none());
        assert_eq!(f.tries, MAX_TRIES);
    }

    #[test]
    fn flow_key_ignores_direction() {
        let a = "10.0.0.1:1".parse().unwrap();
        let b = "10.0.0.2:2".parse().unwrap();
        assert_eq!(FlowKey::new(Proto::Udp, a, b), FlowKey::new(Proto::Udp, b, a));
    }
}
