# Aelios

**给 AI 加一颗长期记忆。** 换窗口、换客户端、换模型，记忆始终跟着你走。

简体中文 | [English](README.md) · QQ 群 `1091783659`

Aelios 是运行在 Cloudflare Workers 上的记忆网关。你的 Chatbox、Claude Code、Codex 或自建代理先连接 Aelios，由 Aelios 转发给模型，同时记录对话并在每轮对话中自动带回相关记忆。

```text
你的客户端  →  Aelios（识别助手、召回、记录）  →  上游模型
```

## 让 AI 帮你配

如果你使用 Claude Code、Codex、Cursor 等能执行命令的 AI，或已连接 Cloudflare MCP 的 AI，把下面这段话直接发给它。

```text
帮我装好、配好 Aelios（我的 AI 记忆网关）。先读 https://raw.githubusercontent.com/Aelios-project/Aelios/main/docs/setup-with-ai.md ，照着做。需要我在浏览器里点、或者需要我自己填 key 的时候，停下来告诉我去哪儿填。
```

从空白 Cloudflare 账号或已有部署开始都可以。AI 会帮你 Fork、部署、生成 Cloudflare 令牌、配置第一位助手并按需导入旧记忆或聊天记录，最后交给你地址（Base URL）、API Key 和模型名。你只需准备一个免费的 Cloudflare 账号和模型厂商的 Key，亲自在浏览器里授权登录并将厂商 Key 存进 Cloudflare 后台，凭证全程不经过对话。

推荐同时开启 **API 模式** 与 **MCP 连接器**。API 模式负责每句话的自动记录与自动召回，MCP 让助手能够主动检索、写入和管理笔记。若只有 Claude 订阅而没有 API，可单独接入 MCP（使用 Claude Code 时配合仓库里的 Hook）。

想自己动手部署，照下面三步即可完成。

## 快速开始

### 1. 部署

先 Fork 本仓库再部署你的 Fork，以后同步更新只需点一下（见 [更新到最新版](#更新到最新版)）。

1. 点击本页右上角的 **Fork**。
2. 在 Cloudflare 控制台进入 **Workers & Pages → Create → Import a repository**，关联 GitHub 并选中你的 Fork。项目名保持 `companion-memory-proxy`，构建命令填 `npm ci`，部署命令填 `npm run deploy`。部署脚本会自动创建 D1 数据库、Vectorize 索引与 Queue 并应用全部数据库迁移。
3. 部署完成后，打开 Worker 的 **Settings → Variables and Secrets**，新增一个类型为 **Secret** 的 `CHATBOX_API_KEY`，填入自编的高强度随机密码（例如 `openssl rand -base64 32` 生成的值）。这是唯一的必填密钥，其余可选密钥说明见 [SECRETS.md](SECRETS.md)。

部署完成后会得到类似下面的 Worker 地址。

```text
https://companion-memory-proxy.<你的子域>.workers.dev
```

部署请始终使用 `npm run deploy`。直接运行 `wrangler deploy` 会跳过资源初始化与迁移。

**一键部署按钮** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Aelios-project/Aelios)

按钮会在你的 GitHub 账号里新建一份独立仓库副本，没有 **Sync fork** 按钮，后续升级需手动拉取代码。若使用按钮部署，表单只需填 `CHATBOX_API_KEY`，Vectorize 保持 Dimensions `1024` 与 Metric `cosine`，构建命令 `npm ci`，部署命令 `npm run deploy`。已经通过按钮装好的部署可按 [用按钮装的怎么办](#用按钮装的怎么办) 切换到 Fork。

### 2. 加一个助手

在浏览器打开管理面板。

```text
https://<你的 Worker 地址>/admin
```

填入 Worker 地址与 `CHATBOX_API_KEY` 登录，进入 **设置**。

1. 在 **模型与上游** 中填入 32 位 Cloudflare 账号 ID（或自定义 OpenAI 兼容地址）。需要通过 Cloudflare AI Gateway 做完整聊天转发时，在 Worker Secrets 中添加 `CLOUDFLARE_API_TOKEN`。
2. 在 **助手** 中点击 **添加助手**，填写以下三项。

   | 字段 | 作用 | 示例 |
   | --- | --- | --- |
   | 名字（`slug`） | URL 中的路径段，小写英文 | `coder` |
   | 主模型 | 仅匹配到的模型触发召回和记录（支持 `*` 通配） | `anthropic/claude-opus-4-5`、`*deepseek*` |
   | 钥匙 | 允许哪些 Worker 密钥访问该助手 | 勾选主钥匙（`CHATBOX_API_KEY`） |

3. 点击 **保存**。

每位助手对应一个独立入口路径，名字为 `coder` 的助手地址如下。

```text
https://<你的 Worker 地址>/coder/v1
```

只有登记在主模型列表中的模型才会启用记忆，后台分类器或杂务小模型会自动静默透传。

使用 Claude Code、Codex、Cline、opencode 等编程代理时，Aelios 默认只记录人类对话语言，代码块记为 `[code]`，并跳过读文件、执行命令和改文件等工具步骤。如需完整记录，可在助手高级选项中关闭「写代码时只记说的话」。

### 3. 连接客户端

客户端 API Key 统一填 `CHATBOX_API_KEY`，模型名需携带厂商前缀（如 `anthropic/claude-opus-4-5` 或 `deepseek/deepseek-chat`）。

| 客户端 | 配置方式 |
| --- | --- |
| Chatbox、Cherry Studio 等 OpenAI 兼容软件 | 地址填 `https://<你的 Worker 地址>/coder/v1` |
| Claude Code | `ANTHROPIC_BASE_URL=https://<你的 Worker 地址>/coder` |
| Codex | `base_url = "https://<你的 Worker 地址>/coder/v1"` 并设置 `wire_api = "responses"` |

省略助手名直接请求 `/v1` 时，自动路由到该密钥有权使用的第一位助手。

发送一句「请记住，我的测试暗号是苹果星星-0428」，过一会儿在新对话里问「我的测试暗号是什么」，能答出即表示接入成功。

## 更新到最新版

GitHub Fork 不会自动同步上游新提交。

1. 在 GitHub 打开你的 Fork，点击 **Sync fork → Update branch**。
2. Cloudflare 检测到新提交后自动运行 `npm ci` 与 `npm run deploy`，应用新的 D1 迁移并完成上线。

所有记忆、设置、助手配置和密钥都保存在你的 Cloudflare 账号中。日常参数都在 `/admin` 修改，Fork 仓库保持干净即可一键同步。

### 用按钮装的怎么办

把按钮创建的副本切换到 Fork 不会影响已有数据和设置。

1. 在 GitHub 上 Fork `Aelios-project/Aelios`。
2. 如果当初用按钮部署时改过 D1 数据库或 Vectorize 索引名，先在 **Settings → Build → Build Variables and Secrets** 添加 `CMP_D1_NAME` 与 `CMP_VECTORIZE_NAME` 填回原名，让部署脚本复用旧资源。
3. 在 **Settings → Build** 点击 **Disconnect**，再点击 **Connect** 选择你的 Fork，构建命令 `npm ci`，部署命令 `npm run deploy`。
4. 如果 Cloudflare 自动向你的 Fork 提了对齐 Worker 名称的 PR，合并即可。

## 它如何工作

- **每轮自动召回** 每次人类发往主模型的对话，Aelios 并行检索 Vectorize（`memo-kb`）与 D1 全文索引，通过 Workers AI 重排模型（`@cf/baai/bge-reranker-base`）一次批量打分，并将高相关原文片段附加到本轮请求。热路径不调用生成式大模型。
- **白天整理（Daytime Dream）** 默认开启（`ROLLING_DREAM`）。白天对话每累积一段（默认 10 条或 8,000 字），先由 `@cf/cloudflare/clef-flash` 判断是否有值得留存的新信息或决定，再由 `DREAM_MODEL`（默认 `workers-ai/@cf/zai-org/glm-4.7-flash`）生成待审候选或明确决定。
- **夜间整理与 Clef 自动审核** 每日定时任务（`10 20 * * *` UTC）处理白天尚未覆盖的剩余对话（含 3 天回看补跑），由 Cloudflare 的 `@cf/cloudflare/clef` 决策模型审核待审候选（`CLEF_AUTO_REVIEW` 默认开启，支持在面板逐条撤回），随后生成每日日记、周记与月记并执行留存清理。
- **多空间读取** 每位助手写入一个 `namespace`，可通过 `readNamespaces` 最多同时召回 8 个空间（如读取历史归档库或共享知识库）。
- **溯源与数据留存** 原始聊天默认保留 7 天（`MESSAGES_RETENTION_DAYS`）。长期未改写、未召回、未再提及的记忆 180 天后标记过期（置顶、身份与人格记忆永不过期），再过 30 天硬删除。首页垃圾桶按钮默认只清理该条垃圾原话，按撤回模式删除时仅沿明确引用链移除相关衍生记忆。

完整的存储、Dream 调度、来源溯源与当前决定投影设计见 [docs/memory-lifecycle.md](docs/memory-lifecycle.md)。

## 日常管理（`/admin`）

打开 `/admin` 即可管理全部记忆空间。侧栏底部支持切换中文/English（默认跟随浏览器语言）以及浅色/深色主题。

| 页面 | 功能 |
| --- | --- |
| **首页** | 今日对话（点爱心收进珍贵，点垃圾桶删除报错、乱码或拒答行）、待处理提醒、昨晚整理摘要与最新一篇日记 |
| **待审** | 候选记忆队列。开启 Clef 自动审核后，判定结果列在 **本周自动处理** 中并支持一键撤回。关闭 Clef 后日常候选留待人工批或助手经 MCP 审核。外部导入候选始终停留在 **导入的** 分栏等待手动确认 |
| **日记** | 每日日记、每周汇总与每月汇总（约五周前的周记自动并入月记），原文仍在保留期内可点击 **用原文重写这篇** |
| **记忆库** | 按 **重要**、**珍贵**、**黑话**、**小本本**、**交接信**、**世界知识** 六栏浏览、搜索、编辑、合并与恢复修订历史 |
| **星图** | 在独立页面（`/admin/starmap`）展示 3D 记忆星图 |
| **夜间整理** | 查看白天整理积压与窗口状态、最近 7 晚运行记录、当晚收成，以及手动补跑某一晚 |
| **导入导出** | 导出备份（`md` 或 `jsonl`）、导入记忆清单、解析聊天记录抽候选，以及零模型调用的聊天原文归档 |
| **设置** | 常用开关、助手配置、模型与上游（含 ChatGPT 套餐与模型清单）、全部设置、密钥状态与排查工具（召回记录与向量维护） |

### 手动补跑某一天的 Dream

需要补跑漏掉的日期或立即整理某一天时，按以下步骤操作。

1. 打开 **夜间整理**，确认左上角 **正在查看** 选中了目标空间。
2. 在 **手动整理一晚** 中选择日期（或直接点击失败记录旁的 **重跑这一晚**），取消勾选 **只预览，不写入** 以执行真实写入。
3. 点击 **开始**。非预览任务会进入持久队列 `MEMORY_QUEUE` 后台执行，关闭浏览器不会中断。
4. 每次执行处理一批（`DREAM_MAX_MESSAGES`，默认 `40` 条），该日对话较多时多点几次直至完成。最后一批结束后自动写出当天日记。

若某次任务超过 20 分钟未确认完成，先检查 Worker 日志再点击 **核查后标记为已中断**，即可解锁新的手动任务。

### 导出、导入与聊天档案

**导入导出** 页面中的所有操作均针对当前选中的空间。

- **导出** 支持 `md` 与 `jsonl`。Markdown 每行一条记忆，包含日期、正文、`#标签` 与反引号键名，本地修改后原样导回会按 key 原地更新并保留历史版本。
- **导入整理好的条目** 支持 `- 2025-12-15 [偏好] 喜欢乌龙茶 #饮食`（日期、类型和标签均可省略）以及普通列表或段落。可选择直接入库（完全重复跳过，高度相似转入待审）或全部先进待审队列。
- **导入聊天记录** 在浏览器本地解析 ChatGPT 与 Claude 导出的 `conversations.json`、酒馆 `.jsonl` 以及「名字：内容」文本，按天分片交给 `DREAM_MODEL` 抽候选并写入待审页 **导入的** 分栏。仅保留被候选引用的原话，不受 7 天清理影响，中途关页下次选同一文件自动续传。
- **聊天档案** 选择 **仅归档原文，供关键词搜索** 时零模型调用按会话归档全文。在 **设置 → 数据留存** 打开 **自动归档新聊天**（`CHAT_ARCHIVE_ENABLED`）可自动归档后续新对话。MCP 客户端使用 `search_chat` 检索 2 至 120 字符原词或短语，并将命中 ID 传给 `search_chat` 的 `around` 参数即可查看同会话上下文。档案默认长期留存（`CHAT_ARCHIVE_RETENTION_DAYS`）。

## 接入方式与可选功能

### 完整 Cloudflare AI Gateway 与自定义模型清单

1. 在 Cloudflare 控制台 **AI → AI Gateway** 创建网关并存入各家厂商 API Key（BYOK）。
2. 在 Worker Secrets 中添加 `CLOUDFLARE_API_TOKEN`（权限建议勾选 `AI Gateway Run`、`AI Gateway Read`、`Workers AI Read`，维护工具另加 `Vectorize Read`）。
3. 在 `/admin` → **设置 → 模型与上游** 填入 32 位 Cloudflare 账号 ID 并添加助手。

未配置 AI Gateway 或 Cloudflare 令牌时，记忆召回、MCP 和 Workers AI 整理同样可以正常运行。

若想精简客户端里看到的模型列表，可在 **设置 → 模型与上游 → 模型清单 → 编辑** 中勾选常用模型、手填自定义 Provider 或动态路由名，并逐个测试连通性。保存后 `GET /v1/models` 按添加顺序返回这份清单，清单外的模型仍可按名称正常调用。

### 使用自己的 ChatGPT Plus / Pro 套餐

通过 OpenAI 的 Sign in with ChatGPT 直接使用个人套餐额度，无需额外 API Key。

1. 打开 `/admin` → **设置 → 模型与上游 → ChatGPT 套餐 → 管理 → Continue with ChatGPT** 完成登录授权。
2. 授权后浏览器跳转到无法打开的 `127.0.0.1` 地址，复制地址栏完整 URL 粘贴回 `/admin` 并点击 **完成登录**。
3. 模型名写成 `chatgpt/<模型名>`（点 **测试** 查看账号可用型号），在助手主模型中加入 `chatgpt/*` 即可启用记忆。

令牌使用由 `CHATBOX_API_KEY` 派生的密钥加密存储在 D1 中（更换 `CHATBOX_API_KEY` 后需重新登录）。Chat Completions、Anthropic Messages 与 Responses 客户端均可走这条线路，支持函数工具与联网搜索，托管工具（生图、文件搜索、代码解释器、远端 MCP）不受支持。`DREAM_MODEL` 与 `DIARY_MODEL` 也可填 `chatgpt/<模型名>`，用量计入套餐限额。GPT 模型的召回注入位置与提示词缓存细节见 [docs/memory-gateway.md](docs/memory-gateway.md)。

### 在 Claude 官方 App、Claude Code、Codex 里用 MCP 记忆

将支持远程 Streamable HTTP MCP 的客户端指向以下地址。

```text
https://<你的 Worker 地址>/mcp?token=<CHATBOX_API_KEY>
```

需要跨设备保存带 `?token=` 的地址时，建议使用权限受限的 `MEMORY_MCP_API_KEY`。

- **Claude 官方 App（网页与手机）** 在 `claude.ai/customize/connectors` 添加自定义连接器并填入上述地址，将只读工具组设为 **总是允许**。由于官方 App 不读取 MCP 服务器自带说明，请将以下提示语粘贴到个人偏好或项目说明中。

```text
我给你接了 Aelios 记忆连接器，那是你对我的长期记忆。每个新对话先调 wake_up 再回我；我提到以前的人和事，或者你要猜我的事之前，先 recall；我说了新的事、改了主意、许了约定，当场 remember；聊得差不多了调 log_conversation。
```

- **不经过网关的客户端** 官方 App 的对话不经过 Aelios 网关，需要助手调用 `log_conversation` 提交对话以便白天/夜间整理和写日记。已走网关的客户端自动记录，无需调用 `log_conversation`。
- **工具集合** 默认暴露 12 个常用工具，在地址末尾加上 `&tools=all` 可额外启用 `memory_get` 与 `memory_export`。

### 作为 magpie 插件使用

代理流量已走 [magpie](https://github.com/yetone/magpie) 网关时，可通过 `GET /v1/hook/identities`、`POST /v1/hook/recall` 与 `POST /v1/hook/record` 在不改动上游的前提下接入记忆，接口契约见 [docs/memory-gateway.md](docs/memory-gateway.md#hook-接口magpie-插件用)。

### 仅 Claude 订阅的 Claude Code Hook

只有 Claude 订阅而无法走 API 模式时，可安装仓库自带的零依赖 Python Hook，为 Claude Code 提供每条消息自动召回与批量写回，详见 [integrations/claude-code/README.md](integrations/claude-code/README.md)。

### 看图转发（导盲犬）

添加 Worker Secret `GUIDE_DOG_API_KEY` 后，客户端可将看图请求发往 `https://<你的 Worker 地址>/v1/guide-dog/chat/completions`（或 Base URL `https://<你的 Worker 地址>/v1/guide-dog`，模型名 `companion`）。导盲犬仅负责转述图片，不写记忆。

### 住在 Cloudflare 里的伴侣（`Aelios-resident`）

[Aelios-resident](https://github.com/Aelios-project/Aelios-resident) 是运行在 Cloudflare Workers 免费档上的独立 Durable Object 伴侣，将 Telegram 与网页聊天合为同一对话线程。在其设置页填入本 Aelios 的地址、密钥和助手名，即可共享长期记忆、交接信、联网搜索与定时问候。

## 常见注意点与 Workers 免费档提示

- **部署命令** 始终运行 `npm run deploy`，确保 D1、Vectorize、Queue 与迁移同步就绪。
- **Workers 免费档额度** 白天整理（`ROLLING_DREAM`，默认开）与夜间整理共用 Workers AI 每日 10,000 neurons 额度。免费档用户可在 `/admin` 设置中关闭 **白天整理**，把抽取统一留在夜间执行。
- **模型命名** 必须带厂商前缀（如 `anthropic/claude-opus-4-5`、`deepseek/deepseek-chat`），仅将主力聊天模型登记进助手主模型列表，避免把杂务小模型混入记忆。
- **助手名字** 会作为 URL 路径段，使用不含空格的小写英文。
- **Vectorize 索引** 保持 `memo-kb`（1024 维余弦）不被手动删除。
- **手动 Dream 预览选项** 夜间整理页默认勾选 **只预览，不写入**，实际补跑前先取消勾选。

## 文档索引

- AI 自动安装与配置指南 [docs/setup-with-ai.md](docs/setup-with-ai.md)
- 网关架构、上游路由、GPT 缓存与 magpie Hook 契约 [docs/memory-gateway.md](docs/memory-gateway.md)
- 记忆存储、召回、白天与夜间整理、溯源与留存机制 [docs/memory-lifecycle.md](docs/memory-lifecycle.md)
- 请求净化、结构校验与 Anthropic thinking 策略矩阵 [docs/request-contract.md](docs/request-contract.md)
- Secrets 与环境变量管理及旧 Fork 轮换指南 [SECRETS.md](SECRETS.md)
- 安全策略与漏洞披露 [SECURITY.md](SECURITY.md)

---

# 给维护的人

## Cloudflare 资源清单

| 资源 | 默认值 |
| --- | --- |
| Worker | `companion-memory-proxy` |
| D1 数据库 | `companion_memory_proxy` |
| Vectorize 索引 | `memo-kb`（1024 维余弦） |
| Queue | `companion-memory`（`max_batch_size = 1`） |
| Embedding 模型 | `workers-ai/@cf/baai/bge-m3` |
| Reranker 模型 | `@cf/baai/bge-reranker-base` |
| 默认 Dream / 日记模型 | `workers-ai/@cf/zai-org/glm-4.7-flash` |
| 筛选 / 审核模型 | `@cf/cloudflare/clef-flash` / `@cf/cloudflare/clef` |

协助他人部署时只关联用户自己的 Fork，所有 Secret 均保留在用户自己的 Cloudflare 账号内。

## 端点一览

除 `/health` 与 `/admin` 外，全部接口均需 `Authorization: Bearer <key>`（`/mcp` 同时支持 `?token=`）。网关接口按助手钥匙列表鉴权，记忆接口按 `memory:read` / `memory:write` scope 鉴权。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查与绑定状态 |
| `GET` | `/admin`、`/admin/starmap` | 管理面板与 3D 记忆星图 |
| `GET` | `/v1/models` | 上游模型目录或已保存的 `modelList` |
| `POST` | `/<slug>/v1/chat/completions`、`/messages`、`/responses` | 记忆网关三协议入口（`/v1/...` 走该钥匙第一位助手） |
| `GET` / `PATCH` | `/api/gateway/config`、`/env`、`/spaces`、`/recalls` | 主人配置、默认值、空间列表与召回排查日志 |
| `GET` / `POST` | `/api/gateway/models`、`/models/test`、`/chatgpt/*` | 模型目录、单模型连通测试与 ChatGPT 套餐登录 |
| `GET` / `POST` | `/v1/hook/identities`、`/recall`、`/record` | 外部网关 Hook 接口（magpie 插件） |
| `GET` / `POST` | `/mcp` | Streamable HTTP MCP 服务 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/v1/memories`、`/v1/memories/:id`、`/revisions`、`/export` | 记忆读写、修订历史与 `md`/`jsonl` 导出 |
| `POST` | `/v1/memory/recall`、`/v1/search/memories`、`/v1/ingest/messages` | 动态召回、不记账搜索与对话写入 |
| `DELETE` | `/v1/raw/:id` | 删除原始对话行（默认 `?mode=clean`，`?mode=withdraw` 同步撤回引用该行的衍生记忆） |
| `GET` | `/v1/memory_boot` | 冷启动包（不含当前交接信） |
| `GET` / `PUT` / `DELETE` | `/v1/handoff` | 当前交接信，写删需携带 `expected_revision` 乐观锁 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/v1/notebook`、`/v1/notebook/:id` | 命名小本本页面（`DELETE ?confirm=all` 清空当前空间） |
| `GET` / `POST` / `DELETE` | `/v1/precious`、`/v1/glossary` | 珍贵原话与共享黑话 |
| `GET` / `POST` | `/v1/diary`、`/v1/diary/recent`、`/admin/diary-rewrite` | 日记读取与按原文重写单日日记 |
| `GET` / `POST` | `/v1/dream/status`、`/run`、`/resolve`、`/admin/dream/harvest` | Dream 状态、同步或后台手动执行、卡死任务收尾与单晚收成 |
| `GET` / `POST` | `/v1/candidates`、`/decisions`、`/:id/undo`、`/:id/sources` | 待审队列、Clef 自动判定记录、撤回与引用原话 |
| `GET` / `POST` | `/v1/import/*` | 导入接口（`info`、`entries/preview`、`entries`、`batches`、`chat/chunk`、`candidates`） |

## MCP 工具

- **默认 12 个工具** `wake_up`、`recall`、`remember`、`keep_moment`、`forget`、`learn_word`、`read_diary`、`search_chat`、`log_conversation`、`list_memories`、`handoff`、`notebook`
- **关闭 `CLEF_AUTO_REVIEW` 时** 额外列出 `memory_candidates` 与 `memory_review`
- **带 `&tools=all` 参数时** 额外列出 `memory_get` 与 `memory_export`
- **旧工具别名** `memory_boot`、`memory_recall`、`memory_search`、`memory_upsert`、`memory_supersede`、`memory_archive`、`memory_delete`、`memory_ingest`、`memory_pin`、`glossary_set`、`diary_get` 与 `memory_list` 仍可调用以兼容旧脚本，不再出现在默认列表里

## Dream 模型与输出预算

白天整理、夜间抽取、周记汇总与聊天导入默认使用 `DREAM_MODEL`（默认 `workers-ai/@cf/zai-org/glm-4.7-flash`），日记和月记可通过 `DIARY_MODEL` 单独指定。输出长度上限由 `DREAM_MAX_TOKENS` 控制（1 至 65,536）。在 `/admin` 设置中留空任意文本项都会沿用字段旁显示的生效默认值。仓库模板 `wrangler.toml` 将 `DREAM_MAX_TOKENS` 设为 `8000`。若部署层和面板均未提供新旧配置值，Workers AI 默认使用 `8000`，其他网关沿用上游默认上限。`chatgpt/...` 套餐线路始终使用上游自身上限。

## 本地验证

测试依赖 Node.js 22+。

```bash
npm ci
npm run verify
npm run lint
```

`npm run verify` 执行 TypeScript 类型检查、全量单元测试以及 5 项校验脚本（包含对本地临时 D1 逐条应用 `migrations/` 中的全部迁移）。CI 要求 `npm run lint` 零 error，既有的 `noNonNullAssertion` warning 不阻断合并，切勿使用 Biome 自动修复批量将 `x!.y` 改写为 `x?.y`。

## License

AGPL-3.0。你可以自由使用和修改源码，若对外提供基于修改版的网络服务，须按同一许可开源修改后的代码。v1 最终版本封存在 tag `v1-final`（当时为 MIT 许可）。

## 交流

QQ 群 `1091783659`
