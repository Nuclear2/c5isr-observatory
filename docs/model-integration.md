# Codex 订阅模型桥接

核对日期：2026-10-22。桥接使用本机官方 Codex CLI，复用其已有 ChatGPT 登录。它是信息质量分析入口；用户可手动调用或显式开启持续 AI 信息模式。模型输出经过桥接与内核验证，形成建议；人工模式由人批准，AI 模式只自动批准该次新增的合格信息任务。

## 身份验证与计费边界

官方文档区分 ChatGPT 登录与 API 登录；`codex exec` 默认复用已保存的 CLI 身份。桥接通过 `codex login status` 核对登录类型，并强制使用 `forced_login_method="chatgpt"`。它不读取、复制或提取凭据文件和令牌，不实现自定义认证请求。[认证文档](https://learn.chatgpt.com/docs/auth)、[非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)。

| 本机状态 | 桥接行为 |
| --- | --- |
| 未安装 CLI 或不能启动 | 返回不可用，提示检查安装或路径 |
| 没有登录、登录类型不能确认 | 返回不可用，提示用户通过官方 `codex login` 登录 |
| 已使用 API key 登录 | 返回不可用；不使用 API 计费，也不替用户切换登录 |
| 已使用 ChatGPT 登录 | 允许手动请求或显式启用的持续 AI 信息请求；仍受账户权限、订阅额度、速率、网络和服务可用性影响 |

`available: true` 仅证明 CLI 报告 ChatGPT 登录，不能证明下一次请求一定成功、还有多少额度或请求免费。桥接本身处理一次请求，不自动重试；持续调度由服务器在用户启用 AI 模式后进行。两次调用开始至少间隔60秒，一次仅一个，倍速不加快墙钟调用间隔。该模式持续消耗适用的账户用量，直到停止或遇到错误；默认启动与普通仿真播放不会调用模型。

父进程环境中的 API key、访问令牌、其他认证令牌和替代端点变量会从子进程环境移除，避免意外选择其他计费方式。`CODEX_HOME` 保持原值，由官方 CLI 管理正常的凭据刷新。桥接不输出原始登录诊断或认证内容。

## 安装与调用

先通过官方方式安装 Codex CLI，并在本机终端执行 `codex login` 完成 ChatGPT 登录。无需向本项目提供 API key。默认使用 PATH 中的 `codex.exe`（Windows）或 `codex`；需要时设置 `C5ISR_CODEX_PATH` 为官方可执行文件的完整路径，不要填写命令、参数或脚本片段。

```powershell
node scripts/codex-bridge.mjs status
Get-Content -Raw .\snapshot.json | node scripts/codex-bridge.mjs analyze
```

`analyze` 读取一个 `contracts/state.ts` 中的 Snapshot JSON，输入通过标准输入传递，不能附加多个 JSON 文档。脚本标准输出只产生一行 JSON；没有进度日志或 CLI 事件泄露到调用方。

### 协议

`status` 正常输出（包括不可用状态）退出码为 0：

```json
{"available":true,"detail":"Codex CLI 已使用 ChatGPT 登录；调用受账户可用性与用量限制，授权调度由本地服务管理。"}
```

`analyze` 成功输出，退出码为 0：

```json
{
  "proposals": [{
    "title": "核对节点信息",
    "rationale": "当前合成观察存在延迟。",
    "action": "review_data",
    "subject_id": "原始本方节点 ID",
    "evidence_ids": ["原始观察 ID"],
    "uncertainties": ["合成置信指标未经校准。"],
    "expected_effect": "记录信息核对结果。"
  }],
  "summary": "供人工审阅的信息质量摘要。",
  "usage": {"input_tokens":100,"cached_input_tokens":20,"output_tokens":50}
}
```

`usage` 仅保留 CLI 报告的非负整数 token 计数；未提供时为 `null`。这些计数不能推导剩余订阅额度或货币费用。`proposals` 为 1–3 条，每条严格只有示例中的七个字段。结果验证失败或请求失败时输出 `{"error":"简短的可读错误"}` 并返回非零退出码；原始服务错误和本地路径不会直接反射到错误文本。

## 输入最小化

桥接先在本机筛选并重新命名对象。发送内容仅包括：

- 本方非 command 节点的泛化别名、domain、connection；command 仅作为信息中心别名。
- 两端均属于允许集合的链路及合成质量、延迟、启用状态。
- 本方节点产生且描述本方对象、最近 60 tick 内的已接收观察：泛化 ID、节点别名、生成/接收 tick、合成置信指标，最多保留最近 100 条。
- 当前 tick 与固定允许列表中的聚合流程指标。
- 已有 pending、approved、executing 提案的 action 与泛化 subject_id 组合，用于避免重复建议，不包含其自由文本。

真实型号名称、含型号的原始 ID、国家或阵营身份、敌方记录、坐标、角色描述、观察自由文本、事件消息、历史帧和已有提案的文字内容都不发送。模型只看到 `node-1`、`link-1`、`observation-1` 等别名。映射保留在桥接进程内，验证通过后再恢复输出引用。

提示明确所有量均为合成数据，只允许信息时效、数据核对、观察刷新和网络健康建议，不允许攻击、目标选择、武器、部署、交战或战术建议。名称作为显示符号的规则不会改变这一边界。

## 输出与状态约束

`contracts/model-output.schema.json` 传给 CLI 的 `--output-schema`；桥接另做独立校验，不能只依赖模型遵从提示或 CLI 的 schema 输出。原始 Codex JSONL 中仅保留最终 `agent_message` 与 `turn.completed` 的 token 计数，其他事件丢弃；不会保存或展示隐藏推理。[非交互模式与 JSONL](https://learn.chatgpt.com/docs/non-interactive-mode)。

| action | 允许对象 | 含义 |
| --- | --- | --- |
| review_data | 本方非 command 节点 | 请求核对合成数据 |
| restore_link | 本方链路 | 请求模拟网络修复 |
| request_observation | 本方非 command 节点 | 请求生成新的合成观察 |
| hold | command | 暂缓，等待人工审阅 |

每条建议必须引用 1–8 个输入中的观察 ID，并给出 1–5 条不确定性。非 hold 建议至少有一条证据关联所选节点，或关联所选链路的源节点。标题最多 100 字符、理由 800、预期效果 400、单条不确定性 300、摘要 1200；JavaScript 校验按 UTF-16 长度计数，可能比 JSON Schema 的 Unicode 字符计数更保守。未知字段、重复证据、未知 ID、非法动作、空白文本和控制字符会被拒绝。同一响应中的重复动作/对象组合，以及已在 pending、approved、executing 中的组合，也会被拒绝。

仿真引擎再次检查对象、证据相关性和新鲜度。手动请求期间若场景继续推进，原证据可能过期，此时展示失败；AI 模式等待模型时保持仿真 tick，避免时钟导致的过期。AI 自动审批调用与人工审批相同的校验接口，且只处理本次新增的 Codex 提案，不批准旧的基线建议。结构与引用校验不等于已经形式化证明自由文本语义。

## 取消与持续模式

服务器为每次请求生成唯一绝对路径，可调用 `node scripts/codex-bridge.mjs analyze --cancel-file <absolute-path>`。该文件只作为存在性标记，桥接每100ms检查一次，不执行或读取文件内容。预先存在时不启动Codex；运行中出现时终止该次创建的进程树，等待进程退出后返回 `{"error":"模型调用已取消"}`。轮询会在请求结束后释放，服务器负责删除标记。

停止先撤销模式代次、暂停仿真、写取消标记；在途结果即使赶在进程退出前返回也不能入库。重置还检查 run_id，避免旧结果污染新场景。`busy` 持续到清理完成，期间不能再开新请求。停止不撤销已经通过验证并批准的任务，手动恢复仿真时可继续。模型失败会将模式切回人工、暂停并显示原因，必须由用户显式重开，不自动重试。

## 进程边界与故障处理

- 使用 `spawn` 参数数组、`shell: false`、`windowsHide: true` 与标准输入/输出管道，不拼接 shell 命令。
- 单次模型子进程最长 90 秒，登录检查最长 15 秒；两者顺序执行。输入和子进程输出分别限制为 1 MiB，输出限制计入 stdout 与 stderr。
- 超时或输出超限后只终止本次创建的子进程树。Windows 使用该次 spawn 返回的 PID 调用 `taskkill /T /F`；其他平台使用独立进程组。不会按进程名称终止用户的其他 Codex 会话。
- 在新建的空临时工作目录中运行，使用 `--ignore-user-config`、`--ephemeral`、`--skip-git-repo-check`、`--sandbox read-only`，并将 `project_doc_max_bytes` 设为 0。凭据仍由原 `CODEX_HOME` 管理。
- 禁用 shell、apps、plugins、浏览器、电脑控制、多代理、hooks、图片生成等工具功能；设置 `web_search="disabled"`，抑制推理事件与会话历史。保留系统与管理员限制，若所需配置不被接受则失败，不自动降低限制。[CLI 参数](https://learn.chatgpt.com/docs/cli/reference)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
- 不持久化原始 JSONL、提示、认证内容或模型推理。`--ephemeral` 不意味着官方 CLI 完全不写任何正常运行元数据或认证刷新；桥接仅承诺不主动复制凭据或保存会话文本。

服务器应对调用实行单次进行中的互斥，并保留比桥接的登录检查、模型执行和清理之和更长的外层超时。分析结果的审阅、入库和事件回放由服务器/引擎负责。

本机 Windows 服务另用私有 Job Object 包含 Node 桥接及其后代，外层 120 秒截止时间覆盖输入写入、输出读取和退出等待。超时先发取消标记，随后必要时终止受控进程树；确认 Job 为空后才清除 busy。服务器调用状态检查时使用内部 `status --wait-for-stdin` 握手，在进程归属建立后才关闭输入、允许登录检查开始；普通 `status` 命令保持兼容。Ctrl+C 会先停止调度、关闭 SSE、取消当前请求并等待清理。此进程树验证只在 Windows 完成，不能据此宣称 Unix 的不同进程组行为已获等同验证。

## 离线验证与后续协作

运行 `node --test tests/codex-bridge.test.mjs`。测试覆盖输入最小化、身份与坐标排除、异常输入、别名恢复、非法动作/引用/字段拒绝、事件流分段解析、推理事件丢弃、环境过滤及命令行协议错误处理；测试不会发起在线模型请求。

可导入的测试接口包括 `LIMITS`、`minimizeSnapshot`、`buildPrompt`、`validateModelOutput`、`createCodexParser`、`parseCodexJsonl`、`sanitizeEnvironment`、`codexExecArgs`、`checkStatus`、`analyze`。后两个函数涉及本地 CLI；`analyze` 可能消耗订阅用量，应仅响应明确的人工请求或已启用的AI信息模式。离线测试另验证取消标记及实际假子进程树终止，不会调用线上模型。

2026-10-22 已使用本机 Codex CLI 0.144.5 的 ChatGPT 登录完成一次在线联调：结构化建议通过校验、进入待审列表，经人工批准和三个仿真步后产生反馈。只记录最终输出和用量计数，未记录凭据或隐藏推理。见 [验收记录](verification.md)；原始 `artifacts/demo-run.json` 仅保存在开发工作区，不随仓库发布。一次成功不保证后续账户额度或网络可用性。

Windows 注意：Node.js 入口路径不要使用 Rust `canonicalize()` 产生的 `\\?\` 前缀；本机 Node 曾在脚本加载前返回路径错误。服务使用编译时工作区路径，桥接入口识别另有命名空间和大小写回归测试。后续修改须同步维护 schema、桥接校验与引擎规则。
