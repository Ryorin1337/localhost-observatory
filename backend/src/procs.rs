//! 进程表：父子关系、路径、命令行、资源占用。

use crate::model::ProcInfo;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};

/// 直接向系统问一个 PID 的程序名。进程表每几秒才刷新一次，curl 这类很快退出的进程
/// 来不及进表，连接一出现就问，进程还活着的话就能拿到名字
pub fn image_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().filter(|n| !n.is_empty()).map(str::to_string)
    }
}

pub struct ProcReader {
    sys: System,
}

impl ProcReader {
    pub fn new() -> Self {
        Self { sys: System::new().expect("无法初始化进程枚举") }
    }

    pub fn read(&mut self) -> Vec<ProcInfo> {
        let kind = ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        let cpus = std::thread::available_parallelism().map(|n| n.get() as f32).unwrap_or(1.0);
        let mut procs: Vec<ProcInfo> = self
            .sys
            .processes()
            .values()
            // 线程在 Linux 上才算任务；这里按进程枚举，保险起见仍然过滤
            .filter(|p| p.thread_kind().is_none())
            .map(|p| ProcInfo {
                pid: p.pid().as_u32(),
                ppid: p.parent().map(|x| x.as_u32()).unwrap_or(0),
                name: p.name().to_string_lossy().into_owned(),
                exe: p.exe().map(|e| e.display().to_string()).unwrap_or_default(),
                cmd: p.cmd().iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "),
                started_at: p.start_time() * 1000,
                memory_bytes: p.memory(),
                // sysinfo 按单核 100% 计，这里换算成占整机的百分比
                cpu_percent: p.cpu_usage() / cpus,
            })
            .collect();
        procs.sort_by_key(|p| p.pid);
        procs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_name_resolves_a_live_pid_and_rejects_a_dead_one() {
        let name = image_name(std::process::id()).expect("应能解析自身");
        assert!(name.to_lowercase().starts_with("observatory"), "{name}");
        // 超出 PID 范围的值，系统里一定没有这个进程
        assert_eq!(image_name(0x7fff_fff0), None);
    }

    #[test]
    fn finds_this_test_process_and_its_parent() {
        let procs = ProcReader::new().read();
        let me = procs.iter().find(|p| p.pid == std::process::id()).expect("应能看到自身进程");
        assert!(me.name.to_lowercase().contains("observatory"));
        assert!(me.ppid != 0);
        assert!(me.started_at > 0);
        assert!(!me.exe.is_empty());
        assert!(procs.len() > 5);
    }
}
