//! 通过 IP Helper 读取系统连接表，以及用 EStats 读取 RTT。

use crate::engine::{TcpRow, UdpRow};
use std::ffi::c_void;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use windows_sys::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::*;
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6, IN6_ADDR, IN6_ADDR_0};

fn port(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}

fn v4(raw: u32) -> IpAddr {
    IpAddr::V4(Ipv4Addr::from(raw.to_ne_bytes()))
}

/// 连接表里 IPv4 映射地址统一成 IPv4，和 ETW、抓包的地址形式一致
fn v6(raw: [u8; 16]) -> IpAddr {
    IpAddr::V6(Ipv6Addr::from(raw)).to_canonical()
}

fn state_name(s: u32) -> &'static str {
    match s {
        1 | 12 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTABLISHED",
        6 => "FIN_WAIT_1",
        7 => "FIN_WAIT_2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        _ => "CLOSED",
    }
}

/// FILETIME（100ns，自 1601 年）转 Unix 毫秒。0 表示系统没记录
fn filetime_ms(ft: i64) -> Option<u64> {
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;
    (ft > 0).then(|| (ft / 10_000 - EPOCH_DIFF_MS).max(0) as u64)
}

/// 两段式调用：先问大小，再取数据。两次调用之间表可能变大，所以循环重试
fn fetch(mut call: impl FnMut(*mut c_void, *mut u32) -> u32) -> Option<Vec<u64>> {
    let mut size = 64 * 1024u32;
    for _ in 0..5 {
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        match call(buf.as_mut_ptr().cast(), &mut size) {
            NO_ERROR => return Some(buf),
            ERROR_INSUFFICIENT_BUFFER => continue,
            _ => return None,
        }
    }
    None
}

pub fn read_tcp() -> Vec<TcpRow> {
    let mut out = Vec::with_capacity(512);
    let table4 = fetch(|p, size| unsafe { GetExtendedTcpTable(p, size, 0, AF_INET as u32, TCP_TABLE_OWNER_MODULE_ALL, 0) });
    if let Some(buf) = table4 {
        let table = unsafe { &*(buf.as_ptr() as *const MIB_TCPTABLE_OWNER_MODULE) };
        let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for r in rows {
            let state = state_name(r.dwState);
            if state == "CLOSED" {
                continue;
            }
            out.push(TcpRow {
                state,
                local: SocketAddr::new(v4(r.dwLocalAddr), port(r.dwLocalPort)),
                remote: SocketAddr::new(v4(r.dwRemoteAddr), if state == "LISTEN" { 0 } else { port(r.dwRemotePort) }),
                pid: r.dwOwningPid,
                created_at: filetime_ms(r.liCreateTimestamp),
                local_scope: 0,
                remote_scope: 0,
            });
        }
    }
    let table6 = fetch(|p, size| unsafe { GetExtendedTcpTable(p, size, 0, AF_INET6 as u32, TCP_TABLE_OWNER_MODULE_ALL, 0) });
    if let Some(buf) = table6 {
        let table = unsafe { &*(buf.as_ptr() as *const MIB_TCP6TABLE_OWNER_MODULE) };
        let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for r in rows {
            let state = state_name(r.dwState);
            if state == "CLOSED" {
                continue;
            }
            out.push(TcpRow {
                state,
                local: SocketAddr::new(v6(r.ucLocalAddr), port(r.dwLocalPort)),
                remote: SocketAddr::new(v6(r.ucRemoteAddr), if state == "LISTEN" { 0 } else { port(r.dwRemotePort) }),
                pid: r.dwOwningPid,
                created_at: filetime_ms(r.liCreateTimestamp),
                local_scope: r.dwLocalScopeId,
                remote_scope: r.dwRemoteScopeId,
            });
        }
    }
    out
}

pub fn read_udp() -> Vec<UdpRow> {
    let mut out = Vec::with_capacity(128);
    let table4 = fetch(|p, size| unsafe { GetExtendedUdpTable(p, size, 0, AF_INET as u32, UDP_TABLE_OWNER_MODULE, 0) });
    if let Some(buf) = table4 {
        let table = unsafe { &*(buf.as_ptr() as *const MIB_UDPTABLE_OWNER_MODULE) };
        let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for r in rows {
            out.push(UdpRow {
                local: SocketAddr::new(v4(r.dwLocalAddr), port(r.dwLocalPort)),
                pid: r.dwOwningPid,
                created_at: filetime_ms(r.liCreateTimestamp),
            });
        }
    }
    let table6 = fetch(|p, size| unsafe { GetExtendedUdpTable(p, size, 0, AF_INET6 as u32, UDP_TABLE_OWNER_MODULE, 0) });
    if let Some(buf) = table6 {
        let table = unsafe { &*(buf.as_ptr() as *const MIB_UDP6TABLE_OWNER_MODULE) };
        let rows = unsafe { std::slice::from_raw_parts(table.table.as_ptr(), table.dwNumEntries as usize) };
        for r in rows {
            out.push(UdpRow {
                local: SocketAddr::new(v6(r.ucLocalAddr), port(r.dwLocalPort)),
                pid: r.dwOwningPid,
                created_at: filetime_ms(r.liCreateTimestamp),
            });
        }
    }
    out
}

fn ne_addr(ip: IpAddr) -> Option<u32> {
    match ip {
        IpAddr::V4(a) => Some(u32::from_ne_bytes(a.octets())),
        IpAddr::V6(_) => None,
    }
}

fn in6(ip: IpAddr) -> Option<IN6_ADDR> {
    match ip {
        IpAddr::V6(a) => Some(IN6_ADDR { u: IN6_ADDR_0 { Byte: a.octets() } }),
        IpAddr::V4(_) => None,
    }
}

/// 打开 RTT 统计并读取平滑 RTT（毫秒）。需要管理员权限，失败时返回 None
pub fn read_rtt(local: SocketAddr, remote: SocketAddr, scopes: (u32, u32)) -> Option<f64> {
    let enable = TCP_ESTATS_PATH_RW_v0 { EnableCollection: true };
    let rw_size = size_of::<TCP_ESTATS_PATH_RW_v0>() as u32;
    let rod_size = size_of::<TCP_ESTATS_PATH_ROD_v0>() as u32;
    let mut rod: TCP_ESTATS_PATH_ROD_v0 = unsafe { std::mem::zeroed() };

    let status = if let (Some(l), Some(r)) = (ne_addr(local.ip()), ne_addr(remote.ip())) {
        let row = MIB_TCPROW_LH {
            Anonymous: MIB_TCPROW_LH_0 { State: MIB_TCP_STATE_ESTAB },
            dwLocalAddr: l,
            dwLocalPort: local.port().to_be() as u32,
            dwRemoteAddr: r,
            dwRemotePort: remote.port().to_be() as u32,
        };
        unsafe {
            let set = SetPerTcpConnectionEStats(&row, TcpConnectionEstatsPath, (&raw const enable).cast(), 0, rw_size, 0);
            if set != NO_ERROR {
                return None;
            }
            GetPerTcpConnectionEStats(&row, TcpConnectionEstatsPath, std::ptr::null_mut(), 0, 0, std::ptr::null_mut(), 0, 0, (&raw mut rod).cast(), 0, rod_size)
        }
    } else {
        let row = MIB_TCP6ROW {
            State: MIB_TCP_STATE_ESTAB,
            LocalAddr: in6(local.ip())?,
            dwLocalScopeId: scopes.0,
            dwLocalPort: local.port().to_be() as u32,
            RemoteAddr: in6(remote.ip())?,
            dwRemoteScopeId: scopes.1,
            dwRemotePort: remote.port().to_be() as u32,
        };
        unsafe {
            let set = SetPerTcp6ConnectionEStats(&row, TcpConnectionEstatsPath, (&raw const enable).cast(), 0, rw_size, 0);
            if set != NO_ERROR {
                return None;
            }
            GetPerTcp6ConnectionEStats(&row, TcpConnectionEstatsPath, std::ptr::null_mut(), 0, 0, std::ptr::null_mut(), 0, 0, (&raw mut rod).cast(), 0, rod_size)
        }
    };
    // 还没有样本时 SmoothedRtt 是 0 或 u32::MAX
    (status == NO_ERROR && rod.SmoothedRtt != 0 && rod.SmoothedRtt != u32::MAX).then_some(rod.SmoothedRtt as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn real_table_shows_a_socket_we_just_opened() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = std::net::TcpStream::connect(addr).unwrap();
        let client_addr = client.local_addr().unwrap();
        let rows = read_tcp();
        let me = std::process::id();
        assert!(rows.iter().any(|r| r.state == "LISTEN" && r.local == addr && r.pid == me));
        let row = rows.iter().find(|r| r.local == client_addr && r.remote == addr).expect("客户端连接应在表里");
        assert_eq!(row.state, "ESTABLISHED");
        assert_eq!(row.pid, me);
        assert!(row.created_at.is_some());
    }

    #[test]
    fn real_udp_table_shows_bound_port() {
        let sock = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let addr = sock.local_addr().unwrap();
        assert!(read_udp().iter().any(|r| r.local == addr && r.pid == std::process::id()));
    }

    #[test]
    fn filetime_converts_to_unix_ms() {
        assert_eq!(filetime_ms(116_444_736_000_000_000), Some(0));
        assert_eq!(filetime_ms(0), None);
    }
}
