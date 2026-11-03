//! 采集核心：连接表、ETW、抓包、进程表和状态引擎。
//! 独立服务（observatory.exe）和 Tauri 应用共用这一份。

pub mod capture;
pub mod collector;
pub mod elevation;
pub mod engine;
pub mod etw;
pub mod flows;
pub mod model;
pub mod parse;
pub mod procs;
pub mod tables;
