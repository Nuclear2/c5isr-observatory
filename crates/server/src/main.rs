use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sim_core::{Engine, ModelProposal};
use std::{
    collections::HashSet,
    convert::Infallible,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::{Mutex, watch},
};
use tower_http::services::{ServeDir, ServeFile};

#[cfg(test)]
mod process_tests;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Serialize)]
struct ModelStatus {
    provider: String,
    available: bool,
    busy: bool,
    last_error: Option<String>,
    last_run_tick: Option<u64>,
    detail: String,
}

const AI_INTERVAL_SECONDS: u64 = 60;

#[derive(Debug, Serialize)]
struct AutomationStatus {
    mode: String,
    phase: String,
    interval_seconds: u64,
    cycles_completed: u64,
    auto_approved: u64,
    last_error: Option<String>,
    #[serde(skip)]
    next_due: Option<Instant>,
    #[serde(skip)]
    generation: u64,
}

impl Default for AutomationStatus {
    fn default() -> Self {
        Self {
            mode: "manual".into(),
            phase: "idle".into(),
            interval_seconds: AI_INTERVAL_SECONDS,
            cycles_completed: 0,
            auto_approved: 0,
            last_error: None,
            next_due: None,
            generation: 0,
        }
    }
}

struct ActiveJob {
    id: u64,
    cancel_path: PathBuf,
    cancelled: bool,
}

struct ModelJob {
    id: u64,
    input: Value,
    run_id: String,
    input_tick: u64,
    automatic: bool,
    generation: u64,
    cancel_path: PathBuf,
}

struct Inner {
    engine: Engine,
    server_epoch: String,
    model: ModelStatus,
    journal: Vec<Value>,
    model_runs: Vec<Value>,
    automation: AutomationStatus,
    active_job: Option<ActiveJob>,
    job_sequence: u64,
}

impl Inner {
    fn view(&self) -> Value {
        let mut value =
            serde_json::to_value(self.engine.snapshot()).expect("serializable snapshot");
        value["run_id"] = json!(format!(
            "{}-{}",
            self.server_epoch,
            value["run_id"].as_str().unwrap_or("run")
        ));
        value["model"] = json!(self.model);
        let mut automation = json!(self.automation);
        automation["next_run_in_seconds"] = if self.automation.mode == "ai" && !self.model.busy {
            self.automation
                .next_due
                .map(|due| {
                    json!(
                        due.saturating_duration_since(Instant::now())
                            .as_secs_f64()
                            .ceil() as u64
                    )
                })
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        value["automation"] = automation;
        value
    }

    fn record(&mut self, kind: &str, payload: Value) {
        self.journal.push(json!({"sequence":self.journal.len(), "tick":self.engine.snapshot().tick, "kind":kind, "payload":payload}));
    }
}

struct AppState {
    inner: Mutex<Inner>,
    updates: watch::Sender<String>,
    root: PathBuf,
    shutdown: watch::Sender<bool>,
}

impl AppState {
    fn ensure_running(&self) -> Result<(), ApiError> {
        if *self.shutdown.borrow() {
            Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "服务正在停止，不能启动新的操作".into(),
            ))
        } else {
            Ok(())
        }
    }
    fn publish(&self, inner: &Inner) -> Value {
        let value = inner.view();
        self.updates.send_replace(value.to_string());
        value
    }
}

#[derive(Debug)]
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Control {
    action: String,
    value: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Injection {
    kind: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    approve: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AutomationCommand {
    mode: String,
}

// Changing mode invalidates in-flight automatic responses before asynchronous cancellation.
fn stop_automation(inner: &mut Inner, error: Option<String>) {
    inner.automation.mode = "manual".into();
    inner.automation.phase = if error.is_some() { "error" } else { "idle" }.into();
    inner.automation.last_error = error;
    inner.automation.next_due = None;
    inner.automation.generation += 1;
    inner.engine.set_running(false);
}

async fn cancel_active(inner: &mut Inner) -> Result<(), ApiError> {
    if let Some(job) = &mut inner.active_job {
        job.cancelled = true;
        // Only a marker is written; the bridge terminates its owned process tree.
        tokio::fs::write(&job.cancel_path, b"cancel")
            .await
            .map_err(|_| {
                ApiError(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "已停止后续调用并作废当前结果，但取消标记写入失败；当前请求将等待超时退出"
                        .into(),
                )
            })?;
    }
    Ok(())
}

async fn automation(
    State(app): State<Arc<AppState>>,
    Json(command): Json<AutomationCommand>,
) -> Result<Json<Value>, ApiError> {
    let mut inner = app.inner.lock().await;
    app.ensure_running()?;
    match command.mode.as_str() {
        "ai" => {
            if inner.automation.mode == "ai" {
                return Ok(Json(app.publish(&inner)));
            }
            if !inner.model.available {
                return Err(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    inner.model.detail.clone(),
                ));
            }
            if inner.model.busy {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "等待当前模型任务退出后再开启 AI 模式".into(),
                ));
            }
            inner.automation = AutomationStatus {
                mode: "ai".into(),
                phase: "waiting".into(),
                next_due: Some(Instant::now()),
                generation: inner.automation.generation + 1,
                ..AutomationStatus::default()
            };
            inner.model.last_error = None;
            inner.engine.set_running(true);
            inner.record(
                "automation_started",
                json!({"interval_seconds":AI_INTERVAL_SECONDS,"scope":"own_information_tasks"}),
            );
        }
        "manual" => {
            stop_automation(&mut inner, None);
            inner.record("automation_stopped", json!({"reason":"user"}));
            let cancellation = cancel_active(&mut inner).await;
            app.publish(&inner);
            cancellation?;
        }
        _ => return Err(bad("模式必须为 manual 或 ai")),
    }
    Ok(Json(app.publish(&inner)))
}

async fn state(State(app): State<Arc<AppState>>) -> Json<Value> {
    Json(app.inner.lock().await.view())
}

async fn control(
    State(app): State<Arc<AppState>>,
    Json(command): Json<Control>,
) -> Result<Json<Value>, ApiError> {
    let mut inner = app.inner.lock().await;
    app.ensure_running()?;
    if inner.automation.mode == "ai" && !matches!(command.action.as_str(), "pause" | "reset") {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "请先停止 AI 信息自治，再手动控制时钟或感知周期".into(),
        ));
    }
    match command.action.as_str() {
        "play" => inner.engine.set_running(true),
        "pause" => {
            if inner.automation.mode == "ai" {
                stop_automation(&mut inner, None);
                inner.record("automation_stopped", json!({"reason":"pause"}));
                let cancellation = cancel_active(&mut inner).await;
                app.publish(&inner);
                cancellation?;
            } else {
                inner.engine.set_running(false);
            }
        }
        "step" => {
            if inner.engine.snapshot().running {
                return Err(bad("请先暂停，再单步推进"));
            }
            inner.engine.step();
        }
        "speed" => {
            let speed = u32::try_from(command.value.ok_or_else(|| bad("缺少 speed value"))?)
                .map_err(|_| bad("速度超出范围"))?;
            inner.engine.set_speed(speed).map_err(bad)?;
        }
        "observation_cycle" => {
            let cycle = u32::try_from(command.value.ok_or_else(|| bad("缺少感知周期 value"))?)
                .map_err(|_| bad("感知周期超出范围"))?;
            inner.engine.set_observation_cycle(cycle).map_err(bad)?;
        }
        "reset" => {
            let seed = command.value.unwrap_or(20261022);
            if seed > 9_007_199_254_740_991 {
                return Err(bad("seed 超过 JavaScript 精确整数范围"));
            }
            stop_automation(&mut inner, None);
            let cancellation = cancel_active(&mut inner).await;
            app.publish(&inner);
            cancellation?;
            inner.engine = Engine::new(seed);
            inner.journal.clear();
            inner.model_runs.clear();
            inner.model.last_run_tick = None;
            inner.model.last_error = None;
            inner.automation = AutomationStatus {
                generation: inner.automation.generation,
                ..AutomationStatus::default()
            };
        }
        _ => return Err(bad("未知控制动作")),
    }
    inner.record(&command.action, json!({"value":command.value}));
    Ok(Json(app.publish(&inner)))
}

async fn inject(
    State(app): State<Arc<AppState>>,
    Json(command): Json<Injection>,
) -> Result<Json<Value>, ApiError> {
    let mut inner = app.inner.lock().await;
    app.ensure_running()?;
    inner.engine.inject(&command.kind).map_err(bad)?;
    inner.record("inject", json!({"kind":command.kind}));
    Ok(Json(app.publish(&inner)))
}

async fn review(
    State(app): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(command): Json<Review>,
) -> Result<Json<Value>, ApiError> {
    let mut inner = app.inner.lock().await;
    app.ensure_running()?;
    if inner.automation.mode == "ai" {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "AI 模式下请先停止自治再人工审阅".into(),
        ));
    }
    inner.engine.review(&id, command.approve).map_err(bad)?;
    inner.record("review", json!({"id":id,"approve":command.approve}));
    Ok(Json(app.publish(&inner)))
}

async fn events(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let mut receiver = app.updates.subscribe();
    let mut shutdown = app.shutdown.subscribe();
    let stream = async_stream::stream! {
        if *shutdown.borrow() { return; }
        let initial = receiver.borrow_and_update().clone();
        yield Ok::<Event, Infallible>(Event::default().event("state").data(initial));
        loop {
            tokio::select! {
                biased;
                _ = shutdown.changed() => break,
                result = receiver.changed() => {
                    if result.is_err() { break; }
                    let update = receiver.borrow_and_update().clone();
                    yield Ok::<Event, Infallible>(Event::default().event("state").data(update));
                }
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
}

// Each job contains only a bridge process and its descendants. It is created
// before sending stdin, so a model cannot start before ownership is established.
#[cfg(windows)]
mod owned_process_tree {
    use std::{ffi::c_void, io, mem::size_of, ptr};
    use tokio::process::Child;

    #[repr(C)]
    #[derive(Default)]
    struct BasicLimits {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_working_set: usize,
        max_working_set: usize,
        active_limit: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct ExtendedLimits {
        basic: BasicLimits,
        io_counters: [u64; 6],
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Accounting {
        user_time: i64,
        kernel_time: i64,
        period_user_time: i64,
        period_kernel_time: i64,
        page_faults: u32,
        total_processes: u32,
        active_processes: u32,
        terminated_processes: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> isize;
        fn SetInformationJobObject(
            job: isize,
            class: i32,
            information: *const c_void,
            length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
        fn QueryInformationJobObject(
            job: isize,
            class: i32,
            information: *mut c_void,
            length: u32,
            returned: *mut u32,
        ) -> i32;
        fn TerminateJobObject(job: isize, exit_code: u32) -> i32;
        fn CloseHandle(handle: isize) -> i32;
    }

    pub struct ProcessTree(isize);
    impl ProcessTree {
        pub fn new() -> io::Result<Self> {
            // SAFETY: null security/name creates a private non-inheritable job.
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle == 0 {
                return Err(io::Error::last_os_error());
            }
            let tree = Self(handle);
            let limits = ExtendedLimits {
                basic: BasicLimits {
                    flags: 0x0000_2000,
                    ..Default::default()
                },
                ..Default::default()
            };
            // SAFETY: repr(C) matches JOBOBJECT_EXTENDED_LIMIT_INFORMATION; the
            // buffer remains alive for this synchronous call. 0x2000 is KILL_ON_JOB_CLOSE.
            if unsafe {
                SetInformationJobObject(
                    handle,
                    9,
                    (&limits as *const ExtendedLimits).cast(),
                    size_of::<ExtendedLimits>() as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(tree)
        }
        pub fn attach(&self, child: &Child) -> io::Result<()> {
            let process = child
                .raw_handle()
                .ok_or_else(|| io::Error::other("missing child handle"))?;
            // SAFETY: handles are live and owned by this ProcessTree/Child.
            if unsafe { AssignProcessToJobObject(self.0, process as isize) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
        pub fn is_empty(&self) -> io::Result<bool> {
            let mut accounting = Accounting::default();
            // SAFETY: repr(C) accounting buffer has the documented size and is writable.
            if unsafe {
                QueryInformationJobObject(
                    self.0,
                    1,
                    (&mut accounting as *mut Accounting).cast(),
                    size_of::<Accounting>() as u32,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(accounting.active_processes == 0)
        }
        pub fn terminate(&self) -> io::Result<()> {
            // SAFETY: only processes assigned to this private job are affected.
            if unsafe { TerminateJobObject(self.0, 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }
    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // SAFETY: this is the sole owner; closing also kills any remaining members.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(unix)]
mod owned_process_tree {
    use std::{
        io,
        sync::atomic::{AtomicI32, Ordering},
    };
    use tokio::process::Child;
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    pub struct ProcessTree(AtomicI32);
    impl ProcessTree {
        pub fn new() -> io::Result<Self> {
            Ok(Self(AtomicI32::new(0)))
        }
        pub fn attach(&self, child: &Child) -> io::Result<()> {
            self.0.store(
                child
                    .id()
                    .ok_or_else(|| io::Error::other("missing child pid"))? as i32,
                Ordering::Relaxed,
            );
            Ok(())
        }
        pub fn is_empty(&self) -> io::Result<bool> {
            let pid = self.0.load(Ordering::Relaxed);
            if pid == 0 {
                return Ok(true);
            }
            // SAFETY: negative ID targets only the dedicated process group.
            if unsafe { kill(-pid, 0) } == 0 {
                return Ok(false);
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(3) {
                Ok(true)
            } else {
                Err(error)
            }
        }
        pub fn terminate(&self) -> io::Result<()> {
            let pid = self.0.load(Ordering::Relaxed);
            if pid == 0 || unsafe { kill(-pid, 9) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(3) {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
    impl Drop for ProcessTree {
        fn drop(&mut self) {
            let _ = self.terminate();
        }
    }
}
use owned_process_tree::ProcessTree;

async fn terminate_bridge_tree(
    child: &mut Child,
    tree: &ProcessTree,
    cancel_path: Option<&std::path::Path>,
    grace: Duration,
) {
    if let Some(path) = cancel_path {
        let _ = tokio::fs::write(path, b"cancel").await;
    }
    if matches!(tokio::time::timeout(grace, child.wait()).await, Ok(Ok(_)))
        && matches!(tree.is_empty(), Ok(true))
    {
        return;
    }
    // An uncertain cleanup must keep the request busy. Retry only this owned
    // tree; never declare success because a timer elapsed or a PID disappeared.
    loop {
        let _ = tree.terminate();
        let waited = matches!(
            tokio::time::timeout(Duration::from_millis(250), child.wait()).await,
            Ok(Ok(_))
        );
        if waited && matches!(tree.is_empty(), Ok(true)) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn tree_exit_confirmed(tree: &ProcessTree) -> bool {
    // Windows may signal the root process before its job accounting update is
    // visible. Allow that short notification lag without accepting descendants.
    for _ in 0..25 {
        if matches!(tree.is_empty(), Ok(true)) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    matches!(tree.is_empty(), Ok(true))
}

async fn run_bridge_process(
    mut command: Command,
    input: Option<Vec<u8>>,
    cancel_path: Option<&std::path::Path>,
    deadline: Duration,
    grace: Duration,
) -> Result<std::process::Output, String> {
    let tree = ProcessTree::new().map_err(|_| "无法建立模型子进程生命周期边界".to_string())?;
    command
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动模型桥接程序，请检查 Node.js 路径".to_string())?;
    if tree.attach(&child).is_err() {
        // Both modes wait for stdin/EOF, so neither can have started Codex yet.
        let _ = child.start_kill();
        let _ = child.wait().await;
        return Err("无法接管模型子进程；请求未发送".into());
    }
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let attempt = tokio::time::timeout(deadline, async {
        let send = async move {
            let mut stdin = stdin.ok_or("模型输入管道不可用")?;
            if let Some(bytes) = input {
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|_| "模型输入传输失败")?;
            }
            stdin.shutdown().await.map_err(|_| "模型输入关闭失败")?;
            Ok::<_, &str>(())
        };
        let read = async move {
            let stdout = stdout.ok_or("模型输出管道不可用")?;
            let mut bytes = Vec::new();
            stdout
                .take(2_000_001)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "模型输出读取失败")?;
            if bytes.len() > 2_000_000 {
                return Err("模型输出超过大小上限");
            }
            Ok(bytes)
        };
        let wait = async { child.wait().await.map_err(|_| "模型进程未能正常结束") };
        let (_, stdout, status) = tokio::try_join!(send, read, wait)?;
        Ok::<_, &str>(std::process::Output {
            status,
            stdout,
            stderr: Vec::new(),
        })
    })
    .await;
    match attempt {
        Ok(Ok(output)) if tree_exit_confirmed(&tree).await => Ok(output),
        result => {
            let error = match result {
                Err(_) => "模型调用超时",
                Ok(Err(message)) => message,
                _ => "模型桥接退出后仍有子进程，已取消本次任务",
            };
            terminate_bridge_tree(&mut child, &tree, cancel_path, grace).await;
            Err(error.into())
        }
    }
}

async fn bridge(
    root: &std::path::Path,
    mode: &str,
    input: Option<Value>,
    cancel_path: Option<&std::path::Path>,
) -> Result<Value, String> {
    let node = std::env::var("C5ISR_NODE_PATH").unwrap_or_else(|_| "node".into());
    let mut command = Command::new(node);
    command
        .arg(root.join("scripts/codex-bridge.mjs"))
        .arg(mode)
        .current_dir(root);
    if mode == "status" {
        command.arg("--wait-for-stdin");
    }
    if let Some(path) = cancel_path {
        command.arg("--cancel-file").arg(path);
    }
    let output = run_bridge_process(
        command,
        input.map(|value| value.to_string().into_bytes()),
        cancel_path,
        Duration::from_secs(120),
        Duration::from_secs(3),
    )
    .await?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "模型桥接返回了无效 JSON".to_string())?;
    if !output.status.success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("模型调用失败")
            .chars()
            .take(400)
            .collect());
    }
    Ok(value)
}

fn prepare_job(
    inner: &mut Inner,
    root: &std::path::Path,
    automatic: bool,
    now: Instant,
) -> Result<ModelJob, ApiError> {
    if inner.model.busy {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "一次只能运行一个模型研判任务".into(),
        ));
    }
    if !inner.model.available {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            inner.model.detail.clone(),
        ));
    }
    let snapshot = inner.engine.snapshot();
    inner.job_sequence += 1;
    let id = inner.job_sequence;
    let cancel_path = root
        .join("runtime/cancel")
        .join(format!("{}-{id}.cancel", inner.server_epoch));
    inner.active_job = Some(ActiveJob {
        id,
        cancel_path: cancel_path.clone(),
        cancelled: false,
    });
    inner.model.busy = true;
    inner.model.last_error = None;
    if automatic {
        inner.automation.phase = "analyzing".into();
        inner.automation.next_due = Some(now + Duration::from_secs(AI_INTERVAL_SECONDS));
    }
    inner.record(
        "model_requested",
        json!({"job_id":id,"input_tick":snapshot.tick,"automatic":automatic}),
    );
    let mut input = serde_json::to_value(&snapshot).expect("serializable snapshot");
    input["history"] = json!([]);
    input["events"] = json!([]);
    Ok(ModelJob {
        id,
        input,
        run_id: snapshot.run_id,
        input_tick: snapshot.tick,
        automatic,
        generation: inner.automation.generation,
        cancel_path,
    })
}

// One lock covers validation, insertion and automatic approval, so stop cannot interleave.
fn finish_job(inner: &mut Inner, job: &ModelJob, result: Result<Value, String>) {
    if inner.active_job.as_ref().map(|active| active.id) != Some(job.id) {
        return;
    }
    let cancelled = inner
        .active_job
        .take()
        .is_some_and(|active| active.cancelled);
    inner.model.busy = false;
    let current_run = inner.engine.snapshot().run_id == job.run_id;
    if !current_run
        || cancelled
        || (job.automatic
            && (inner.automation.mode != "ai" || inner.automation.generation != job.generation))
    {
        // Do not copy an old run's final output into a reset scenario's archive.
        if current_run {
            inner.record(
                "model_cancelled",
                json!({"job_id":job.id,"response_discarded":true}),
            );
        }
        return;
    }
    let validation = match result {
        Ok(output) => {
            let previous: HashSet<String> = inner
                .engine
                .snapshot()
                .proposals
                .into_iter()
                .map(|p| p.id)
                .collect();
            let parsed = serde_json::from_value::<Vec<ModelProposal>>(output["proposals"].clone());
            let validation = if inner.engine.snapshot().tick.saturating_sub(job.input_tick) > 60 {
                Err("模型依据已超过 60 个仿真步，请暂停后重新研判".into())
            } else {
                parsed
                    .map_err(|_| "模型建议结构无效".to_string())
                    .and_then(|proposals| inner.engine.add_model_proposals(proposals))
            };
            inner.model_runs.push(json!({"job_id":job.id,"input_tick":job.input_tick,"automatic":job.automatic,"output":output,"accepted":validation.is_ok()}));
            validation.and_then(|()| {
                inner.model.last_run_tick = Some(job.input_tick);
                inner.record("model_accepted", json!({"job_id":job.id,"automatic":job.automatic,"output":output}));
                if job.automatic {
                    let ids: Vec<String> = inner.engine.snapshot().proposals.into_iter()
                        .filter(|p| p.source == "codex" && p.status == "pending" && !previous.contains(&p.id)).map(|p| p.id).collect();
                    for id in ids {
                        inner.engine.review(&id, true)?;
                        inner.automation.auto_approved += 1;
                        inner.record("auto_review", json!({"id":id,"approve":true,"job_id":job.id,"scope":"own_information_tasks"}));
                    }
                    inner.automation.cycles_completed += 1;
                    inner.automation.phase = "executing".into();
                }
                Ok(())
            })
        }
        Err(message) => Err(message),
    };
    if let Err(message) = validation {
        inner.record("model_failed", json!({"job_id":job.id,"message":message}));
        inner.model.last_error = Some(message.clone());
        if job.automatic {
            stop_automation(inner, Some(message.clone()));
            inner.record(
                "automation_stopped",
                json!({"reason":"model_error","message":message}),
            );
        }
    }
}

fn launch_job(app: Arc<AppState>, job: ModelJob) {
    tokio::spawn(async move {
        let result = bridge(
            &app.root,
            "analyze",
            Some(job.input.clone()),
            Some(&job.cancel_path),
        )
        .await;
        let mut inner = app.inner.lock().await;
        finish_job(&mut inner, &job, result);
        app.publish(&inner);
        drop(inner);
        let _ = tokio::fs::remove_file(&job.cancel_path).await;
    });
}

async fn analyze(State(app): State<Arc<AppState>>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let (job, response) = {
        let mut inner = app.inner.lock().await;
        app.ensure_running()?;
        if inner.automation.mode == "ai" {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "AI 模式已负责连续研判，请勿重复发起手动调用".into(),
            ));
        }
        let job = prepare_job(&mut inner, &app.root, false, Instant::now())?;
        (job, app.publish(&inner))
    };
    launch_job(app, job);
    Ok((StatusCode::ACCEPTED, Json(response)))
}

// Wall-clock cadence is independent of simulation speed. No model work on a default/manual tick.
fn advance_scheduler(inner: &mut Inner, root: &std::path::Path, now: Instant) -> Option<ModelJob> {
    if inner.automation.mode == "ai" {
        if inner.model.busy {
            return None;
        } // Hold evidence age while inference is in flight.
        let executing = inner
            .engine
            .snapshot()
            .proposals
            .iter()
            .any(|p| matches!(p.status.as_str(), "approved" | "executing"));
        if !executing && inner.automation.next_due.is_some_and(|due| now >= due) {
            match prepare_job(inner, root, true, now) {
                Ok(job) => return Some(job),
                Err(error) => {
                    stop_automation(inner, Some(error.1));
                    return None;
                }
            }
        }
        inner.automation.phase = if executing { "executing" } else { "waiting" }.into();
    }
    let snapshot = inner.engine.snapshot();
    if snapshot.running {
        for _ in 0..snapshot.speed {
            inner.engine.step();
        }
        inner.record("advance", json!({"steps":snapshot.speed}));
    }
    None
}

async fn run_ticker(app: Arc<AppState>) {
    let mut shutdown = app.shutdown.subscribe();
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *shutdown.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            _ = interval.tick() => {}
        }
        let mut inner = app.inner.lock().await;
        if *shutdown.borrow() {
            break;
        }
        let publish = inner.engine.snapshot().running || inner.automation.mode == "ai";
        let job = advance_scheduler(&mut inner, &app.root, Instant::now());
        if publish {
            app.publish(&inner);
        }
        drop(inner);
        // If shutdown won just after preparation, its marker invalidates this
        // job before the bridge can start a model. Still launch so busy is reaped.
        if let Some(job) = job {
            launch_job(Arc::clone(&app), job);
        }
    }
}

async fn shutdown_app(app: &Arc<AppState>) {
    let already_stopping = app.shutdown.send_replace(true);
    let mut changes = app.updates.subscribe();
    if !already_stopping {
        let mut inner = app.inner.lock().await;
        stop_automation(&mut inner, None);
        if let Err(error) = cancel_active(&mut inner).await {
            inner.model.last_error = Some(error.1);
        }
        let cancel_requested = inner.active_job.is_some();
        inner.record(
            "server_stopping",
            json!({"cancel_requested":cancel_requested}),
        );
        app.publish(&inner);
    }
    loop {
        {
            let inner = app.inner.lock().await;
            if inner.active_job.is_none() && !inner.model.busy {
                break;
            }
        }
        // finish_job publishes only after the bridge and owned process tree have
        // exited; a failed termination never releases the busy slot early.
        if changes.changed().await.is_err() {
            break;
        }
    }
}

async fn export(State(app): State<Arc<AppState>>) -> impl IntoResponse {
    let inner = app.inner.lock().await;
    let archive = json!({
        "schema_version":1, "kind":"c5isr-synthetic-experiment", "scenario_version":"archipelago-2-own-view",
        "notice":"所有参数和空间均为合成数据，装备名称仅为标签。历史快照用于回看，不代表现实作战效能。",
        "snapshot":inner.view(), "journal":inner.journal, "model_runs":inner.model_runs,
    });
    (
        [(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"c5isr-experiment.json\"",
        )],
        Json(archive),
    )
}

// Local-only service: reject cross-origin writes and DNS rebinding hostnames.
async fn local_boundary(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let host_name = host.split(':').next().unwrap_or("");
    if !matches!(host_name, "127.0.0.1" | "localhost") {
        return ApiError(StatusCode::FORBIDDEN, "仅允许本机访问".into()).into_response();
    }
    if request.method() != axum::http::Method::GET {
        if let Some(origin) = request.headers().get(header::ORIGIN) {
            let accepted = origin.to_str().ok().is_some_and(|s| {
                let suffix = s
                    .strip_prefix("http://127.0.0.1:")
                    .or_else(|| s.strip_prefix("http://localhost:"));
                suffix.is_some_and(|port| port.parse::<u16>().is_ok())
            });
            if !accepted {
                return ApiError(StatusCode::FORBIDDEN, "拒绝跨来源写入".into()).into_response();
            }
        }
    }
    next.run(request).await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or("workspace root missing")?
        .to_path_buf();
    tokio::fs::create_dir_all(root.join("runtime/cancel")).await?;
    let model_info = if std::env::var("C5ISR_DISABLE_MODEL").as_deref() == Ok("1") {
        Ok(
            json!({"available":false,"detail":"模型调用已由 C5ISR_DISABLE_MODEL=1 禁用；规则基线仍可使用"}),
        )
    } else {
        bridge(&root, "status", None, None).await
    };
    let (available, detail) = match model_info {
        Ok(info) => (
            info["available"].as_bool().unwrap_or(false),
            info["detail"]
                .as_str()
                .unwrap_or("Codex 状态未知")
                .to_string(),
        ),
        Err(message) => (false, message),
    };
    let inner = Inner {
        engine: Engine::new(20261022),
        server_epoch: format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ),
        model: ModelStatus {
            provider: "codex".into(),
            available,
            busy: false,
            last_error: None,
            last_run_tick: None,
            detail,
        },
        journal: Vec::new(),
        model_runs: Vec::new(),
        automation: AutomationStatus::default(),
        active_job: None,
        job_sequence: 0,
    };
    let (updates, _) = watch::channel(inner.view().to_string());
    let (shutdown, _) = watch::channel(false);
    let app = Arc::new(AppState {
        inner: Mutex::new(inner),
        updates,
        root: root.clone(),
        shutdown,
    });
    let ticker = tokio::spawn(run_ticker(Arc::clone(&app)));
    let api = Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"status":"ok","version":"0.1.0"})) }),
        )
        .route("/state", get(state))
        .route("/events", get(events))
        .route("/control", post(control))
        .route("/inject", post(inject))
        .route("/proposals/{id}/review", post(review))
        .route("/model/analyze", post(analyze))
        .route("/automation", post(automation))
        .route("/export", get(export))
        .fallback(|| async { ApiError(StatusCode::NOT_FOUND, "未知 API 路径".into()) });
    let router = Router::new()
        .nest("/api", api)
        .fallback_service(
            ServeDir::new(root.join("dist"))
                .not_found_service(ServeFile::new(root.join("dist/index.html"))),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(local_boundary))
        .with_state(Arc::clone(&app));
    let port: u16 = std::env::var("C5ISR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "C5ISR Observatory: http://127.0.0.1:{}",
        listener.local_addr()?.port()
    );
    println!("Synthetic data only. Ctrl+C to stop.");
    let stopping = Arc::clone(&app);
    let serving = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            shutdown_app(&stopping).await;
        })
        .await;
    shutdown_app(&app).await;
    let _ = ticker.await;
    serving?;
    Ok(())
}
