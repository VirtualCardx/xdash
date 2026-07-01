// xdash 客户端：Linux 服务器监控数据采集，WebSocket 上报。
// 单文件实现。采集间隔 0.5s，上报间隔默认 3s，断线指数退避重连。
//
// 注意：进程内存按 PSS（Proportional Set Size）统计，需读取
//   /proc/[pid]/smaps_rollup，因此必须以 root 运行，才能采集到全部进程
//   的准确内存（否则只能读到自身可访问的进程）。见 xdash.service。
//
// 配置（环境变量）：
//   XDASH_URL      必填，服务端 ws/wss 地址，如 wss://xdash.example.workers.dev/ws
//   XDASH_TOKEN    必填，与服务端 DEVICE_TOKEN 一致的预共享 token
//   XDASH_INTERVAL 可选，上报间隔秒数，默认 3
//
// 构建（交叉编译为 Linux 静态单文件）：
//   rustup target add x86_64-unknown-linux-musl
//   cargo build --release --target x86_64-unknown-linux-musl

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    fs::File,
    io::{BufRead, BufReader},
    path::PathBuf,
    process,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

// ---------- 常量 ----------
const COLLECT_INTERVAL: Duration = Duration::from_millis(500); // 采集频率
const DEFAULT_SEND_INTERVAL: u64 = 3; // 上报间隔（秒）
const DEVICE_ID_FILE: &str = "xdash_device_id"; // device_id 持久化文件名
const STATE_DIR: &str = "/var/lib/xdash";
const TOP_PROCESSES: usize = 5;

#[derive(Serialize, Deserialize, Debug)]
struct ProcItem {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu: Option<f32>,
    /// 进程内存（字节）。口径为 PSS（Proportional Set Size）：
    /// 读自 /proc/[pid]/smaps_rollup 的 Pss 字段，把共享内存按进程数均分，
    /// 所有进程 PSS 之和≈整机真实进程内存占用。需以 root 运行才能读到全部进程。
    #[serde(skip_serializing_if = "Option::is_none")]
    mem: Option<u64>,
}

#[derive(Serialize, Debug)]
struct DiskItem {
    mount: String,
    used: u64,
    total: u64,
    percent: f32,
}

#[derive(Serialize, Debug)]
struct NetItem {
    name: String,
    rx_rate: f64,
    tx_rate: f64,
}

#[derive(Serialize, Debug)]
struct Report {
    device_id: String,
    hostname: String,
    os_name: String,
    os_version: String,
    kernel: String,
    arch: String,
    uptime_seconds: u64,
    cpu_model: String,
    cpu_cores: usize,
    total_memory: u64,
    ip_local: String,
    cpu_percent: f32,
    memory_percent: f32,
    cpu_top: Vec<ProcItem>,
    memory_top: Vec<ProcItem>,
    disk: Vec<DiskItem>,
    network: Vec<NetItem>,
}

struct StaticInfo {
    hostname: String,
    os_name: String,
    os_version: String,
    kernel: String,
    arch: String,
    cpu_model: String,
    cpu_cores: usize,
    ip_local: String,
}

// ---------- 配置 ----------
struct Config {
    url: String,
    token: String,
    send_interval: u64,
}

impl Config {
    fn from_env() -> Self {
        let url = env::var("XDASH_URL").unwrap_or_else(|_| {
            eprintln!("错误：未设置环境变量 XDASH_URL");
            process::exit(1);
        });
        let token = env::var("XDASH_TOKEN").unwrap_or_else(|_| {
            eprintln!("错误：未设置环境变量 XDASH_TOKEN");
            process::exit(1);
        });
        let send_interval = env::var("XDASH_INTERVAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_SEND_INTERVAL);
        // 确保上报间隔不小于采集间隔
        let send_interval = send_interval.max(1);
        Config {
            url,
            token,
            send_interval,
        }
    }

    // 把 token 作为查询参数附加到 ws url
    fn ws_url(&self) -> String {
        let sep = if self.url.contains('?') { '&' } else { '?' };
        format!("{}{}token={}", self.url, sep, urlencode(&self.token))
    }
}

// 极简 URL 编码（token 里若含特殊字符）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ---------- device_id 持久化 ----------
// 存到 systemd StateDirectory 对应的 /var/lib/xdash 下，首次运行生成 UUID。
// 兼容早期版本曾写到二进制同级目录的情况，避免升级后设备 ID 改变。
fn load_or_create_device_id() -> String {
    let path = device_id_path();
    if let Ok(id) = fs::read_to_string(&path) {
        let id = id.trim().to_string();
        if !id.is_empty() {
            return id;
        }
    }
    if let Some(id) = load_legacy_device_id() {
        if write_device_id(&path, &id).is_ok() {
            return id;
        }
    }
    let id = Uuid::new_v4().to_string();
    if let Err(e) = write_device_id(&path, &id) {
        eprintln!(
            "[{}] 写入 device_id 失败 path={} error={}",
            now_ts(),
            path.display(),
            e
        );
    }
    id
}

fn device_id_path() -> PathBuf {
    let state_path = PathBuf::from(STATE_DIR).join(DEVICE_ID_FILE);
    if fs::create_dir_all(STATE_DIR).is_ok() {
        return state_path;
    }
    PathBuf::from("/tmp").join(DEVICE_ID_FILE)
}

fn load_legacy_device_id() -> Option<String> {
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let legacy_path = dir.join(DEVICE_ID_FILE);
            if let Ok(id) = fs::read_to_string(legacy_path) {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Some(id);
                }
            }
        }
    }
    None
}

fn write_device_id(path: &PathBuf, id: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, id)
}

// ---------- 采集 ----------
struct Collector {
    sys: System,
    disks: Disks,
    networks: Networks,
    static_info: StaticInfo,
    last_net: std::collections::HashMap<String, (u64, u64, Instant)>, // name -> (rx, tx, time)
}

impl Collector {
    fn new() -> Self {
        let mut sys = System::new_with_specifics(
            RefreshKind::new()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything())
                .with_processes(process_refresh_kind()),
        );
        // 刷新一次以拿到基础信息；进程 CPU% 需两次刷新的差值。
        sys.refresh_cpu_all();
        sys.refresh_memory();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
        let disks = Disks::new_with_refreshed_list();
        let networks = Networks::new_with_refreshed_list();
        let static_info = StaticInfo::from_system(&sys);
        Collector {
            sys,
            disks,
            networks,
            static_info,
            last_net: std::collections::HashMap::new(),
        }
    }

    // 每 0.5s 调用：刷新轻量指标（不返回数据，仅更新内部状态）。
    // 进程列表和 PSS 读取较重，放到上报前刷新。
    fn tick(&mut self) {
        self.sys.refresh_cpu_all();
        self.sys.refresh_memory();
        self.disks.refresh();
        self.networks.refresh();
    }

    // 上报时调用：基于最新内部状态构造一份 Report
    fn build_report(&mut self, device_id: &str) -> Report {
        self.sys
            .refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh_kind());
        let sys = &self.sys;

        // CPU 总占用：所有核心平均
        let cpu_percent =
            sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>() / sys.cpus().len().max(1) as f32;

        // 内存占用百分比
        let total_mem = sys.total_memory();
        let used_mem = sys.used_memory();
        let memory_percent = if total_mem > 0 {
            used_mem as f32 / total_mem as f32 * 100.0
        } else {
            0.0
        };

        // CPU 占用前 5 进程。只维护 top-N，避免对全部进程排序。
        let mut cpu_top: Vec<ProcItem> = Vec::with_capacity(TOP_PROCESSES);
        for process in sys.processes().values() {
            push_cpu_top(
                &mut cpu_top,
                ProcItem {
                    name: process.name().to_string_lossy().into_owned(),
                    cpu: Some(process.cpu_usage()),
                    mem: None,
                },
            );
        }

        // 内存占用前 5 进程（口径为 PSS：把共享内存按进程数均分，更接近真实占用）。
        // PSS 读自 /proc/[pid]/smaps_rollup（需 root 才能读到全部进程）。
        // 逐进程读取 PSS 并维护 top-N，避免全量 Vec 排序和二次进程表查询。
        let mut memory_top: Vec<ProcItem> = Vec::with_capacity(TOP_PROCESSES);
        for (pid, process) in sys.processes() {
            push_mem_top(
                &mut memory_top,
                ProcItem {
                    name: process.name().to_string_lossy().into_owned(),
                    cpu: None,
                    mem: Some(read_pss(*pid)),
                },
            );
        }

        // 硬盘
        let disk: Vec<DiskItem> = self
            .disks
            .list()
            .iter()
            .map(|d| {
                let total = d.total_space();
                let used = total.saturating_sub(d.available_space());
                let percent = if total > 0 {
                    used as f32 / total as f32 * 100.0
                } else {
                    0.0
                };
                DiskItem {
                    mount: d.mount_point().to_string_lossy().into_owned(),
                    used,
                    total,
                    percent,
                }
            })
            .collect();

        // 网络速率（基于上次采样差值）
        let now = Instant::now();
        let mut net_items: Vec<NetItem> = Vec::new();
        for (name, data) in self.networks.list() {
            // 用累计字节数做差分，比 received()/transmitted() 增量值更稳定可预测
            let (rx, tx) = (data.total_received(), data.total_transmitted());
            let rate = if let Some(&(prev_rx, prev_tx, prev_t)) = self.last_net.get(name) {
                let dt = now.duration_since(prev_t).as_secs_f64().max(0.001);
                (
                    (rx.saturating_sub(prev_rx)) as f64 / dt,
                    (tx.saturating_sub(prev_tx)) as f64 / dt,
                )
            } else {
                (0.0, 0.0)
            };
            net_items.push(NetItem {
                name: name.to_string(),
                rx_rate: rate.0,
                tx_rate: rate.1,
            });
            self.last_net.insert(name.to_string(), (rx, tx, now));
        }

        let uptime_seconds = System::uptime();

        Report {
            device_id: device_id.to_string(),
            hostname: self.static_info.hostname.clone(),
            os_name: self.static_info.os_name.clone(),
            os_version: self.static_info.os_version.clone(),
            kernel: self.static_info.kernel.clone(),
            arch: self.static_info.arch.clone(),
            uptime_seconds,
            cpu_model: self.static_info.cpu_model.clone(),
            cpu_cores: self.static_info.cpu_cores,
            total_memory: total_mem,
            ip_local: self.static_info.ip_local.clone(),
            cpu_percent,
            memory_percent,
            cpu_top,
            memory_top,
            disk,
            network: net_items,
        }
    }
}

impl StaticInfo {
    fn from_system(sys: &System) -> Self {
        let cpu_model = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_default();

        StaticInfo {
            hostname: System::host_name().unwrap_or_default(),
            os_name: System::name().unwrap_or_default(),
            os_version: System::os_version().unwrap_or_default(),
            kernel: System::kernel_version().unwrap_or_default(),
            arch: std::env::consts::ARCH.to_string(),
            cpu_model,
            cpu_cores: sys.cpus().len(),
            ip_local: local_ip().unwrap_or_default(),
        }
    }
}

fn process_refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::new().with_cpu()
}

fn push_cpu_top(top: &mut Vec<ProcItem>, item: ProcItem) {
    let value = item.cpu.unwrap_or(0.0);
    let pos = top
        .iter()
        .position(|p| value > p.cpu.unwrap_or(0.0))
        .unwrap_or(top.len());
    if pos < TOP_PROCESSES {
        top.insert(pos, item);
        if top.len() > TOP_PROCESSES {
            top.pop();
        }
    } else if top.len() < TOP_PROCESSES {
        top.push(item);
    }
}

fn push_mem_top(top: &mut Vec<ProcItem>, item: ProcItem) {
    let value = item.mem.unwrap_or(0);
    let pos = top
        .iter()
        .position(|p| value > p.mem.unwrap_or(0))
        .unwrap_or(top.len());
    if pos < TOP_PROCESSES {
        top.insert(pos, item);
        if top.len() > TOP_PROCESSES {
            top.pop();
        }
    } else if top.len() < TOP_PROCESSES {
        top.push(item);
    }
}

// 读取本机主 IPv4 地址（非回环）
fn local_ip() -> Option<String> {
    // sysinfo 不直接提供本机 IP，这里用 /proc/net 或 std 尝试建立 UDP 连接获取出口 IP
    std::net::UdpSocket::bind("0.0.0.0:0").ok().and_then(|s| {
        s.connect("8.8.8.8:80").ok()?;
        s.local_addr().ok().map(|a| a.ip().to_string())
    })
}

/// 读取进程的 PSS（Proportional Set Size，字节）。
/// 来源：/proc/[pid]/smaps_rollup 的 Pss 字段（单位 KB）。
/// PSS 把共享内存按使用该内存的进程数均分，相比 RSS（sysinfo 的 memory()）
/// 不会重复计入共享库，所有进程 PSS 之和≈整机真实进程内存占用。
/// 需 root 才能读到其他用户的进程；读失败（权限/内核无此文件）返回 0。
fn read_pss(pid: Pid) -> u64 {
    let path = format!("/proc/{}/smaps_rollup", pid.as_u32());
    let Ok(file) = File::open(&path) else {
        return 0;
    };
    // 找 "Pss:" 开头的行，格式形如 "Pss:\t\t1100 kB"
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if let Some(rest) = line.strip_prefix("Pss:") {
            // 取行中第一个数字（KB）
            if let Some(kb) = rest.split_whitespace().next() {
                if let Ok(kb) = kb.parse::<u64>() {
                    return kb.saturating_mul(1024);
                }
            }
            break;
        }
    }
    0
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- 主循环 ----------
#[tokio::main(flavor = "current_thread")]
async fn main() {
    // rustls 0.23 需显式安装 CryptoProvider，否则连接 wss:// 时 panic。
    // 必须在任何 TLS 代码之前调用。选 ring 后端（与 Cargo.toml 的 ring feature 对应）。
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("安装 rustls ring provider 失败");

    let config = Config::from_env();
    let device_id = load_or_create_device_id();
    let send_interval = Duration::from_secs(config.send_interval);

    println!(
        "[{}] xdash 启动 device_id={} 上报间隔={}s",
        now_ts(),
        device_id,
        config.send_interval
    );

    let mut backoff = 1u64; // 重连退避秒数
    let mut collector = Collector::new();

    loop {
        // 先采集一轮（建立 CPU 基准），保证首次上报时 cpu_usage 已有有效差值
        collector.tick();
        tokio::time::sleep(COLLECT_INTERVAL).await;

        // 尝试连接
        let ws_url = config.ws_url();
        println!("[{}] 连接 {}", now_ts(), mask_url(&ws_url));
        match connect_async(&ws_url).await {
            Ok((ws_stream, _)) => {
                println!("[{}] 已连接", now_ts());
                backoff = 1; // 重置退避
                let (mut write, mut read) = ws_stream.split();

                let mut last_send = Instant::now() - send_interval; // 让首次立即发送
                loop {
                    // 采集 tick
                    collector.tick();

                    // 到达上报间隔则发送
                    if last_send.elapsed() >= send_interval {
                        let report = collector.build_report(&device_id);
                        match serde_json::to_string(&report) {
                            Ok(json) => {
                                if write.send(Message::Text(json)).await.is_err() {
                                    println!("[{}] 发送失败，准备重连", now_ts());
                                    break;
                                }
                            }
                            Err(e) => eprintln!("[{}] JSON 序列化失败: {}", now_ts(), e),
                        }
                        last_send = Instant::now();
                    }

                    // 检查服务端是否关闭连接（非阻塞式：用 try_next 风格不可行，这里短暂等待）
                    // 为保持简单，用 select 风格轮询：等待采集间隔期间若收到 Close 则断开
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Close(_))) | None => {
                                    println!("[{}] 连接已关闭", now_ts());
                                    break;
                                }
                                _ => {}
                            }
                        }
                        _ = tokio::time::sleep(COLLECT_INTERVAL) => {}
                    }
                }
            }
            Err(e) => {
                eprintln!("[{}] 连接失败: {}", now_ts(), e);
            }
        }

        // 断线重连：指数退避，最大 60s
        println!("[{}] {}秒后重连", now_ts(), backoff);
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(60);
    }
}

// 打印日志时隐藏 token，避免泄露
fn mask_url(url: &str) -> String {
    if let Some(idx) = url.find("token=") {
        format!("{}token=***", &url[..idx])
    } else {
        url.to_string()
    }
}
