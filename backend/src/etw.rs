//! ETW 采集：Kernel-Network 给出每条流的字节数和重传，DNS-Client 给出域名映射。

use crate::flows::Shared;
use crate::parse::parse_query_results;
use ferrisetw::parser::Parser;
use ferrisetw::provider::Provider;
use ferrisetw::schema_locator::SchemaLocator;
use ferrisetw::trace::{stop_trace_by_name, TraceError, UserTrace};
use ferrisetw::EventRecord;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

const KERNEL_NETWORK: &str = "7dd42a49-5329-4832-8dfd-43d979153a88";
const DNS_CLIENT: &str = "1c95126e-7eea-49a9-a3fe-a378b03ddb4d";
const KEYWORD_IPV4: u64 = 0x10;
const KEYWORD_IPV6: u64 = 0x20;
const DNS_QUERY_COMPLETED: u16 = 3008;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum NetEvent {
    TcpSend,
    TcpRecv,
    TcpRetransmit,
    UdpSend,
    UdpRecv,
}

/// Microsoft-Windows-Kernel-Network 的事件编号，v4 和 v6 各一组
pub fn classify(id: u16) -> Option<NetEvent> {
    match id {
        10 | 26 => Some(NetEvent::TcpSend),
        11 | 27 => Some(NetEvent::TcpRecv),
        14 | 30 => Some(NetEvent::TcpRetransmit),
        42 | 58 => Some(NetEvent::UdpSend),
        43 | 59 => Some(NetEvent::UdpRecv),
        _ => None,
    }
}

/// 把事件的 saddr / daddr 换算成 (本地, 远端)。实测结果：TCP 的 saddr 收发都是本地端，
/// UDP 收包则是报文真实的来源和目的，saddr 是对端。回环和局域网 DNS 流量都验证过
pub fn endpoints(kind: NetEvent, saddr: SocketAddr, daddr: SocketAddr) -> (SocketAddr, SocketAddr) {
    match kind {
        NetEvent::UdpRecv => (daddr, saddr),
        _ => (saddr, daddr),
    }
}

pub fn record(shared: &Shared, kind: NetEvent, pid: u32, size: u32, local: SocketAddr, remote: SocketAddr) {
    match kind {
        NetEvent::TcpSend | NetEvent::TcpRecv | NetEvent::TcpRetransmit => {
            let mut map = shared.tcp.lock().unwrap();
            let c = map.entry((local, remote)).or_default();
            match kind {
                NetEvent::TcpSend => c.tx += size as u64,
                NetEvent::TcpRecv => c.rx += size as u64,
                _ => c.retrans += 1,
            }
        }
        NetEvent::UdpSend | NetEvent::UdpRecv => {
            let mut map = shared.udp.lock().unwrap();
            let c = map.entry((pid, local, remote)).or_default();
            if kind == NetEvent::UdpSend {
                c.tx += size as u64;
            } else {
                c.rx += size as u64;
            }
        }
    }
}

fn on_network(record_: &EventRecord, locator: &SchemaLocator, shared: &Shared, diag: &AtomicU32) {
    let Some(kind) = classify(record_.event_id()) else { return };
    let Ok(schema) = locator.event_schema(record_) else { return };
    let parser = Parser::create(record_, &schema);

    let saddr: Result<IpAddr, _> = parser.try_parse("saddr");
    let daddr: Result<IpAddr, _> = parser.try_parse("daddr");
    let sport: Result<u16, _> = parser.try_parse("sport");
    let dport: Result<u16, _> = parser.try_parse("dport");
    let pid: u32 = parser.try_parse("PID").unwrap_or(record_.process_id());
    let size: u32 = parser.try_parse("size").unwrap_or(0);
    let (Ok(saddr), Ok(daddr), Ok(sport), Ok(dport)) = (saddr, daddr, sport, dport) else { return };

    // 端口字段的输出类型是 win:Port，内存中是网络字节序
    let source = SocketAddr::new(saddr.to_canonical(), u16::from_be(sport));
    let dest = SocketAddr::new(daddr.to_canonical(), u16::from_be(dport));

    if diag.load(Ordering::Relaxed) > 0 {
        diag.fetch_sub(1, Ordering::Relaxed);
        eprintln!("[etw] id={} {kind:?} pid={pid} size={size} saddr={source} daddr={dest}", record_.event_id());
    }
    let (local, remote) = endpoints(kind, source, dest);
    record(shared, kind, pid, size, local, remote);
}

fn on_dns(record_: &EventRecord, locator: &SchemaLocator, shared: &Shared) {
    if record_.event_id() != DNS_QUERY_COMPLETED {
        return;
    }
    let Ok(schema) = locator.event_schema(record_) else { return };
    let parser = Parser::create(record_, &schema);
    let (Ok(name), Ok(results)) = (parser.try_parse::<String>("QueryName"), parser.try_parse::<String>("QueryResults")) else {
        return;
    };
    shared.remember_dns(&name, parse_query_results(&results));
}

pub struct EtwSession {
    _trace: UserTrace,
}

/// 启动 ETW 会话。未以管理员运行时会失败，调用方退回受限模式
pub fn start(shared: Arc<Shared>, session: &str, diag_events: u32) -> Result<EtwSession, String> {
    let diag = Arc::new(AtomicU32::new(diag_events));
    let net_shared = shared.clone();
    let net = Provider::by_guid(KERNEL_NETWORK)
        .any(KEYWORD_IPV4 | KEYWORD_IPV6)
        .add_callback(move |r: &EventRecord, l: &SchemaLocator| on_network(r, l, &net_shared, &diag))
        .build();
    let dns_shared = shared.clone();
    let dns = Provider::by_guid(DNS_CLIENT)
        .add_callback(move |r: &EventRecord, l: &SchemaLocator| on_dns(r, l, &dns_shared))
        .build();

    let begin = |net, dns| UserTrace::new().named(session.to_string()).enable(net).enable(dns).start_and_process();
    match begin(net, dns) {
        Ok(trace) => Ok(EtwSession { _trace: trace }),
        Err(err) => Err(describe(err)),
    }
}

/// 结束指定名字的会话。上次进程被强杀时会话会残留在系统里，启动前也要调用一次
pub fn stop_session(session: &str) {
    let _ = stop_trace_by_name(session);
}

fn describe(err: TraceError) -> String {
    format!("{err:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_ids_map_to_kinds() {
        assert_eq!(classify(10), Some(NetEvent::TcpSend));
        assert_eq!(classify(27), Some(NetEvent::TcpRecv));
        assert_eq!(classify(30), Some(NetEvent::TcpRetransmit));
        assert_eq!(classify(59), Some(NetEvent::UdpRecv));
        assert_eq!(classify(12), None);
    }

    #[test]
    fn udp_receive_is_swapped_so_both_directions_share_one_flow() {
        let (me, dns): (SocketAddr, SocketAddr) = ("192.168.10.10:55314".parse().unwrap(), "192.168.10.2:53".parse().unwrap());
        assert_eq!(endpoints(NetEvent::UdpSend, me, dns), (me, dns));
        assert_eq!(endpoints(NetEvent::UdpRecv, dns, me), (me, dns));
        assert_eq!(endpoints(NetEvent::TcpRecv, me, dns), (me, dns));
    }

    #[test]
    fn bytes_land_on_the_right_counter() {
        let s = Shared::default();
        let (l, r): (SocketAddr, SocketAddr) = ("10.0.0.1:1".parse().unwrap(), "10.0.0.2:2".parse().unwrap());
        record(&s, NetEvent::TcpSend, 1, 100, l, r);
        record(&s, NetEvent::TcpRecv, 1, 40, l, r);
        record(&s, NetEvent::TcpRetransmit, 1, 0, l, r);
        let c = s.tcp.lock().unwrap()[&(l, r)];
        assert_eq!((c.tx, c.rx, c.retrans), (100, 40, 1));
    }
}
