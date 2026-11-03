//! 纯函数的报文解析：只看连接开头的握手字节，不保存任何载荷。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Proto {
    Tcp,
    Udp,
}

#[derive(Debug)]
pub struct Segment<'a> {
    pub proto: Proto,
    pub src: SocketAddr,
    pub dst: SocketAddr,
    pub seq: u32,
    pub payload: &'a [u8],
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([*b.get(at)?, *b.get(at + 1)?, *b.get(at + 2)?, *b.get(at + 3)?]))
}

/// 解析原始套接字收到的 IPv4 包。分片的后续片段没有传输层头，直接忽略。
pub fn parse_ipv4(pkt: &[u8]) -> Option<Segment<'_>> {
    if pkt.first()? >> 4 != 4 {
        return None;
    }
    let ihl = ((pkt[0] & 0x0f) as usize) * 4;
    // 网卡分段卸载（LSO）时，本机发出的大包抓到的总长度字段是 0，这时以实际收到的长度为准。
    // 浏览器带后量子密钥的 ClientHello 超过一个 MSS，正好走这条路
    let total = match be16(pkt, 2)? as usize {
        0 => pkt.len(),
        n => n,
    };
    if ihl < 20 || total < ihl || be16(pkt, 6)? & 0x1fff != 0 {
        return None;
    }
    let end = total.min(pkt.len());
    let src = Ipv4Addr::new(*pkt.get(12)?, pkt[13], pkt[14], pkt[15]);
    let dst = Ipv4Addr::new(*pkt.get(16)?, pkt[17], pkt[18], pkt[19]);
    let l4 = pkt.get(ihl..end)?;
    match pkt[9] {
        6 => {
            let header = ((*l4.get(12)? >> 4) as usize) * 4;
            Some(Segment {
                proto: Proto::Tcp,
                src: SocketAddr::new(src.into(), be16(l4, 0)?),
                dst: SocketAddr::new(dst.into(), be16(l4, 2)?),
                seq: be32(l4, 4)?,
                payload: l4.get(header..)?,
            })
        }
        17 => Some(Segment {
            proto: Proto::Udp,
            src: SocketAddr::new(src.into(), be16(l4, 0)?),
            dst: SocketAddr::new(dst.into(), be16(l4, 2)?),
            seq: 0,
            payload: l4.get(8..)?,
        }),
        _ => None,
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct ClientHello {
    pub sni: Option<String>,
    pub alpn: Vec<String>,
    pub tls13: bool,
}

#[derive(Debug, PartialEq)]
pub enum HelloParse {
    /// 不是 ClientHello
    No,
    /// ClientHello 被拆到了多个 TCP 段，需要更多数据
    NeedMore,
    Done(ClientHello),
}

/// 把若干 TLS 记录里的握手数据拼起来
fn handshake_bytes(buf: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut at = 0;
    while let (Some(&0x16), Some(&0x03)) = (buf.get(at), buf.get(at + 1)) {
        let Some(len) = be16(buf, at + 3) else { break };
        let start = at + 5;
        let end = (start + len as usize).min(buf.len());
        out.extend_from_slice(buf.get(start..end)?);
        at = start + len as usize;
    }
    Some(out)
}

pub fn parse_client_hello(buf: &[u8]) -> HelloParse {
    if buf.len() < 3 {
        return HelloParse::NeedMore;
    }
    if buf[0] != 0x16 || buf[1] != 0x03 {
        return HelloParse::No;
    }
    let Some(hs) = handshake_bytes(buf) else { return HelloParse::No };
    match hs.first() {
        None => return HelloParse::NeedMore,
        Some(1) => {}
        Some(_) => return HelloParse::No,
    }
    if hs.len() < 4 {
        return HelloParse::NeedMore;
    }
    let body_len = ((hs[1] as usize) << 16) | ((hs[2] as usize) << 8) | hs[3] as usize;
    if hs.len() < 4 + body_len {
        return HelloParse::NeedMore;
    }
    match read_hello_body(&hs[4..4 + body_len]) {
        Some(hello) => HelloParse::Done(hello),
        None => HelloParse::No,
    }
}

fn read_hello_body(body: &[u8]) -> Option<ClientHello> {
    let mut at = 2 + 32; // client_version + random
    at += 1 + *body.get(at)? as usize; // session_id
    at += 2 + be16(body, at)? as usize; // cipher_suites
    at += 1 + *body.get(at)? as usize; // compression_methods
    let mut hello = ClientHello::default();
    let ext_end = at + 2 + be16(body, at).unwrap_or(0) as usize;
    at += 2;
    while at + 4 <= ext_end.min(body.len()) {
        let kind = be16(body, at)?;
        let len = be16(body, at + 2)? as usize;
        let data = body.get(at + 4..at + 4 + len)?;
        match kind {
            0 => {
                // server_name_list：list_len(2) type(1) name_len(2) name
                if data.get(2) == Some(&0) {
                    let n = be16(data, 3)? as usize;
                    hello.sni = data.get(5..5 + n).and_then(hostname);
                }
            }
            16 => {
                let mut p = 2;
                while let Some(&n) = data.get(p) {
                    let Some(name) = data.get(p + 1..p + 1 + n as usize) else { break };
                    hello.alpn.push(String::from_utf8_lossy(name).into_owned());
                    p += 1 + n as usize;
                }
            }
            43 => {
                // supported_versions 里出现 TLS 1.3
                hello.tls13 = data.get(1..).unwrap_or(&[]).chunks_exact(2).any(|v| v == [3, 4]);
            }
            _ => {}
        }
        at += 4 + len;
    }
    Some(hello)
}

/// 只接受合法主机名字符，防止对端构造的内容进入界面
fn hostname(raw: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(raw).ok()?;
    let ok = !s.is_empty() && s.len() <= 253 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'));
    ok.then(|| s.to_ascii_lowercase())
}

#[derive(Debug, PartialEq)]
pub struct ServerHello {
    pub version: &'static str,
    pub cipher: String,
}

pub fn parse_server_hello(buf: &[u8]) -> Option<ServerHello> {
    if buf.first()? != &0x16 || buf.get(1)? != &0x03 || buf.get(5)? != &2 {
        return None;
    }
    let body = buf.get(9..)?;
    let legacy = be16(body, 0)?;
    let mut at = 2 + 32;
    at += 1 + *body.get(at)? as usize;
    let cipher = be16(body, at)?;
    at += 3; // cipher + compression
    let mut version = match legacy {
        0x0303 => "TLS 1.2",
        0x0302 => "TLS 1.1",
        0x0301 => "TLS 1.0",
        _ => "TLS",
    };
    if let Some(ext_len) = be16(body, at) {
        let end = at + 2 + ext_len as usize;
        let mut p = at + 2;
        while p + 4 <= end {
            let (Some(kind), Some(len)) = (be16(body, p), be16(body, p + 2)) else { break };
            if kind == 43 && be16(body, p + 4) == Some(0x0304) {
                version = "TLS 1.3";
            }
            p += 4 + len as usize;
        }
    }
    Some(ServerHello { version, cipher: cipher_name(cipher) })
}

fn cipher_name(id: u16) -> String {
    match id {
        0x1301 => "TLS_AES_128_GCM_SHA256".into(),
        0x1302 => "TLS_AES_256_GCM_SHA384".into(),
        0x1303 => "TLS_CHACHA20_POLY1305_SHA256".into(),
        0xc02b => "ECDHE_ECDSA_AES_128_GCM_SHA256".into(),
        0xc02c => "ECDHE_ECDSA_AES_256_GCM_SHA384".into(),
        0xc02f => "ECDHE_RSA_AES_128_GCM_SHA256".into(),
        0xc030 => "ECDHE_RSA_AES_256_GCM_SHA384".into(),
        0xcca8 => "ECDHE_RSA_CHACHA20_POLY1305".into(),
        0xcca9 => "ECDHE_ECDSA_CHACHA20_POLY1305".into(),
        other => format!("0x{other:04x}"),
    }
}

/// 连接中途才开始观察时，TLS 只能从应用数据记录头认出来
pub fn is_tls_record(p: &[u8]) -> bool {
    p.len() >= 5 && matches!(p[0], 0x14..=0x17) && p[1] == 3 && p[2] <= 4
}

#[derive(Debug, PartialEq)]
pub struct HttpHead {
    pub method: String,
    /// 已去掉查询串，它常常带着令牌
    pub path: String,
    pub host: Option<String>,
    pub user_agent: Option<String>,
}

const METHODS: [&str; 9] = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "CONNECT", "TRACE"];

pub fn parse_http_request(p: &[u8]) -> Option<HttpHead> {
    let line_end = p.iter().take(2048).position(|&b| b == b'\r')?;
    let line = std::str::from_utf8(&p[..line_end]).ok()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    if !METHODS.contains(&method) {
        return None;
    }
    let target = parts.next()?;
    if !parts.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let path = target.split(['?', '#']).next().unwrap_or(target);
    let header = |name: &str| -> Option<String> {
        let text = String::from_utf8_lossy(&p[..p.len().min(4096)]);
        text.lines()
            .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
    };
    Some(HttpHead {
        method: method.into(),
        path: path.chars().take(200).collect(),
        host: header("Host"),
        user_agent: header("User-Agent").map(|s| s.chars().take(80).collect()),
    })
}

pub fn parse_http_status(p: &[u8]) -> Option<u16> {
    if !p.starts_with(b"HTTP/1.") {
        return None;
    }
    std::str::from_utf8(p.get(9..12)?).ok()?.parse().ok()
}

pub fn is_quic_long_header(p: &[u8]) -> Option<&'static str> {
    if p.len() < 7 || p[0] & 0xc0 != 0xc0 {
        return None;
    }
    match be32(p, 1)? {
        0x0000_0001 => Some("QUIC v1"),
        0x6b33_43cf => Some("QUIC v2"),
        v if v & 0xff00_0000 == 0xff00_0000 => Some("QUIC draft"),
        _ => None,
    }
}

pub fn is_postgres_startup(p: &[u8]) -> bool {
    let Some(code) = be32(p, 4) else { return false };
    let Some(len) = be32(p, 0) else { return false };
    // 3.0 StartupMessage / SSLRequest / GSSENCRequest
    (8..=10_000).contains(&len) && matches!(code, 196_608 | 80_877_103 | 80_877_104)
}

#[derive(Debug, PartialEq, Default)]
pub struct DnsMessage {
    pub response: bool,
    pub name: String,
    pub qtype: u16,
    pub rcode: u8,
    pub answers: Vec<IpAddr>,
    pub ttl: Option<u32>,
}

/// 读取域名，支持压缩指针。返回 (域名, 指针之后的位置)
fn read_name(m: &[u8], start: usize) -> Option<(String, usize)> {
    let mut labels: Vec<String> = Vec::new();
    let mut at = start;
    let mut next = None;
    for _ in 0..64 {
        let len = *m.get(at)? as usize;
        if len == 0 {
            return Some((labels.join("."), next.unwrap_or(at + 1)));
        }
        if len & 0xc0 == 0xc0 {
            let target = ((len & 0x3f) << 8) | *m.get(at + 1)? as usize;
            next.get_or_insert(at + 2);
            if target >= at {
                return None; // 只允许向前的指针，避免环
            }
            at = target;
            continue;
        }
        labels.push(String::from_utf8_lossy(m.get(at + 1..at + 1 + len)?).into_owned());
        at += 1 + len;
    }
    None
}

pub fn parse_dns(m: &[u8]) -> Option<DnsMessage> {
    let flags = be16(m, 2)?;
    let qd = be16(m, 4)?;
    let an = be16(m, 6)?;
    if qd != 1 {
        return None;
    }
    let (name, mut at) = read_name(m, 12)?;
    let name = hostname(name.as_bytes())?;
    let qtype = be16(m, at)?;
    at += 4;
    let mut msg = DnsMessage { response: flags & 0x8000 != 0, name, qtype, rcode: (flags & 0x0f) as u8, ..Default::default() };
    for _ in 0..an.min(32) {
        let Some((_, after)) = read_name(m, at) else { break };
        let (Some(kind), Some(ttl), Some(len)) = (be16(m, after), be32(m, after + 4), be16(m, after + 8)) else { break };
        let data = after + 10;
        let Some(rdata) = m.get(data..data + len as usize) else { break };
        match (kind, rdata.len()) {
            (1, 4) => msg.answers.push(IpAddr::V4(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]))),
            (28, 16) => {
                let bytes: [u8; 16] = rdata.try_into().ok()?;
                msg.answers.push(IpAddr::V6(Ipv6Addr::from(bytes)));
            }
            _ => {}
        }
        if matches!(kind, 1 | 28) {
            msg.ttl.get_or_insert(ttl);
        }
        at = data + len as usize;
    }
    Some(msg)
}

pub fn qtype_name(q: u16) -> String {
    match q {
        1 => "A".into(),
        5 => "CNAME".into(),
        12 => "PTR".into(),
        15 => "MX".into(),
        16 => "TXT".into(),
        28 => "AAAA".into(),
        33 => "SRV".into(),
        65 => "HTTPS".into(),
        n => format!("TYPE{n}"),
    }
}

pub fn rcode_name(r: u8) -> String {
    match r {
        0 => "NOERROR".into(),
        2 => "SERVFAIL".into(),
        3 => "NXDOMAIN".into(),
        5 => "REFUSED".into(),
        n => format!("RCODE{n}"),
    }
}

/// 解析 DNS-Client ETW 事件的 QueryResults，如 "1.2.3.4;::ffff:5.6.7.8;type: 5 x.com;"
pub fn parse_query_results(s: &str) -> Vec<IpAddr> {
    s.split(';')
        .filter_map(|p| p.trim().parse::<IpAddr>().ok())
        .map(|ip| ip.to_canonical())
        .collect()
}

/// 没有载荷可看时按端口推断，界面上会注明只是推断
pub fn infer_l7(proto: Proto, remote_port: u16, local_port: u16) -> Option<&'static str> {
    let port = |p: u16| remote_port == p || local_port == p;
    match proto {
        Proto::Tcp if port(443) || port(8443) => Some("TLS"),
        Proto::Tcp if port(80) || port(8080) => Some("HTTP"),
        Proto::Tcp if port(22) => Some("SSH"),
        Proto::Tcp if port(5432) => Some("PostgreSQL"),
        Proto::Tcp if port(53) || port(853) => Some("DNS"),
        Proto::Udp if port(53) || port(5353) || port(5355) => Some("DNS"),
        Proto::Udp if port(443) => Some("QUIC"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个带 SNI、ALPN、supported_versions 的 ClientHello
    fn client_hello(sni: &str) -> Vec<u8> {
        let mut ext = Vec::new();
        let name = sni.as_bytes();
        ext.extend([0, 0]);
        ext.extend(((name.len() + 5) as u16).to_be_bytes());
        ext.extend(((name.len() + 3) as u16).to_be_bytes());
        ext.push(0);
        ext.extend((name.len() as u16).to_be_bytes());
        ext.extend(name);
        ext.extend([0, 16, 0, 5, 0, 3, 2, b'h', b'2']);
        ext.extend([0, 43, 0, 3, 2, 3, 4]);

        let mut body = vec![3, 3];
        body.extend([7u8; 32]);
        body.push(0); // session id
        body.extend([0, 2, 0x13, 0x01]); // cipher suites
        body.extend([1, 0]); // compression
        body.extend((ext.len() as u16).to_be_bytes());
        body.extend(ext);

        let mut hs = vec![1, 0, (body.len() >> 8) as u8, body.len() as u8];
        hs.extend(body);
        let mut rec = vec![0x16, 3, 1];
        rec.extend((hs.len() as u16).to_be_bytes());
        rec.extend(hs);
        rec
    }

    #[test]
    fn client_hello_yields_sni_alpn_version() {
        let HelloParse::Done(h) = parse_client_hello(&client_hello("GitHub.com")) else { panic!() };
        assert_eq!(h.sni.as_deref(), Some("github.com"));
        assert_eq!(h.alpn, vec!["h2"]);
        assert!(h.tls13);
    }

    #[test]
    fn split_client_hello_asks_for_more_then_completes() {
        let full = client_hello("example.org");
        assert_eq!(parse_client_hello(&full[..40]), HelloParse::NeedMore);
        assert!(matches!(parse_client_hello(&full), HelloParse::Done(_)));
    }

    #[test]
    fn non_tls_and_hostile_sni_are_rejected() {
        assert_eq!(parse_client_hello(b"GET / HTTP/1.1\r\n"), HelloParse::No);
        let HelloParse::Done(h) = parse_client_hello(&client_hello("<script>x")) else { panic!() };
        assert_eq!(h.sni, None);
    }

    #[test]
    fn server_hello_reports_negotiated_version() {
        let mut body = vec![3, 3];
        body.extend([1u8; 32]);
        body.push(0);
        body.extend([0x13, 0x02, 0]);
        body.extend([0, 6, 0, 43, 0, 2, 3, 4]);
        let mut rec = vec![0x16, 3, 3, 0, 0, 2, 0, 0, body.len() as u8];
        rec.extend(body);
        let s = parse_server_hello(&rec).unwrap();
        assert_eq!(s.version, "TLS 1.3");
        assert_eq!(s.cipher, "TLS_AES_256_GCM_SHA384");
    }

    #[test]
    fn http_request_drops_query_string() {
        let h = parse_http_request(b"GET /a/b?token=secret HTTP/1.1\r\nHost: x.test\r\nUser-Agent: curl/8\r\n\r\n").unwrap();
        assert_eq!(h.path, "/a/b");
        assert_eq!(h.host.as_deref(), Some("x.test"));
        assert_eq!(h.user_agent.as_deref(), Some("curl/8"));
        assert_eq!(parse_http_status(b"HTTP/1.1 404 Not Found\r\n"), Some(404));
        assert!(parse_http_request(b"\x17\x03\x03 random\r\n").is_none());
    }

    #[test]
    fn dns_query_and_compressed_answer() {
        let q = [
            0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 3, b'w', b'w', b'w', 4, b't', b'e', b's', b't', 0, 0, 1, 0, 1,
        ];
        let msg = parse_dns(&q).unwrap();
        assert!(!msg.response);
        assert_eq!(msg.name, "www.test");
        assert_eq!(msg.qtype, 1);

        let mut r = q.to_vec();
        r[2] = 0x81;
        r[3] = 0x80;
        r[7] = 1;
        r.extend([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 9]);
        let msg = parse_dns(&r).unwrap();
        assert!(msg.response);
        assert_eq!(msg.answers, vec!["203.0.113.9".parse::<IpAddr>().unwrap()]);
        assert_eq!(msg.ttl, Some(60));
    }

    #[test]
    fn dns_pointer_loop_does_not_hang() {
        let mut m = vec![0, 0, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0];
        m.extend([0xc0, 12]);
        assert!(parse_dns(&m).is_none());
    }

    #[test]
    fn ipv4_tcp_segment_exposes_payload() {
        let mut p = vec![0x45, 0, 0, 44, 0, 0, 0x40, 0, 64, 6, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2];
        p.extend([0xc0, 0, 1, 0xbb, 0, 0, 0, 9, 0, 0, 0, 0, 0x50, 0x18, 0, 0, 0, 0, 0, 0]);
        p.extend(b"body");
        let s = parse_ipv4(&p).unwrap();
        assert_eq!(s.proto, Proto::Tcp);
        assert_eq!(s.dst.port(), 443);
        assert_eq!(s.seq, 9);
        assert_eq!(s.payload, b"body");
    }

    #[test]
    fn lso_packet_with_zero_total_length_still_parses() {
        let mut p = vec![0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, 6, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2];
        p.extend([0xc0, 0, 1, 0xbb, 0, 0, 0, 9, 0, 0, 0, 0, 0x50, 0x18, 0, 0, 0, 0, 0, 0]);
        p.extend(client_hello("big.example"));
        let s = parse_ipv4(&p).unwrap();
        let HelloParse::Done(h) = parse_client_hello(s.payload) else { panic!() };
        assert_eq!(h.sni.as_deref(), Some("big.example"));
    }

    #[test]
    fn query_results_keep_only_addresses() {
        let ips = parse_query_results("type: 5 cdn.test;203.0.113.7;::ffff:198.51.100.2;2001:db8::1;");
        assert_eq!(ips.len(), 3);
        assert_eq!(ips[1], "198.51.100.2".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn detects_quic_and_postgres() {
        assert_eq!(is_quic_long_header(&[0xc3, 0, 0, 0, 1, 8, 0]), Some("QUIC v1"));
        assert_eq!(is_quic_long_header(&[0x43, 0, 0, 0, 1, 8, 0]), None);
        assert!(is_postgres_startup(&[0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
        assert!(!is_postgres_startup(b"GET / HT"));
    }
}
