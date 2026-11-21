# Aelios 记忆机制与生命周期

本文说明 Aelios 的记忆存储、对话捕获、召回、白天与夜间整理（Dream）、来源溯源、当前决定投影、交接信、小本本、聊天档案以及数据留存策略。网关转发、协议路由与接入配置见 [docs/memory-gateway.md](memory-gateway.md)。

## 存储分工

| 存储层 | 承担内容 |
| --- | --- |
| D1 (`companion_memory_proxy`) | 原始对话 `messages`、长期记忆 `memories` 与 `memory_lifecycle`、待审候选 `memory_candidates`、日记 `daily_log` / `weekly_log` / `monthly_log`、珍贵原话、黑话、交接信 `current_handoff`、小本本 `notebook`、聊天档案、Dream 运行记录与游标、来源映射与撤销表、白天整理收件箱 |
| Vectorize (`memo-kb`) | 1024 维余弦向量索引（默认模型 `workers-ai/@cf/baai/bge-m3`），按 `namespace` 隔离检索 |
| D1 FTS | 长期记忆和对话原话的全文词面索引，由写入路径与每日维护任务补建 |
| Queue (`companion-memory`) | 异步写入对话记录、调度白天整理窗口以及执行后台手动 Dream |
| Cron (`10 20 * * *` UTC) | 按写入空间依次执行夜间 Dream、Clef 自动审核、日记/周记/月记汇总、数据留存清理、可选 GitHub 日档拉取、FTS 与向量补建，以及 ChatGPT 套餐令牌保活 |

## 对话捕获与清洗

主模型的对话通过网关、Hook 接口或 MCP `log_conversation` 进入 `messages` 表。

- **去重幂等** 通过 `saveUserMessages` 写入的用户消息使用 10 分钟时间桶哈希（`conversationId + role + normalizedContent + 10m_bucket`）配合唯一部分索引，防止短时间内的客户端重试写入重复行，同时保留不同时间段重复说出的日常语句。
- **信封与系统噪声过滤** 若客户端消息带有 `<message ...>`、`<wecom-message ...>` 等传输信封，仅提取正文用于存储、召回与整理，忽略消息 ID 与哈希。客户端自动注入的 `<recap>`、`<system-reminder>`、`User stepped away; returning. Recap:` 以及助手侧的简短回执会被直接丢弃，不进入记忆与召回。旧历史数据在召回和 Dream 读取时也会按同样规则清洗。
- **写代码过滤** 当客户端识别为 Claude Code、Codex、Cline、opencode 等编程代理，或请求同时声明命令行和文件编辑工具时，默认只记录对话语言，代码块替换为 `[code]`，跳过读文件、跑命令和改文件的工具步骤。助手配置里的 `codingFilter: false` 可关闭此行为。

## 召回管线

### 自动召回（聊天热路径）

1. **多路候选** 用最新一轮用户原话并行检索 Vectorize 向量索引与 D1 词面索引，合并长期记忆、珍贵原话、黑话和近期对话片段。向量相似度下限（`MEMORY_MIN_SCORE`，默认 `0.1`）仅作基础过滤。
2. **批量重排** 使用 Workers AI 重排模型（`MEMORY_RERANKER_MODEL`，默认 `@cf/baai/bge-reranker-base`）对所有来源的原文片段做单次批量打分，默认超时 `1500` ms（`RECALL_RERANK_TIMEOUT_MS`），分数低于 `RECALL_RERANK_MIN_SCORE`（默认 `0.25`）的候选直接舍弃。重排失败或超时时回落词面命中，不额外调用生成式模型。
3. **排序微调与合并**
   - 助手亲笔写入的记忆（`authored_by` 非空）享有 `MEMORY_AUTHORED_BOOST`（默认 `1.15`）的排序加成。
   - 最近 `MEMORY_INJECT_DECAY_WINDOW_MIN`（默认 `30` 分钟）内已注入过的记忆乘以 `MEMORY_INJECT_DECAY_FACTOR`（部署默认 `0.15`，留空回落 `0.5`）压低排序，但仍按原始相关性判断地板分，作为唯一命中时照常返回。
   - 同一会话中最高分原话命中会与时间直接相邻、间隔 90 秒内的邻句合成连续片段。
   - 默认随命中附带对应周的 `weekly_log` 整块（`RECALL_WEEK_BLOCKS`，最多 `RECALL_WEEK_BLOCK_LIMIT=2` 块），作为背景上下文且不占用条数上限。
   - 可选开启 `RELATION_EXPANSION` 沿记忆关系边扩展一跳或两跳，默认关闭。
4. **单轮注入** 默认每轮最多注入 `MEMORY_FILTER_MAX_OUTPUT` 条（默认 `2` 条，普通闲聊通常取 1 条，追问往事时最多 2 条），自动注入使用不超过 400 字的原文窗口，并附带 `recall_explain` 诊断记录供 `/admin` 排查。日记不参与自动注入。

### 主动召回与冷启动

- MCP `recall` 与 `POST /v1/memory/recall` 返回完整记忆内容、ID 与来源信息，默认开启 `RECALL_PROVENANCE_SELECTION`。当问题明确询问亲笔记录、当前决定或原话措辞时，优先返回对应来源的证据。对话明确要求引用原话时，仅带入原始对话片段。
- MCP `wake_up` 返回核心记忆、近期印象（昨日日记与最近周/月记，预算由 `IMPRESSION_LADDER_MAX_CHARS` 控制，默认 `1000` 字符）、珍贵原话、黑话、小本本目录以及当前交接信。REST `GET /v1/memory_boot` 返回冷启动包，其中省略交接信。冷启动包在单个 Worker isolate 内缓存 60 秒。

## 白天整理（Daytime Dream）

`ROLLING_DREAM` 是 `/admin` 设置中的开关，默认开启（设为 `off`、`false`、`0` 或 `no` 关闭）。

- **触发与分窗** 写入 `messages` 表的新消息通过数据库触发器进入滚动收件箱。收件箱按插入顺序聚合成窗口，达到 `ROLLING_WINDOW_MESSAGES`（默认 `10` 条，上限 `100`）或 `ROLLING_WINDOW_CHARS`（默认 `8000` 字符）即通过 `MEMORY_QUEUE` 调度处理。单条超长消息独立成窗并按码点切段读取。
- **两步筛选与抽取** 每个窗口先由 `@cf/cloudflare/clef-flash` 判定是否包含值得长期保存的新信息、明确决定或对已有记忆的修正（包含显式决定线索时直接放行）。判定通过后再调用 `DREAM_MODEL` 产出待审候选或明确用户决定，写进现有 `memory_candidates` 队列。同一天的连续话题可在待审候选上追加引用证据。
- **跨窗备忘与容错** 窗口之间传递长度上限为 `ROLLING_STATE_CHARS`（默认 `1200` 字符）的短期状态，超限时优先保留仍有效的决定。处理超过 `ROLLING_CLAIM_TTL_MINUTES`（默认 `15` 分钟）视为卡住，可重试或交由夜间 Dream 接手。单窗最多尝试 `ROLLING_MAX_ATTEMPTS`（默认 `3` 次，上限 `10`），超限后记录错误并跳过，原话照常保留和可搜。
- **与夜间 Dream 协作** 白天整理和夜间 Dream 共用同一份收件箱完成记录。关闭开关后新消息全部留给夜间整理，开关来回切换时每条消息只抽取一次。日记仍然读取全天留存的原始对话。
- **状态与费用** `/admin` 的「夜间整理」页展示白天整理开关状态、积压条数、最近窗口调用次数和失败原因。Workers 免费档的 Workers AI 每日共享 10,000 neurons 额度，`chatgpt/...` 线路共享 ChatGPT 套餐额度，免费档用户可按需关闭 `ROLLING_DREAM`。

## 夜间整理（Nightly Dream）与汇总

每日 Cron（`10 20 * * *` UTC，对应新加坡/北京时间 04:10）遍历默认空间和所有配置了主模型的助手写入空间，按以下顺序执行。

### 1. 批量抽取与容错

- 目标日期为 `DREAM_TIME_ZONE`（默认 `Asia/Singapore`）下的「昨天」，并向前回看 3 天对未完成的日期补跑（最多 2 个历史日期）。每批读取 `DREAM_MAX_MESSAGES`（默认 `40` 条）并参考最多 `DREAM_MEMORY_CONTEXT_LIMIT`（默认 `40` 条）已有记忆，单晚最多执行 `DREAM_MAX_RUNS`（默认 `10` 批）。
- 抽取阶段在相同消息批次上串联运行摘要与候选抽取，单次模型调用含读响应体限时 120 秒，整段抽取阶段总预算 8 分钟。遇到 JSON 或结构错误时自动将批次减半并重跑两步（最多缩批 3 次），后半批留待下一轮继续。
- 合法输出里个别空白、超长或类型错误的条目会被单独丢弃并记录计数。容器类型错误、缺少候选数组或非空列表全部无效则判定为格式失败。模型或格式失败均不推进游标，也不删除原文。

### 2. 模型与输出预算

- 夜间与白天整理、聊天导入以及周记汇总使用 `DREAM_MODEL`，默认 `workers-ai/@cf/zai-org/glm-4.7-flash`。日记与月记可单独设置 `DIARY_MODEL`，留空沿用 `DREAM_MODEL`。
- 背景模型调用支持 Workers AI（走 `AI` 绑定）、AI Gateway 兼容接口以及 `chatgpt/<模型>` 套餐线路，仅发送消息与 JSON 格式要求。
- 输出长度由 `DREAM_MAX_TOKENS` 控制（1 至 `65536`）。仓库模板 `wrangler.toml` 默认配置为 `8000`。部署层与面板均未设置时，Workers AI 仍使用 `8000`，其他网关沿用上游默认上限。`chatgpt/...` 套餐线路始终遵循上游自身上限。

### 3. 手动触发与后台队列

- `/admin` 夜间整理页提交的非预览任务以及带 `{"background": true}` 的 `POST /v1/dream/run` 会写入持久队列 `MEMORY_QUEUE` 并立即返回 HTTP `202`、`data.run_id` 与 `data.status = "queued"`，关闭页面不中断执行。队列消费者 `max_batch_size = 1`，避免多个耗时任务争抢单次 Worker 执行预算。
- 省略 `background: true` 或启用 `dry_run: true` 时保持同步返回。缺少队列或入队失败返回 `503`。
- 同一空间已有 `queued` 或 `running` 任务时，拒绝新的后台入队（`force` 不绕过）。该约束仅针对后台队列任务，不覆盖 Cron 与同步调用。
- 超过 20 分钟未确认结束的任务在 `GET /v1/dream/status` 中标记为可能中断，需人工核查 Worker 日志后通过面板按钮或 `POST /v1/dream/resolve`（`{"run_id": "..."}`）显式收尾，已落库数据不回滚。条件领取保证重复投递不会重复启动整条管线，但领取后若发生中断需先核查再决定是否重跑。
- `GET /admin/dream/harvest?date=YYYY-MM-DD&namespace=...` 返回指定日期新创建的记忆、转入 `superseded` / `archived` 的记忆以及当天审结的候选，供夜间整理页展示收成。

### 4. Clef 自动审核

- `CLEF_AUTO_REVIEW` 默认开启。每日夜间 Dream 结束后，由 `@cf/cloudflare/clef` 决策模型对最多 `JUDGE_MAX_CANDIDATES`（默认 `100`）条日常待审候选做一次判定，仅区分记住与放下，按 Workers AI 输入 token 计费。
- 自动定下的条目显示在 `/admin` 待审页「本周自动处理」中，支持通过 `POST /v1/candidates/:id/undo` 逐条撤回。
- 从外部导入的候选始终停留在「导入的」分栏，等待人工确认，不进入自动审核。关闭 `CLEF_AUTO_REVIEW` 后，全部日常候选留在队列中由人工审批，或由助手通过 MCP `memory_candidates` 与 `memory_review` 处理。

### 5. 日记、周记与月记

- 每批 Dream 会在当天 `daily_log` 上写入整理草稿，该日最后一批完成后由叙事日记替换（`ENABLE_DIARY_WRITER`，默认开）。单日消息超过 `DIARY_SEGMENT_MESSAGES`（默认 `40`，下限 `10`）时分段摘要再合成。
- 日记正文仍留在聊天保留期内且所在周尚未归档为周记时，可通过日记页按钮或 `POST /admin/diary-rewrite`（`{"date": "YYYY-MM-DD"}`）按原文重写。
- `ENABLE_WEEKLY_ROLLUP` 与 `ENABLE_MONTHLY_ROLLUP` 默认开启。每周汇总写入 `weekly_log`，默认保留对应日日志供核对（`WEEKLY_ROLLUP_DELETE_DAILIES = false`，人工确认走 `POST /admin/weekly-approve`）。超过约五周的周记由月记任务折叠进 `monthly_log`。
- 若开启 `TRIGGER_BUILD`（默认关），夜批还会为当天新增记忆生成检索触发器并写入向量（模型取 `TRIGGER_BUILD_MODEL`，留空回落 `DREAM_MODEL`）。

## 来源溯源与撤回

Aelios 为记忆记录来源类别、引用消息 ID 以及派生依赖表，区分四类清理语义。

| 操作 | 入口 | 行为 |
| --- | --- | --- |
| 清理垃圾原话 | `DELETE /v1/raw/:id`（默认 `mode=clean`） | 仅删除该条原始聊天与词面索引，不影响已有记忆 |
| 撤回原话及已知派生 | `DELETE /v1/raw/:id?mode=withdraw` | 删除原话，并仅沿明确引用的证据链撤回相关衍生记忆与受影响草稿，同时在响应里返回 `withdrawn_memories` 与同批读过但未引用的 `unverified_memories` 供人工核对 |
| 纠错与更新记忆 | MCP `remember` 带 `replaces`，或 `/admin` 编辑 | 写入新版本，旧版本保留在修订历史中，不触发级联撤回 |
| 删除记忆 | `DELETE /v1/memories/:id` 或 MCP `forget`（`permanent: true`） | 软删除目标记忆并清理已知派生记忆，响应包含 `withdrawn_memories`。MCP `forget` 默认仅归档该条记忆，保留历史 |

**撤回边界** 逻辑撤回覆盖可追溯的当前活跃记忆、候选与向量，并写入撤销表阻止同一批任务重新恢复。已经折叠且失去来源映射的历史月记、手工交接信、独立珍藏的珍贵片段、小本本、已导出备份和外部模型日志各自独立，不凭文本相似度自动追删。逻辑下架也不提供密码学擦除保证。

## 当前决定投影（可选）

`CURRENT_STATE_PROJECTION` 为 `/admin` 设置开关，默认关闭（关闭 `RECALL_PROVENANCE_SELECTION` 时也会一并关闭）。

- 开启后，白天与夜间整理可为用户的明确决定生成带作用域的记录，键格式为 `decision:user/<context>/<property>`，写入前校验说话人、原话摘录、选定值与时间戳。
- 较晚补录的旧时间点证据按修订版本存为历史（`late_evidence`），不覆盖更新的决定。撤回当前决定所依赖的原话时，较早版本维持历史状态。
- 回答「现在选什么」类问题时，主动召回和网关召回优先排序用户的当前决定，并为过时的亲笔旧记忆附加日期提示而不改动原文字面。助手自身偏好类提问仍区分用户选择与助手立场。
- 作用域决定记录在管理页和 `PATCH /v1/memories/:id` 中为只读，需要变更时通过撤回原话或记录新的明确决定更新。

## 交接信、小本本与聊天档案

- **交接信（Handoff）** 每个记忆空间保存一份当前交接信（上限 20,000 字符），接口为 `GET / PUT / DELETE /v1/handoff` 与 MCP `handoff` 工具，读写采用乐观锁 `expected_revision`（版本过期返回 `409`）。仅在显式调用 MCP `wake_up` 时返回，常规网关请求与 REST `/v1/memory_boot` 均不自动注入，也不参与 Dream 抽取。Aelios-resident 投递交接信时携带稳定投递 ID 与原始生成时间，避免重试或旧信覆盖新版本或人工修改。
- **小本本（Notebook）** 通过 `/v1/notebook` 或 MCP `notebook` 按名称读写的工作笔记页，永不自动召回、不参与 Dream、不过期，适合持续任务记录。
- **聊天档案（Chat Archive）** 独立于短期聊天原文表，用于原文全文搜索。既可在 `/admin` 导入页选择「仅归档原文」零模型调用入库，也可在「设置 → 数据留存」开启 `CHAT_ARCHIVE_ENABLED`（默认关）自动归档新聊天。MCP `search_chat` 支持 2 至 120 字符的字面关键词或短语检索，将命中的消息 ID 传入同一工具的 `around` 参数即可查看同会话上下文。档案按 `CHAT_ARCHIVE_RETENTION_DAYS` 清理，留空或 `0` 表示长期保留。

## 数据留存与清理

每日维护任务在每个空间按 24 小时节流执行一次留存清理。

| 数据类别 | 默认保留周期 | 说明 |
| --- | --- | --- |
| 原始对话 `messages` | `MESSAGES_RETENTION_DAYS`（默认 `7` 天） | 仅清理已完成整理、超出保留期的原话，导入候选引用的原话单独保留 |
| 长期记忆 `memories` | 180 天未改写、未召回、未再次出现后标记过期 | `pinned`、身份和人格类记忆永不过期 |
| 已过期记忆 | 标记过期后 30 天硬删除 | 同步移除 D1 行、FTS 索引与 Vectorize 向量 |
| 聊天档案 | `CHAT_ARCHIVE_RETENTION_DAYS`（默认长期保留） | 按入档日期计算 |
| 用量与事件日志 | 30 天 | 幂等键保留 7 天 |
