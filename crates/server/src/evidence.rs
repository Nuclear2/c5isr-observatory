use super::*;
use sim_core::evidence_lab::{BatchRow, LabArchive, LabConfig, LabFrame, run_batch, run_lab};
use std::collections::HashMap;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/run", post(run))
        .route("/batch", post(batch))
        .route("/advice", post(advice))
        .route("/advice/cancel", post(cancel))
}

async fn run(Json(config): Json<LabConfig>) -> Result<Json<LabArchive>, ApiError> {
    run_lab(&config).map(Json).map_err(bad)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchRequest {
    config: LabConfig,
    count: u32,
}

async fn batch(Json(request): Json<BatchRequest>) -> Result<Json<Vec<BatchRow>>, ApiError> {
    // Batch experiments never need a live engine lock or a model.
    run_batch(&request.config, request.count)
        .map(Json)
        .map_err(bad)
}

#[derive(Copy, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Branch {
    Immediate,
    Review,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdviceRequest {
    config: LabConfig,
    branch: Branch,
    tick: u32,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CancelRequest {
    request_id: String,
}

struct AdviceInput {
    payload: Value,
    read_ids: Vec<String>,
    roots: HashMap<String, String>,
}

fn advice_input(frame: &LabFrame) -> Result<AdviceInput, ApiError> {
    let read: Vec<_> = frame
        .reports
        .iter()
        .filter(|r| r.read_tick.is_some())
        .collect();
    if read.is_empty() {
        return Err(bad("该帧审核席还没有读过报告。"));
    }
    let mut sources = HashMap::new();
    let read_ids: Vec<String> = read.iter().map(|r| r.id.clone()).collect();
    let visible = |id: &Option<String>| id.as_ref().filter(|id| read_ids.contains(id)).cloned();
    let mut reports = Vec::new();
    let mut roots = HashMap::new();
    for r in read {
        let next = sources.len() + 1;
        let source = sources.entry(&r.source).or_insert(next);
        reports.push(json!({
            "id":r.id,"source_id":format!("source-{source}"),"kind":r.kind,"claim":r.claim,
            "period_start":r.period_start,"period_end":r.period_end,
            "received_tick":r.received_tick,"read_tick":r.read_tick,
            "derived_from":visible(&r.derived_from),"revises":visible(&r.revises),
        }));
        roots.insert(r.id.clone(), r.root_id.clone());
    }
    Ok(AdviceInput {
        payload: json!({"tick":frame.tick,"reports":reports}),
        read_ids,
        roots,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Assessment {
    action: String,
    evidence_ids: Vec<String>,
    source_count: usize,
    reason: String,
    uncertainties: Vec<String>,
    #[serde(default, rename = "usage")]
    _usage: Option<Value>,
}

fn validated_advice(
    output: Value,
    input: &AdviceInput,
    branch: Branch,
    tick: u32,
) -> Result<Value, String> {
    let invalid = || "模型意见的动作、来源计数、说明或已读引用无效。".to_owned();
    let a: Assessment = serde_json::from_value(output).map_err(|_| invalid())?;
    let ids: HashSet<_> = a.evidence_ids.iter().collect();
    if !matches!(a.action.as_str(), "hold" | "request_review" | "conclude")
        || ids.is_empty()
        || ids.len() != a.evidence_ids.len()
        || a.source_count > ids.len()
        || a.reason.trim().is_empty()
        || a.reason.chars().count() > 800
        || a.uncertainties.len() > 5
        || a.uncertainties
            .iter()
            .any(|s| s.trim().is_empty() || s.chars().count() > 300)
    {
        return Err(invalid());
    }
    let roots: Option<HashSet<_>> = ids.iter().map(|id| input.roots.get(*id)).collect();
    Ok(json!({
        "provider":"codex", "branch":branch,"tick":tick,"read_ids":input.read_ids,"action":a.action,
        "evidence_ids":a.evidence_ids,"source_count":a.source_count,
        "verified_source_count":roots.ok_or_else(invalid)?.len(),
        "reason":a.reason,"uncertainties":a.uncertainties,
    }))
}

fn valid_request_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

async fn advice(
    State(app): State<Arc<AppState>>,
    Json(request): Json<AdviceRequest>,
) -> Result<Json<Value>, ApiError> {
    if !valid_request_id(&request.request_id) {
        return Err(bad("研判请求标识无效。"));
    }
    let recording = run_lab(&request.config).map_err(bad)?;
    let run = match request.branch {
        Branch::Immediate => recording.immediate,
        Branch::Review => recording.review,
    };
    let frame = run
        .frames
        .get(request.tick as usize)
        .ok_or_else(|| bad("帧超出本次实验范围。"))?;
    let input = advice_input(frame)?;
    let (id, marker) = {
        let mut inner = app.inner.lock().await;
        app.ensure_running()?;
        if inner.automation.mode == "ai" {
            return Err(ApiError(
                StatusCode::CONFLICT,
                "请先停止实时系统的持续 AI 研判。".into(),
            ));
        }
        let reserved = reserve_model(&mut inner, &app.root, Some(request.request_id))?;
        app.publish(&inner);
        reserved
    };
    // Own cleanup independently of the HTTP connection: closing a tab cannot
    // leave the shared model slot occupied or an untracked bridge process.
    tokio::spawn(async move {
        let result = bridge(
            &app.root,
            "evidence-advice",
            Some(input.payload.clone()),
            Some(&marker),
        )
        .await
        .and_then(|out| validated_advice(out, &input, request.branch, request.tick));
        let mut inner = app.inner.lock().await;
        let Some(job) = inner.active_job.as_ref().filter(|j| j.id == id) else {
            return Err(ApiError(StatusCode::CONFLICT, "研判所有权已失效。".into()));
        };
        let cancelled = job.cancelled;
        inner.active_job = None;
        inner.model.busy = false;
        let response = if cancelled {
            Err(ApiError(
                StatusCode::CONFLICT,
                "这次证据研判已取消。".into(),
            ))
        } else {
            result
                .map(Json)
                .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e))
        };
        app.publish(&inner);
        drop(inner);
        let _ = tokio::fs::remove_file(marker).await;
        response
    })
    .await
    .map_err(|_| {
        ApiError(
            StatusCode::INTERNAL_SERVER_ERROR,
            "证据研判任务异常退出。".into(),
        )
    })?
}

async fn cancel(
    State(app): State<Arc<AppState>>,
    Json(command): Json<CancelRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut inner = app.inner.lock().await;
    let active = inner
        .active_job
        .as_ref()
        .and_then(|j| j.advice_request.as_deref());
    if active != Some(&command.request_id) {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "该证据研判请求已结束或不属于本次操作。".into(),
        ));
    }
    cancel_active(&mut inner).await?;
    Ok(Json(json!({"cancelled":true})))
}

#[cfg(test)]
mod tests;
