//! 管理员权限：检测，以及让应用自己以管理员身份重启。

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

const SYNCHRONIZE: u32 = 0x0010_0000;
/// ShellExecute 在用户点了“否”时的返回值（SE_ERR_ACCESSDENIED）
const USER_CANCELLED: isize = 5;

pub fn is_elevated() -> bool {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut size = 0u32;
        let ok = GetTokenInformation(token, TokenElevation, (&raw mut info).cast(), size_of::<TOKEN_ELEVATION>() as u32, &mut size);
        CloseHandle(token);
        ok != 0 && info.TokenIsElevated != 0
    }
}

fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// 以管理员身份再启动一份自己，并让新进程等当前进程退出后再初始化。
/// 弹出的系统权限确认框被取消时返回 Err，调用方应该继续运行，不能退出。
pub fn relaunch_elevated() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let args = wide(format!("--wait-parent {}", std::process::id()));
    let rc = unsafe { ShellExecuteW(std::ptr::null_mut(), wide("runas").as_ptr(), wide(&exe).as_ptr(), args.as_ptr(), std::ptr::null(), SW_SHOWNORMAL) } as isize;
    match rc {
        r if r > 32 => Ok(()),
        USER_CANCELLED => Err("已取消".into()),
        r => Err(format!("无法以管理员身份启动（错误 {r}）")),
    }
}

/// 等指定进程退出。返回 true 表示它已经退出（或根本不存在）
pub fn wait_for_exit(pid: u32, timeout_ms: u32) -> bool {
    unsafe {
        let handle = OpenProcess(SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return true;
        }
        let exited = WaitForSingleObject(handle, timeout_ms) == WAIT_OBJECT_0;
        CloseHandle(handle);
        exited
    }
}

/// 命令行里的 `--wait-parent <pid>`
pub fn parent_to_wait_for() -> Option<u32> {
    let args: Vec<String> = std::env::args().collect();
    let at = args.iter().position(|a| a == "--wait-parent")?;
    args.get(at + 1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn wait_for_exit_sees_a_child_finish_and_times_out_on_a_live_process() {
        let mut child = Command::new("cmd").args(["/c", "ping -n 2 127.0.0.1 >nul"]).spawn().unwrap();
        assert!(!wait_for_exit(child.id(), 50), "子进程还在运行时不应判定为已退出");
        assert!(wait_for_exit(child.id(), 10_000));
        child.wait().unwrap();
        // 已经不存在的进程视为已退出
        assert!(wait_for_exit(child.id(), 50));
    }

    #[test]
    fn elevation_probe_does_not_panic() {
        let _ = is_elevated();
    }
}
