//! Offline lifecycle tests: only small local Node fixtures, never Codex/model calls.
use super::*;

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "c5isr-process-{}-{unique}-{sequence}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        // Only known test-owned files; no recursive removal of computed paths.
        for name in ["request.cancel", "observed-cancel", "heartbeat", "pids"] {
            let _ = std::fs::remove_file(self.file(name));
        }
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn node(script: &str) -> Command {
    let mut command = Command::new("node");
    command.arg("-e").arg(script);
    command
}

fn gated_node(script: &str) -> Command {
    node(&format!(
        "process.stdin.resume();process.stdin.once('end',()=>{{{script}}})"
    ))
}

fn js_path(path: &std::path::Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).unwrap()
}

#[tokio::test]
async fn bridge_process_exchanges_one_bounded_json_without_calling_model() {
    let output = run_bridge_process(node("process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ok:true})))"), Some(b"{}".to_vec()), None, Duration::from_secs(3), Duration::from_millis(100)).await.unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"ok":true})
    );
}

#[tokio::test]
async fn deadline_includes_blocked_stdin_and_kills_descendant() {
    let dir = TestDirectory::new();
    let heartbeat = js_path(&dir.file("heartbeat"));
    let child_script = format!(
        "const fs=require('node:fs'); setInterval(()=>fs.writeFileSync({heartbeat},String(Date.now())),20); setTimeout(()=>process.exit(0),5000)"
    );
    // Consume only one byte as an attachment handshake, then deliberately stop
    // reading so a large write blocks while the owned descendant is running.
    let script = format!(
        "process.stdin.once('readable',()=>{{process.stdin.read(1);const {{spawn}}=require('node:child_process'); spawn(process.execPath,['-e',{}],{{stdio:'ignore',windowsHide:true}}); setTimeout(()=>process.exit(0),5000);}})",
        serde_json::to_string(&child_script).unwrap()
    );
    let started = Instant::now();
    let result = run_bridge_process(
        node(&script),
        Some(vec![b'x'; 4_000_000]),
        Some(&dir.file("request.cancel")),
        Duration::from_millis(700),
        Duration::from_millis(100),
    )
    .await;
    assert_eq!(result.unwrap_err(), "模型调用超时");
    assert!(started.elapsed() < Duration::from_secs(3));
    let before = std::fs::read(dir.file("heartbeat")).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        std::fs::read(dir.file("heartbeat")).unwrap(),
        before,
        "descendant kept running after cleanup"
    );
}

#[tokio::test]
async fn timeout_first_requests_cooperative_marker_cancellation() {
    let dir = TestDirectory::new();
    let marker = dir.file("request.cancel");
    let script = format!(
        "const fs=require('node:fs');setInterval(()=>{{if(fs.existsSync({})){{fs.writeFileSync({},'yes');process.exit(0)}}}},10);setTimeout(()=>process.exit(0),5000)",
        js_path(&marker),
        js_path(&dir.file("observed-cancel"))
    );
    let result = run_bridge_process(
        gated_node(&script),
        None,
        Some(&marker),
        Duration::from_millis(300),
        Duration::from_secs(1),
    )
    .await;
    assert_eq!(result.unwrap_err(), "模型调用超时");
    assert_eq!(
        std::fs::read_to_string(dir.file("observed-cancel")).unwrap(),
        "yes"
    );
}

#[tokio::test]
async fn output_overflow_terminates_owned_tree_without_unbounded_buffer() {
    let result = run_bridge_process(
        gated_node(
            "process.stdout.write('x'.repeat(2000100));setTimeout(()=>process.exit(0),5000)",
        ),
        None,
        None,
        Duration::from_secs(3),
        Duration::from_millis(30),
    )
    .await;
    assert_eq!(result.unwrap_err(), "模型输出超过大小上限");
}

#[tokio::test]
#[cfg(windows)]
async fn parent_exit_does_not_hide_a_living_descendant() {
    let dir = TestDirectory::new();
    let child_script = format!(
        "const fs=require('node:fs');setInterval(()=>fs.writeFileSync({},String(Date.now())),20);setTimeout(()=>process.exit(0),5000)",
        js_path(&dir.file("heartbeat"))
    );
    // detached prevents libuv's own parent-exit cleanup from masking whether
    // our private Windows Job Object still owns the surviving descendant.
    let script = format!(
        "const fs=require('node:fs');const{{spawn}}=require('node:child_process');const child=spawn(process.execPath,['-e',{}],{{stdio:'ignore',windowsHide:true,detached:true}});child.unref();const ready=setInterval(()=>{{if(fs.existsSync({})){{clearInterval(ready);console.log('{{\"ok\":true}}');process.exit(0)}}}},10);setTimeout(()=>process.exit(2),4000)",
        serde_json::to_string(&child_script).unwrap(),
        js_path(&dir.file("heartbeat"))
    );
    let result = run_bridge_process(
        gated_node(&script),
        None,
        None,
        Duration::from_secs(3),
        Duration::from_millis(30),
    )
    .await;
    assert_eq!(
        result.unwrap_err(),
        "模型桥接退出后仍有子进程，已取消本次任务"
    );
    let before = std::fs::read(dir.file("heartbeat")).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(std::fs::read(dir.file("heartbeat")).unwrap(), before);
}

fn app_fixture(root: PathBuf) -> Arc<AppState> {
    let inner = Inner {
        engine: Engine::new(1),
        server_epoch: "shutdown-test".into(),
        model: ModelStatus {
            provider: "codex".into(),
            available: false,
            busy: false,
            last_error: None,
            last_run_tick: None,
            detail: "Offline test".into(),
        },
        journal: vec![],
        model_runs: vec![],
        automation: AutomationStatus::default(),
        active_job: None,
        job_sequence: 0,
    };
    let (updates, _) = watch::channel(inner.view().to_string());
    let (shutdown, _) = watch::channel(false);
    Arc::new(AppState {
        inner: Mutex::new(inner),
        updates,
        root,
        shutdown,
    })
}

#[tokio::test]
async fn shutdown_closes_existing_sse_and_stops_ticker() {
    let dir = TestDirectory::new();
    let app = app_fixture(dir.0.clone());
    app.inner.lock().await.engine.set_running(true);
    let ticker = tokio::spawn(run_ticker(Arc::clone(&app)));
    let response = events(State(Arc::clone(&app))).await.into_response();
    let body = tokio::spawn(axum::body::to_bytes(response.into_body(), 1_000_000));
    tokio::time::sleep(Duration::from_millis(30)).await;
    shutdown_app(&app).await;
    tokio::time::timeout(Duration::from_secs(1), ticker)
        .await
        .unwrap()
        .unwrap();
    let bytes = tokio::time::timeout(Duration::from_secs(1), body)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("event: state"));
    let inner = app.inner.lock().await;
    assert!(!inner.engine.snapshot().running);
    assert_eq!(inner.job_sequence, 0);
    assert!(app.ensure_running().is_err());
}

#[tokio::test]
async fn shutdown_waits_for_active_job_cleanup_and_discards_its_late_response() {
    let dir = TestDirectory::new();
    let app = app_fixture(dir.0.clone());
    let marker = dir.file("request.cancel");
    {
        let mut inner = app.inner.lock().await;
        inner.model.busy = true;
        inner.active_job = Some(ActiveJob {
            id: 1,
            cancel_path: marker.clone(),
            cancelled: false,
        });
    }
    let stopping_app = Arc::clone(&app);
    let stopping = tokio::spawn(async move {
        shutdown_app(&stopping_app).await;
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!stopping.is_finished());
    assert!(marker.exists());
    {
        let mut inner = app.inner.lock().await;
        assert!(inner.model.busy);
        let snapshot = inner.engine.snapshot();
        let job = ModelJob {
            id: 1,
            input: json!({}),
            run_id: snapshot.run_id,
            input_tick: snapshot.tick,
            automatic: false,
            generation: 0,
            cancel_path: marker,
        };
        finish_job(&mut inner, &job, Ok(json!({"proposals":[]})));
        assert!(inner.model_runs.is_empty());
        app.publish(&inner);
    }
    tokio::time::timeout(Duration::from_secs(1), stopping)
        .await
        .unwrap()
        .unwrap();
}
