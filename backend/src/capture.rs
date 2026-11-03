//! 用原始套接字（SIO_RCVALL）旁路抓 IPv4 报文做协议识别，不需要安装驱动。
//! 每个本地地址一个线程，回环地址 127.0.0.1 也包括在内。IPv6 不支持，由 DNS 映射和端口推断兜底。

use crate::flows::Shared;
use crate::parse::parse_ipv4;
use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows_sys::Win32::NetworkManagement::IpHelper::{GetIpAddrTable, MIB_IPADDRTABLE};
use windows_sys::Win32::Networking::WinSock::*;

const RCV_BUF: i32 = 8 * 1024 * 1024;
const RESCAN_ADDRS: Duration = Duration::from_secs(30);
/// 只抓本机收发的报文，不把网卡切到混杂模式
const RCVALL_IPLEVEL: u32 = 3;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn local_ipv4s() -> Vec<Ipv4Addr> {
    let mut size = 16 * 1024u32;
    let mut buf = vec![0u64; size as usize / 8];
    let table = buf.as_mut_ptr() as *mut MIB_IPADDRTABLE;
    if unsafe { GetIpAddrTable(table, &mut size, 0) } != 0 {
        return vec![Ipv4Addr::LOCALHOST];
    }
    let rows = unsafe { std::slice::from_raw_parts((*table).table.as_ptr(), (*table).dwNumEntries as usize) };
    rows.iter()
        .map(|r| Ipv4Addr::from(r.dwAddr.to_ne_bytes()))
        .filter(|ip| !ip.is_unspecified())
        .collect()
}

/// 打开并绑定一个抓包套接字。失败时返回 WSA 错误码
fn open(ip: Ipv4Addr) -> Result<SOCKET, i32> {
    unsafe {
        let sock = socket(AF_INET as i32, SOCK_RAW, IPPROTO_IP);
        if sock == INVALID_SOCKET {
            return Err(WSAGetLastError());
        }
        let fail = |sock: SOCKET| {
            let code = WSAGetLastError();
            closesocket(sock);
            Err(code)
        };
        let rcv_buf = RCV_BUF;
        setsockopt(sock, SOL_SOCKET, SO_RCVBUF, (&raw const rcv_buf).cast(), 4);

        let addr = SOCKADDR_IN {
            sin_family: AF_INET,
            sin_port: 0,
            sin_addr: IN_ADDR { S_un: IN_ADDR_0 { S_addr: u32::from_ne_bytes(ip.octets()) } },
            sin_zero: [0; 8],
        };
        if bind(sock, (&raw const addr).cast(), size_of::<SOCKADDR_IN>() as i32) != 0 {
            return fail(sock);
        }
        let mode = RCVALL_IPLEVEL;
        let mut returned = 0u32;
        let rc = WSAIoctl(sock, SIO_RCVALL, (&raw const mode).cast(), 4, std::ptr::null_mut(), 0, &mut returned, std::ptr::null_mut(), None);
        if rc != 0 {
            return fail(sock);
        }
        Ok(sock)
    }
}

fn pump(sock: SOCKET, shared: Arc<Shared>) {
    let mut buf = vec![0u8; 65_536];
    loop {
        let n = unsafe { recv(sock, buf.as_mut_ptr(), buf.len() as i32, 0) };
        if n <= 0 {
            // 网卡下线后地址失效，线程退出，地址恢复后由重新扫描拉起
            unsafe { closesocket(sock) };
            return;
        }
        if let Some(seg) = parse_ipv4(&buf[..n as usize]) {
            shared.observe(&seg, now_ms());
        }
    }
}

/// 启动抓包。至少一个地址成功才算可用；之后定期扫描新增的地址
pub fn start(shared: Arc<Shared>) -> Result<(), String> {
    unsafe {
        let mut data: WSADATA = std::mem::zeroed();
        WSAStartup(0x0202, &mut data);
    }
    let mut opened = HashSet::new();
    let mut last_err = None;
    for ip in local_ipv4s() {
        match open(ip) {
            Ok(sock) => {
                let s = shared.clone();
                std::thread::Builder::new().name(format!("capture-{ip}")).spawn(move || pump(sock, s)).map_err(|e| e.to_string())?;
                opened.insert(ip);
            }
            Err(code) => last_err = Some(code),
        }
    }
    if opened.is_empty() {
        return Err(format!("无法打开原始套接字（WSA 错误 {}）", last_err.unwrap_or(0)));
    }
    std::thread::Builder::new()
        .name("capture-rescan".into())
        .spawn(move || loop {
            std::thread::sleep(RESCAN_ADDRS);
            for ip in local_ipv4s() {
                if opened.contains(&ip) {
                    continue;
                }
                if let Ok(sock) = open(ip) {
                    let s = shared.clone();
                    std::thread::spawn(move || pump(sock, s));
                    opened.insert(ip);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
