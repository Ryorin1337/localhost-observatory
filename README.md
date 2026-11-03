# Localhost Observatory

Windows 本机网络活动监控站。后端 Rust，前端 React + Tailwind + ECharts，构建后是一个自带界面的单文件 exe。

## 两种运行方式

采集核心在 `backend/`（库 `observatory_core`），两个入口共用它：

| | 桌面应用（Tauri） | 独立服务 |
|---|---|---|
| 入口 | `src-tauri/` | `backend/src/main.rs` |
| 界面 | 自带窗口（WebView2） | 浏览器打开 http://127.0.0.1:9470 |
| 数据通道 | 应用内部 IPC，**不监听任何端口** | 本地 WebSocket |
| 提权 | 受限模式下横幅里有“以管理员身份重新启动”按钮 | 从管理员终端启动 |

两个可以同时运行，ETW 会话名不同，互不影响。

### 桌面应用

```powershell
npm install
npm run app:build -- --bundles nsis   # 产出 exe 和安装包
```

- `target\release\localhost-observatory.exe`：直接运行即可，不需要安装
- `target\release\bundle\nsis\Localhost Observatory_0.1.0_x64-setup.exe`：安装到当前用户目录，不需要管理员权限

只想要 exe：`npm run app:build -- --no-bundle`。需要 Rust、Visual Studio 的 C++ 工具链，以及 WebView2 运行时（Windows 11 自带）。第一次打安装包会从 GitHub 下载 NSIS。

应用默认以普通权限启动，此时只有连接、状态和进程树，横幅会说明缺什么。点横幅里的按钮会弹出系统的权限确认框，确认后应用以管理员身份重新打开，速率、域名、RTT 和协议识别随之可用；点“否”则保持原状。如果想每次启动都直接要求管理员，在 `src-tauri/build.rs` 里给 Windows 资源嵌入 `requireAdministrator` 清单即可，但这会让 `tauri dev` 无法从普通终端启动，所以现在没有这样做。

同一时间只允许一个实例。

### 独立服务

```powershell
npm install
npm run build                         # 产出 dist/index.html，会被嵌进二进制
cargo build --release -p observatory
.\target\release\observatory.exe
```

然后打开 http://127.0.0.1:9470 。**要获得完整数据，请从管理员终端启动**，否则只有受限模式（界面上会明确提示）。

| 数据 | 来源 | 需要管理员 |
|---|---|---|
| TCP/UDP 连接、TCP 状态、PID | IP Helper（`GetExtendedTcpTable`/`UdpTable`），250ms 轮询 | 否 |
| 进程树、路径、命令行、CPU、内存 | `sysinfo` | 否（读其他用户的进程信息受限） |
| 每连接上传/下载速率、重传、UDP 流 | ETW `Microsoft-Windows-Kernel-Network` | 是 |
| IP 到域名的映射 | ETW `Microsoft-Windows-DNS-Client` | 是 |
| RTT | `GetPerTcpConnectionEStats` | 是 |
| SNI、ALPN、TLS 版本、HTTP 请求行、DNS、QUIC、SSH、PostgreSQL 识别 | 原始套接字 `SIO_RCVALL`（免驱动） | 是 |

### 命令行参数

- `--port 9470`：监听端口
- `--dev`：允许 Vite 开发服务器连接
- `--diag-etw N`：把前 N 条网络 ETW 事件打印到 stderr，用来排查

## 开发

```powershell
npm test                      # 进程树逻辑测试
npm run app:dev               # 桌面应用，界面热更新
npm run dev                   # 只开界面，/ws 代理到独立服务；服务要加 --dev
npm run dev:demo              # 不需要后端，用模拟数据
npm run build:demo            # 模拟数据版，产出 dist-demo/
cargo test -p observatory     # 协议解析、状态追踪、安全校验、真实连接表
```

普通构建连不上后端时只会显示“后端未连接”，绝不会退回模拟数据。模拟数据只在 demo 构建里出现，并带有“演示数据”标记。

## 界面

| 视图 | 内容 |
|---|---|
| 总览 | 每进程实时上传/下载、吞吐量曲线、连接星图、连接表、TCP 状态分布、状态变化流 |
| 连接 | 完整连接表，可排序，含本地地址、累计流量、重传 |
| 时间线 | 每条连接在各 TCP 状态的停留时长 |
| 进程树 | 父子关系连线、每个进程及其子孙的连接和流量、主要对端、祖先链、命令行、监听端口 |
| 连接详情 | 点任意连接打开：诊断提示、生命周期、协议识别依据和字段 |

**过滤语法**：`proc:node`（名称或 PID）、`ip:203.0`、`port:443`、`state:close_wait`、`proto:tls`，其他词做全文匹配。`state:` 还支持 `failed`、`attention`。点进程、IP、端口、协议也会写入过滤条件。

**快捷键**：`/` 聚焦过滤框，`空格` 暂停/继续，`Esc` 关闭详情；进程树里 `←` `→` 折叠和展开。

## 已验证和未验证

在一台 Windows 11 上，用管理员权限实测过：

- **字节数准确**：本地回环下载 30 MB，两端的累计字节都是 100.0%（多出的 169 字节是 HTTP 头）。收发方向没有反。
- **SNI / ALPN**：curl、Node、Edge 的新连接都能识别，包括超过一个报文的大 ClientHello。
- **DNS**：查询和应答合成一条流，应答里的 IP 会反过来成为连接的域名。
- **HTTP**：回环上请求和响应能配对，状态码、耗时都对；路径已去掉查询串。
- **RTT**：和实测的 TCP 握手耗时大体吻合（如 8 对 7.6 ms、129 对 110 ms），个别长连接偏差较大，因为这是带平滑的值。如果网络里有透明代理，测到的是到代理的距离。
- **进程名**：curl 这类很快退出的进程会在连接出现时直接向系统查询，不再显示成 `PID 12345`。

没有验证：QUIC 的版本识别（只见过很少的流量）、SSH 和 PostgreSQL 的识别（只有单元测试）、IPv6、多网卡。

## 已知限制

- **外网 TCP 的入站内容看不到**：原始套接字抓不到对端发来的 TCP 数据（实测 28 条新的外网连接，没有一条看到 ServerHello 或 HTTP 响应），但能抓到入站的 DNS 应答。原因没有查清，网卡开着 RSC 是一个怀疑对象。后果是：外网连接没有 TLS 版本和密码套件，外网明文 HTTP 只有请求、没有状态码（界面显示“—”）。回环不受影响。
- **状态变化可能被漏掉**：TCP 状态靠 250ms 轮询，比这更快的变化看不到，比如本地连接的 `SYN_SENT` 经常直接显示为 `ESTABLISHED`。
- **建连失败不细分原因**：系统表只告诉我们握手没完成连接就消失了，不说明是超时还是被拒绝。
- **IPv6 没有协议内容**：原始套接字只抓 IPv4。IPv6 连接靠 DNS 映射取域名，靠端口推断协议，并在详情里注明“推断”。
- **QUIC 拿不到 SNI**：Initial 包要解密才能读 SNI，这里没有做，域名来自 DNS 映射。
- **后端启动前已有的连接**：没有握手可看，TLS 只能从记录头认出来，也没有 SNI。

## 安全

- 桌面应用不监听任何端口，数据只在应用内部的 IPC 通道里走。
- 独立服务只监听 `127.0.0.1`，并校验 `Host`（防 DNS rebinding）和 `Origin`（防其他网站读取本地 WebSocket）。
- 桌面应用的脚本受内容安全策略（CSP）限制，只能运行打包进去的那一份。样式指令放宽为允许内联，因为界面库会在运行时写入样式。
- 抓包只解析连接开头的握手字节，不保存载荷。HTTP 路径会去掉查询串，因为它常常带着令牌。

## 数据契约

前后端的数据结构在 `src/lib/types.ts` 和 `backend/src/model.rs`，两边要同步修改。连接时先发一条 `hello`（进程表、历史曲线、事件），之后每秒发一条 `frame`（完整连接快照）。WebSocket 和 Tauri 通道传的是同一份 JSON，界面只通过 `DataSource` 接口取数据（`wsSource.ts`、`tauriSource.ts`、`simulator.ts`）。
