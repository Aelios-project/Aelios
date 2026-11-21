# Aelios 记忆网关与路由架构

Aelios 负责身份识别、单轮记忆召回与对话记录，客户端工具链负责自身的工具循环。记忆存储、白天与夜间整理、来源溯源和留存策略详见 [docs/memory-lifecycle.md](memory-lifecycle.md)，请求净化与思考块边界详见 [docs/request-contract.md](request-contract.md)。

## 组件分工

| 组件 | 职责 |
| --- | --- |
| Worker | 原生协议入口、身份与主模型判定、单轮记忆注入、流式透传与响应头诊断 |
| Cloudflare AI Gateway | Provider 路由（`author/model`）、BYOK 密钥托管、Unified Billing、限流与日志 |
| Cloudflare Dynamic Routes | 预算、跨模型路由与上游回退（在 Cloudflare 控制台配置） |
| Workers AI | 向量化（`@cf/baai/bge-m3`）、重排（`@cf/baai/bge-reranker-base`）、默认 Dream（`glm-4.7-flash`）与 Clef 判定 |
| Vectorize (`memo-kb`) | 按 `namespace` 隔离的 1024 维余弦向量索引 |
| D1 (`companion_memory_proxy`) | 网关配置、原始对话、记忆、候选、日记、来源撤销表、ChatGPT 加密令牌 |
| Queue (`companion-memory`) | 异步对话落库、白天整理窗口与后台手动 Dream |
| Cron (`10 20 * * *` UTC) | 夜间 Dream、Clef 审核、日记与周/月记汇总、留存清理与令牌保活 |

## 配置模型与管理视角

全部运行时配置集中在 `/admin` 的「设置」页，分为三层。

1. **连接与上游** 填写 32 位 Cloudflare 账号 ID、完整 AI Gateway 地址或自定义 OpenAI 兼容地址。Cloudflare 令牌存放在 Worker Secret `CLOUDFLARE_API_TOKEN` 中。
2. **助手（Identities）** 每位助手配置路径名 `slug`（URL 第一段）、主模型规则 `models` 与允许使用的密钥列表 `keys`。写入空间 `namespace` 默认与 `slug` 相同，另可配置 `readNamespaces`、说话人称呼（`userName` / `assistantName`）、`codingFilter`、`thinkingPolicy` 与 `maxMemoryChars`。
3. **环境设置** `/admin` 设置白名单内的运行参数覆盖部署默认值。开关切换即时保存，文本项失焦保存（`PATCH /api/gateway/config` 按项合并），留空即恢复字段旁显示的部署值或内置默认值。

配置优先级为 D1 中保存的面板配置高于 Worker 环境变量 `GATEWAY_CONFIG`，两者皆空时回退为空配置。管理面板顶部的空间选择器仅切换当前浏览和管理的记忆空间，不影响客户端路由或助手配置。

### 主模型白名单

主模型白名单决定哪些请求启用记忆功能。匹配时兼容 `author/` 前缀并支持 `*` 通配符（例如 `*deepseek*` 同时匹配 `deepseek-chat` 与 `deepseek/deepseek-chat`）。未命中的辅助模型与杂务小模型直接透传，跳过召回与记录。

### 模型展示清单（`modelList`）

可选配置字段 `modelList`（位于 `/admin`「设置 → 模型与上游 → 模型清单」，通过 `PATCH /api/gateway/config` 传入 `{"modelList": [...]}`，传 `null` 或 `[]` 清空）控制 `GET /v1/models` 返回的模型列表。

- 未配置清单时，`GET /v1/models` 透传上游目录（Cloudflare 走 `compat/models`，自定义地址走 `{base}/models`），上游不可用时回落为主模型规则提示。
- 配置清单后，`GET /v1/models` 直接按添加顺序返回清单内容，响应头带 `x-aelios-models: list`，每项附加 `aelios: {"main": true | false}` 标注该模型在当前身份下是否启用记忆。清单最多 300 项，每项不含空白且最长 200 字符，支持自定义 Provider、动态路由及 `:floor` 等后缀写法。
- `modelList` 仅影响模型目录展示，清单之外的模型仍可按名称正常调用。`POST /api/gateway/models/test` 可按真实聊天方式检测单个模型连通性，且不记录对话。

## 上游路由规则

入口支持三种协议，路径为 `/<slug>/v1/chat/completions`、`/<slug>/v1/messages` 和 `/<slug>/v1/responses`，省略 `<slug>` 时匹配该密钥的第一个授权助手。

### Cloudflare 上游与运行地区

- **网关选择** 优先读取上游地址中附带的网关名，其次读取设置项 `AI_GATEWAY_ID`，均留空时使用账号默认网关（路径中为 `default`，REST 接口不带网关头）。夜间与白天整理共用同一网关。
- **Worker 运行地区** 在「模型与上游」设置 `PLACEMENT_REGION`，格式为 `provider:region`（如 `aws:ap-southeast-1`、`gcp:asia-east1`、`azure:southeastasia`）。由于 Worker 无法在运行期修改自身部署区域，`scripts/setup-cloudflare.mjs` 会在下次执行 `npm run deploy` 时读取该值写入临时 `wrangler.toml` 的 `[placement]` 段（也支持构建环境变量，以 `/admin` 为准）。留空则在下一次部署时移除区域固定。
- **Claude Messages 路线** `messages` 协议下以 `anthropic/` 开头的模型默认走 Cloudflare AI REST API（`https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1/messages`），使用 `Authorization: Bearer` 携带 `CLOUDFLARE_API_TOKEN`（需含 `Workers AI Read`），指定网关时附带 `cf-aig-gateway-id` 头，并将目录模型版本中的横线写法转换为点号写法（如 `claude-opus-5.5`）。当 REST 返回 `404 Model not found`、`400 No such model` / `5007`、`401 code 10000` 或 Unified Billing 不可用时，同一请求自动改发 `{gateway}/anthropic/v1/messages`（带 `cf-aig-authorization`）并在当前 isolate 记住该退路。模型自身返回的错误原样透传。
- **Chat Completions 路线** 所有 provider 的 `chat/completions` 统一走 `{gateway}/compat/chat/completions`，完整支持 BYOK、第三方 provider 前缀和 `custom-*` 自定义 provider。
- **其余原生端点** 其余 `messages` 请求走 `{gateway}/{provider}/v1/messages`，`responses` 请求走 `{gateway}/{provider}/v1/responses`（`openai` 与自定义 provider 路径不加 `/v1`），自动剥离模型名前缀并以 `cf-aig-authorization` 鉴权。无 provider 前缀的模型名在网关内直接返回 `400`。
- **自定义兼容地址** 上游填写非 Cloudflare 的 OpenAI 兼容基址时，按协议路径直接转发并以 Bearer 鉴权。

### ChatGPT 套餐线路（`chatgpt/<model>`）

模型名以 `chatgpt/` 开头时走用户本人的 ChatGPT Plus / Pro 套餐（通过 `/admin` 中的 Sign in with ChatGPT 登录，访问令牌与轮换刷新令牌由 `CHATBOX_API_KEY` 派生密钥加密存入 D1，借助 D1 租约串行刷新）。

- 该线路直接请求 `https://api.openai.com/v1/responses`（强制 `store: false`、`stream: true`），绕过 Cloudflare AI Gateway 与 `CLOUDFLARE_API_TOKEN`。
- Chat Completions、Anthropic Messages 与 Responses 客户端均可使用。前两种协议在网关内双向转换为 Responses（包含工具调用与思考摘要），随后按常规主模型完成召回与记录。
- 托管工具（图片生成、文件搜索、代码解释器、远端 MCP）、`previous_response_id`、`n > 1` 与音频输入会在发出前返回 `400`，函数工具与联网搜索正常支持。
- 首条内容事件之前的上游失败返回真实 HTTP 状态码，流开始后的错误以流内 error 事件传递。
- 会话缓存亲和度读取 `x-aelios-session-id`（兼容 Codex 的 `session-id`），两者均缺失时读取请求体中的 `prompt_cache_key`，与已认证的记忆空间和助手代号哈希后同时写入上游 `session-id` 与 `prompt_cache_key`。

### GPT 模型召回位置与提示词缓存

对于 ChatGPT 套餐、OpenAI API（含 Cloudflare 代付与 BYOK）以及 OpenRouter 上的 GPT 聊天模型，Aelios 保留客户端原始对话历史，将本轮召回内容封装为仅供当前回合参考的 JSON 引用数据。

- **Chat Completions** 在消息末尾追加独立 `developer` 消息（GPT-4 及更早系列使用 `system`）。流式请求如需返回用量统计，客户端可传入 `stream_options: { "include_usage": true }`。
- **OpenAI Responses** 自 GPT-6.2 起，召回数据写入位于 `input` 之后的顶层 `instructions`，同时把来自 Chat/Messages 转换的系统提示放在 `input` 开头的 `developer` 消息中以命中提示词缓存。更早版本的 GPT 与 OpenRouter Responses 在 `input` 末尾追加 `developer` 条目。
- **缓存与思考摘要** 客户端原有的 `instructions`、`prompt_cache_options`（含缓存诊断参数 `comparison_response_id`）、内容级缓存断点与缓存键均保留原义。Chat 请求在 `reasoning.effort` 高于 `minimal` 时请求思考摘要，GPT-6.2 在省略 `effort` 时同样请求摘要并保持模型默认强度。上游返回的缓存写入用量会保留在 Chat 的 `prompt_tokens_details` 与 Messages 的 `cache_creation_input_tokens` 中。

## 共享与迁移空间

每个助手只有一个写入空间 `namespace`（省略时等于 `slug`），可通过 `readNamespaces` 指定最多 8 个唯一召回空间。

```json
{
  "slug": "coder",
  "keys": ["CHATBOX_API_KEY"],
  "models": ["*opus*", "*sonnet*"],
  "namespace": "coder",
  "readNamespaces": ["coder", "coder-old", "shared-docs"]
}
```

- 省略 `readNamespaces` 时仅读取自身写入空间。显式传入数组时按该完整名单召回，传入 `[]` 表示只记录、不召回。召回名单只能在管理配置中修改，无法通过请求头或请求体覆盖。
- 跨空间检索并行执行、轮询归并、按类型与内容去重，最后统一应用单轮条数与字数预算。单个空间异常时继续返回其他可用空间的命中，全部失败才报告召回不可用。
- 注入计数写回条目所属空间，`recall_explain` 记录在写入空间内。Cron 仅对配置中的写入空间运行 Dream，避免只读共享关系触发额外整理。

## 写代码对话过滤（`codingFilter`）

当请求头（`User-Agent`、`x-title`、`Referer`、`originator`）识别为 Claude Code、Codex、Cline、opencode、Kilo Code、Aider 等编程代理，或工具定义同时包含命令行与文件编辑工具时，网关自动启用编程对话过滤。

- 用户消息与未调用工作工具的助手回复会将代码块替换为 `[code]`。
- 调用了工作工具的中间回合，仅保留面向人类的发言类工具调用，过滤读文件、跑命令、改文件的参数与返回，避免大段代码挤爆 8,000 字单条上限。
- 召回仅在人类回合触发且剥离代码块进行检索。助手配置里设置 `codingFilter: false` 可关闭过滤并完整记录。

## 缓存转换、思考块策略与工具字段学习

Aelios 单次请求只发往一个上游，不重排客户端前缀，也不主动插入提示词缓存断点，以维持各家模型的缓存命中。

- **顶层 `cache_control` 兼容** 为兼容部分拒绝顶层 `cache_control` 的代理或 Vertex 线路，网关会将其转换为注入前最后一个可缓存块上的显式断点，原有断点保持不变，TTL 冲突或断点超过 4 个时提前返回 `400`。
- **Anthropic thinking 策略** 支持 `auto`（默认）、`passthrough` 与 `drop_block`。默认 `auto` 在原生 Anthropic 线路及 OpenRouter Claude Messages 线路上遵循前缀失配处理策略，其余线路按 `passthrough` 透传。完整行为矩阵见 [docs/request-contract.md](request-contract.md)。
- **工具字段自适应剥离** 当某条线路返回 `400` 并提示 `unrecognizedProperty=<字段>`（常见于 Vertex 拒绝工具级 `cache_control` 或中转层拒绝 `eager_input_streaming`），网关剥离该字段重试，并在当前 isolate 按线路记住该规则。若希望首轮即预先剥离，可在「设置 → 模型与线路」填写逗号分隔的 `UPSTREAM_STRIP_TOOL_FIELDS`（工具核心字段 `name`、`description`、`input_schema`、`type` 受保护，禁止剥离）。
- **诊断响应头** 响应附带 `x-aelios-identity`、`x-aelios-memory`、`x-aelios-provider`、`x-aelios-model` 与 `x-aelios-normalized`（已清洗的非规范字段数），实际模型与 provider 优先采用上游返回的 `cf-aig-model` / `cf-aig-provider`。

## Hook 接口（magpie 插件用）

当代理流量已经经过 [magpie](https://github.com/yetone/magpie) 等外部网关时，可通过以下接口实现每轮召回与按需记录，无需更改代理上游。已通过 Aelios 网关转发的代理请勿同时开启 Hook，避免重复记录。

### `GET /v1/hook/identities`

使用同一把客户端 API Key 发现有权访问的助手路由提示。

- 返回 `{"identities": [{"slug": "...", "name": "...", "mainModels": [...]}], "selection": "first_matching_main_model", "unmatched": "memory_off"}`，按配置原序排列，仅包含这些公开字段（`name` 取去空白后的显示名或 `slug`）。
- 接口完全只读，无 SQL 写入或外部请求。缺失或无效密钥返回 `401`，MCP 密钥或无授权助手的密钥返回 `403`，配置读取失败返回 `503`，所有响应均带 `Cache-Control: private, no-store`。

### `POST /v1/hook/recall` 与 `POST /v1/hook/record`

两个 POST 接口共用以下字段。

| 字段 | 说明 |
| --- | --- |
| `protocol` | `chat`、`messages` 或 `responses`（`anthropic` 视同 `messages`） |
| `model` | 本轮模型名，用于匹配助手主模型白名单 |
| `agent` | 可选，调用方代理标识（如 `claude`、`codex`、`opencode`、`kilo`），用于触发编程对话过滤 |
| `session` | 可选，等同 `x-aelios-session-id`，缺省依次回退 `body.metadata.session_id` 与 `unscoped` |
| `identity` | 可选，显式指定已授权的助手 `slug`，省略时按配置顺序匹配第一个主模型命中的授权助手 |
| `body` | 请求体（可精简为 `messages`/`input`、工具名称与 `metadata`） |

- **`POST /v1/hook/recall`** 返回 HTTP `200` 及 `{"memory": "injected" | "empty" | "off" | "skipped" | "stateful" | "unavailable", "patch": "...", "recall_id": "...", "remember": "..."}`，调用方将 `patch` 附加到最后一条用户消息末尾。默认只做召回，仅在显式传入 `record: true` 时当场保存用户原话并处理即时记忆。调用方应在发送前自行拦截含敏感凭证的轮次。
- **`POST /v1/hook/record`** 额外接收 `reply`（非流式完整回复，可为 `null`）、`success`、`upstream_model` 与 `http_status`，写队列或直写 D1 后返回 `{"recorded": true, "exchange_id": "gw_req_...", "completion": "complete"}`（非主模型返回 `off`，带服务端状态的 Responses 返回 `stateful`，写入失败返回 `503`）。工具回合也需上报。`exchange_id` 基于请求内容与外层 `model` 哈希生成，同一轮 `recall` 与 `record` 自动去重，写入 `messages.source = "gateway:<slug>"`。
