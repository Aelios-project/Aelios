# 让 AI 帮你装好、配好 Aelios

这份说明是写给 AI 看的。你用 Claude Code、Codex、Cursor 这类能跑命令的 AI，把下面这段话发给它就行：

```text
帮我装好、配好 Aelios（我的 AI 记忆网关）。先读 https://raw.githubusercontent.com/Aelios-project/Aelios/main/docs/setup-with-ai.md ，照着做。需要我在浏览器里点、或者需要我自己填 key 的时候，停下来告诉我去哪儿填。
```

从零开始也行，已经装过的也行。配完你会拿到三样东西，填进你平时用的聊天软件就能用：

- **地址**（Base URL）
- **API Key**
- **模型名**

从此聊天经过 Aelios，每句话自动记、下次自动想起来，不用装任何上传、召回的脚本。

你要准备的：一个 Cloudflare 账号（免费，没有的话 AI 会让你先注册），一个模型的 key（比如 DeepSeek 的）。

你自己要动手的只有这几件：在浏览器里点「允许」，让 AI 登录 Cloudflare（新装要点两次，一次部署、一次配网关；装过的点一次）；把模型的 key 存进 Cloudflare 后台，key 不经过 AI。其余的，包括部署、生成 Cloudflare 的令牌、配助手、导入以前的记忆，都交给 AI。

---

## 给 AI：先守这几条

- 用用户的语言跟用户说话。每一步先用一句话说你要做什么。
- **别让用户把凭证贴进对话**：模型厂商的 key、Cloudflare API Token、GitHub Token 都不行。厂商的 key 由用户自己存进 Cloudflare 后台（第 4 步）。唯一的例外是 Aelios 自己的访问钥匙 `CHATBOX_API_KEY`：它本来就要填进用户的客户端，用户愿意给你就收。
- **你生成的 Cloudflare 令牌别打印、别写进文件**，用管道直接存进 Worker（第 5 步的命令就是这么写的）。
- **没经用户同意，别删、别换已有的东西**：AI Gateway、厂商 key、Worker 的 Secret、已配好的助手、D1 数据库、Vectorize 索引都不行。记忆就存在里面。
- 部署只用 `npm run deploy`。这个仓库是 wrangler 项目，**别跑 `cf deploy`、`cf dev`、`cf build`、`cf migrate`**。`cf` 只拿来配账号里的东西：AI Gateway、令牌、Worker 的 Secret。
- 卡住了别换着法子硬试。把报错原文和你的判断告诉用户，问下一步。

## 0. 先问用户

1. **以前装过 Aelios 吗？**
   - 没装过：从第 1 步往下全做。
   - 装过：要 Worker 地址（形如 `https://companion-memory-proxy.<子域>.workers.dev`），跑一下 `curl -s <Worker 地址>/health`，看到 `"ok": true` 就跳过第 2 步（部署）。
2. **有 Cloudflare 账号吗？** 没有就请用户先去 <https://dash.cloudflare.com/sign-up> 注册，免费的就够。有 GitHub 账号更好，用来 fork，以后更新点一下就行；没有也能装。
3. **模型从哪儿来？** 按回答选路线：

   | 用户有什么 | 走哪条 |
   |---|---|
   | 某家的 API key：DeepSeek、OpenAI、Gemini、OpenRouter、Anthropic 等，包括在网站上用账号登录（OAuth）换来的 key | **API 模式**，key 存在 Cloudflare AI Gateway 里（BYOK）。全做 |
   | 一个中转站给的地址和 key，或者 AI Gateway 的下拉列表里没有的厂商 | **API 模式**，同样走 AI Gateway：先建一个自定义 provider，key 照样存在它下面。第 4 步多做「自定义 provider」那段 |
   | 只有 Claude 订阅（Pro、Max），没有 API | 订阅变不成 API。只能走 **MCP 连接器**，用 Claude Code 的话再加仓库里的 Hook（`integrations/claude-code/`）。做完第 3 步直接跳到第 8 步的 MCP 部分 |

   告诉用户：**API 模式加 MCP 连接器是满血用法**。API 模式每句话自动记、自动召回；MCP 让助手能主动查、主动记、自己审记忆。只用 MCP 加 Hook 是权宜之计。

4. **在哪个软件里聊？** Chatbox、Cherry Studio、自己的 agent、Claude Code、Codex……决定第 7、8 步怎么填。
5. **你的 AI 叫什么名字？用户希望被怎么称呼？** 地址里那一段就用 AI 的名字，转成小写拼音或英文（比如叫阿遥就写 `ayao`），下面的命令里写作 `<名字>`。原名填 `assistantName`、用户的称呼填 `userName`，夜里写日记就这么叫他们。
6. **有没有以前的记忆、聊天记录要搬过来？** 有的话配完做「导入以前的记忆和聊天记录」。

## 1. 准备工具，登录 Cloudflare 命令行

```bash
node -v          # 要 22 或更高
git --version
gh auth status   # 有 gh 就用它 fork，没有也行
npm install --global cf
cf auth whoami
```

`cf` 没登录就跑下面这条。先告诉用户：会给一个网址和一串码，在浏览器里打开网址、确认那串码、点允许。

```bash
cf auth login
```

你跑在远程机器、容器或云端沙盒里的话，加 `--no-browser`，把打印出来的网址交给用户。

`whoami` 里有账号 ID（32 位），后面建令牌、配上游都要用。列出不止一个账号时，问用户用哪个，之后每条 `cf`、`wrangler` 命令前面都带上 `CLOUDFLARE_ACCOUNT_ID=<那个 ID>`。账号 ID 不是密钥，但也别写进仓库里的文件。

下面的命令默认 Worker 叫 `companion-memory-proxy`。用户改过名就换成他的。

## 2. 部署（没装过才做）

```bash
gh repo fork Aelios-project/Aelios --clone --default-branch-only
cd Aelios
npm ci
```

没有 gh：请用户打开 <https://github.com/Aelios-project/Aelios> 点右上角 **Fork**，把 fork 的地址告诉你，你再 `git clone` 那个地址、`npm ci`。用户没有 GitHub 账号就直接 `git clone https://github.com/Aelios-project/Aelios`，只是以后更新要手动拉。

部署用 wrangler，它的登录跟 `cf` 是分开的，要用户再点一次允许：

```bash
npx wrangler whoami
npx wrangler login   # 远程机器、容器、云端沙盒里用：npx wrangler@latest login --device
npm run deploy
```

`npm run deploy` 会建 D1 数据库 `companion_memory_proxy` 并跑完迁移，建 Vectorize 索引 `memo-kb`（1024 维、cosine）、队列 `companion-memory`，最后部署 Worker。同名的已经有了就直接用，不会重建。输出最后的 `https://companion-memory-proxy.<子域>.workers.dev` 就是 Worker 地址，记下来。

常见卡点：

- **账号没有 workers.dev 子域**：请用户在后台打开一次 **Workers & Pages**，按提示选一个子域，再重跑 `npm run deploy`。
- **Vectorize 索引维度不对、里面有数据**：脚本会停下，不会自己删。把原文给用户看，让用户决定。
- **多个账号选不出来**：命令前带 `CLOUDFLARE_ACCOUNT_ID=<账号 ID>`。

部署完，部署脚本把数据库 ID 和账号 ID 写进了 `wrangler.toml`，那只是这次部署用的，别提交：

```bash
git checkout -- wrangler.toml
```

再跑 `curl -s <Worker 地址>/health`。新子域头一两分钟可能报 404 或 523，等一会儿再试。这时候还没设钥匙，`ok` 是 `false`，下一步就设。

## 3. Aelios 的钥匙 `CHATBOX_API_KEY`

这是用户自己的 Aelios 密码，客户端、MCP 连接器、`/admin` 管理页都用它。

**新装的**，生成一把直接存进 Worker：

```bash
KEY="sk-aelios-$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))")" \
  && cf workers secrets update CHATBOX_API_KEY --worker companion-memory-proxy --type secret_text --text "$KEY" >/dev/null \
  && echo "$KEY"
```

把钥匙告诉用户，请用户存进密码管理器。别写进任何文件。

**装过的**，请用户给钥匙（就是 MCP 连接器地址里 `token=` 后面那串），先验一下：

```bash
curl -s <Worker 地址>/api/gateway/config -H "Authorization: Bearer <钥匙>"
```

返回 JSON（带 `"version":3`）就对了，把它留着，第 6 步要用；返回 401 就是钥匙不对。用户忘了钥匙：先说清楚，重设以后所有已经在用这把钥匙的地方都要改，包括 MCP 连接器地址和别的客户端；用户同意了，再跑上面新装的那条。

## 4. 用户自己存厂商的 key（BYOK）

### 先准备网关

AI Gateway 叫 `default`。先看有没有：

```bash
cf ai-gateway gateways get default
```

没有就建一个。BYOK 要求网关开着认证：

```bash
cf ai-gateway gateways create --id default --authentication true \
  --cache-invalidate-on-update true --cache-ttl 0 --collect-logs true \
  --rate-limiting-interval 0 --rate-limiting-limit 0
```

已经有了但 `authentication` 是 `false` 的：问用户能不能打开，同意了用 `cf ai-gateway gateways update default` 改。这条会整份覆盖网关设置，所以把 `get` 回来的其它字段原样带上，只把 `--authentication` 改成 `true`。

### 让用户存 key

中转站、下拉列表里没有的厂商，先跳到下面「自定义 provider」那段。

这一步用户在 Cloudflare 后台自己点，你别碰 key。把这个链接给用户：<https://dash.cloudflare.com/?to=/:account/ai/ai-gateway>，告诉用户：进 `default` → **Provider Keys** → **Add API Key**，选厂商、粘贴 key，别名填 `default`，保存。

用户说存好了，你确认一下（只看有没有，看不到 key 本身）：

```bash
cf ai-gateway gateways providers list --gateway-id default
```

### 中转站，或者下拉列表里没有的厂商：自定义 provider

AI Gateway 可以自定义 provider，中转站和没内置的厂商都这样接，照样存 key、照样有日志。

1. **建自定义 provider**（这一步没有秘密，你来做）。先问用户那家的 OpenAI 兼容地址。`base_url` 填 `/v1` 前面那一段，末尾的斜杠留着：比如 Kimi Coding 的接口是 `https://api.kimi.ai/coding/v1/chat/completions`，`base_url` 就填 `https://api.kimi.ai/coding/`。AI Gateway 会自己在后面接 `v1/chat/completions`。`slug` 用小写英文和连字符，比如 `kimi`：

   ```bash
   cf ai-gateway custom-providers create --name <显示名> --slug <slug> --base-url https://api.kimi.ai/coding/ --enable true
   ```

   `--enable true` 一定要带，不带建出来是停用的。

2. **用户存 key**：后台 `default` → **Provider Keys** → **Add API Key**，下拉里选刚建的这个 provider，别名填 `default`。

3. 模型名一律写成 `custom-<slug>/<那家的模型名>`，比如 `custom-kimi/kimi-for-coding`。

然后照常做第 5 步。

整个网关只有一个上游（第 6 步的 `upstream`），内置厂商和自定义 provider 都挂在同一个 AI Gateway 下面，可以混着用。

## 5. 生成 Cloudflare 令牌，存进 Worker

Aelios 要一把 Cloudflare 令牌去调 AI Gateway。这把由你生成，生成后直接存进 Worker，全程不显示。

先看 Worker 里是不是已经有了：

```bash
cf workers secrets list --worker companion-memory-proxy
```

已经有 `CLOUDFLARE_API_TOKEN` 的，问用户要不要换新的，不换就跳过这一步。

查这几个权限组的 ID（`--name` 的值要 URL 编码，空格写成 `%20`）：

```bash
cf accounts tokens permission-groups list --name "AI%20Gateway%20Run"
cf accounts tokens permission-groups list --name "AI%20Gateway%20Read"
cf accounts tokens permission-groups list --name "Workers%20AI%20Read"
cf accounts tokens permission-groups list --name "Vectorize%20Read"
```

前三个是聊天转发要的：Claude 走 Cloudflare 的 AI REST API（`api.cloudflare.com/…/ai/v1/messages`），那里要 `Workers AI Read`；其余线路要 `AI Gateway Run`。`Vectorize Read` 给维护工具按 Vectorize 列记忆用，找不到可以不加。把 ID 写进一个临时的策略文件（这里面没有秘密）：

```json
[{
  "effect": "allow",
  "resources": { "com.cloudflare.api.account.<账号 ID>": "*" },
  "permission_groups": [ { "id": "<AI Gateway Run 的 ID>" }, { "id": "<AI Gateway Read 的 ID>" }, { "id": "<Workers AI Read 的 ID>" }, { "id": "<Vectorize Read 的 ID>" } ]
}]
```

存成 `/tmp/aelios-policy.json`，然后一条命令生成并存进 Worker。令牌只在管道里过一下，不打印：

```bash
V=$(cf accounts tokens create --name aelios-gateway --policies @/tmp/aelios-policy.json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.error("返回的不是 JSON");process.exit(1)}const r=j.result||j;if(!r.value){console.error("没拿到令牌，返回的字段：",Object.keys(r).join(", "));process.exit(1)}process.stdout.write(r.value)})') \
  && cf workers secrets update CLOUDFLARE_API_TOKEN --worker companion-memory-proxy --type secret_text --text "$V" >/dev/null \
  && echo 已存; unset V; rm -f /tmp/aelios-policy.json
```

建令牌被拒（比如登录的账号没有建令牌的权限）：别反复试。让用户在后台建一把，再自己填进 Worker：**My Profile → API Tokens → Create Token → Custom token**，权限加上面三个（`AI Gateway Run`、`AI Gateway Read`、`Workers AI Read`，账户选这个账号）。AI Gateway 设置页里「Authenticated Gateway」建的那种只有 `AI Gateway Run`，也能用，只是 Claude 每次都得退回旧接口。然后 **Workers & Pages** → `companion-memory-proxy` → **Settings → Variables and Secrets** → **Add**，类型选 **Secret**，名字 `CLOUDFLARE_API_TOKEN`，值是那把令牌。

## 6. 配助手

装过的，先看现在的记忆存在哪个空间（新装的跳过，用 `default`）：

```bash
curl -s <Worker 地址>/api/gateway/spaces -H "Authorization: Bearer <钥匙>"
```

新助手的 `namespace` 填记忆最多的那个，一般是 `default`。MCP 连接器写的也是 `default`，这样 API 和 MCP 用的是同一份记忆。

**主模型用通配符，别写死。** `models` 里可以用 `*`，不分大小写，对上完整名字或最后一个 `/` 后面那段都算。比如 `*deepseek*` 管住 DeepSeek 所有型号，`*kimi*` 管住 Kimi，用户以后换型号不用回来改。只有对得上的模型会记、会召回；别写成单独一个 `*`，那样 Claude Code 后台的小模型调用也会被记进去。

**交给用户的模型名才要具体**（第 8 步用）：内置厂商写成 `厂商/模型`，比如 `deepseek/deepseek-chat`、`openai/gpt-5`、`google-ai-studio/gemini-2.5-pro`；自定义 provider 写成 `custom-<slug>/<模型名>`，比如 `custom-kimi/kimi-for-coding`。拿不准就让用户在厂商文档里确认。

然后 PATCH。**`identities` 是整份替换的**：第 3 步拿到的配置里已经有助手的，把它们原样放进列表，再加新的这个。

```bash
curl -sS -X PATCH <Worker 地址>/api/gateway/config \
  -H "Authorization: Bearer <钥匙>" -H "Content-Type: application/json" \
  -d '{
    "upstream": { "address": "<账号 ID>" },
    "identities": [
      { "slug": "ayao", "namespace": "default", "keys": ["CHATBOX_API_KEY"],
        "models": ["*deepseek*"],
        "userName": "<用户的称呼>", "assistantName": "阿遥" }
    ]
  }'
```

- 用户没给称呼，就把 `userName`、`assistantName` 整项删掉。
- `upstream` 已经是对的就整项不写；写了会覆盖。

## 7. 试一句

```bash
curl -sS <Worker 地址>/<名字>/v1/chat/completions \
  -H "Authorization: Bearer <钥匙>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-chat","messages":[{"role":"user","content":"你好，回我一个字就行"}]}'
```

有回复就通了。常见报错：

- 提到 **Unified billing**：Cloudflare 没找到用户存的 key，在用它自己的计费。多半是 key 存错了厂商、别名不是 `default`，或者模型名前缀和厂商对不上。
- **401、403**：令牌权限不够，或者网关认证没开。回第 4、5 步看。
- **Unknown gateway provider**：前缀写错了。自定义 provider 要写 `custom-<slug>/`，并且建的时候带了 `--enable true`。
- **404**：多半是自定义 provider 的 `base_url` 多写了 `/v1`（AI Gateway 会自己接），或者少了那家地址里的一段路径。
- **Upstream not configured**：第 6 步的 `upstream` 没填上。

Claude Code 走 `/<名字>/v1/messages`，Codex 走 `/<名字>/v1/responses`。这两条是转到厂商的原生接口，不是每家都有：`anthropic/` 的模型能走 messages，`openai/` 的能走 responses，别家多半只有上面那条 chat。用户要在这两个软件里用，先用 curl 试对应的路径，通了再改配置。

## 8. 交给用户

最后用一小块话交给用户，照这个样子：

```text
地址（Base URL）：<Worker 地址>/<名字>/v1
API Key：<钥匙>
模型：deepseek/deepseek-chat
```

再补几句：

- 模型名要一字不差，前缀也要。软件里拉模型列表的话，挑这个名字。
- 有的软件会自己在地址后面补 `/v1`，那就只填到 `/<名字>`。
- Claude Code：`ANTHROPIC_BASE_URL=<Worker 地址>/<名字>`，`ANTHROPIC_AUTH_TOKEN=<钥匙>`。
- Codex：`base_url = "<Worker 地址>/<名字>/v1"`，并设 `wire_api = "responses"`。
- 管理页在 `<Worker 地址>/admin`，填 Worker 地址和钥匙进去，能看记忆、改设置。
- 改用户的客户端配置文件前先问。别改你自己正在用的那份，改了你会断线。

**再接上 MCP 连接器，就是满血。** 连接器地址：

```text
<Worker 地址>/mcp?token=<钥匙>
```

- Claude 官方 App（网页、手机）：请用户打开 claude.ai/customize/connectors，添加自定义连接器，填上面的地址。工具权限里把只读那一组设成「总是允许」。再把 README「在 Claude 官方 App……里用 MCP 记忆」那段提示语贴进个人偏好，不然它不会主动用。
- Claude Code：征得同意后跑 `claude mcp add --transport http aelios "<Worker 地址>/mcp?token=<钥匙>"`。
- Codex：征得同意后跑 `codex mcp add aelios --url "<Worker 地址>/mcp?token=<钥匙>"`。
- 别的软件：支持远程 MCP（Streamable HTTP）的，填同一个地址。

让用户试：「请记住：我的测试暗号是苹果星星-0428。」过一会儿换个新对话问「我的测试暗号是什么？」，答出来就全通了。

## 9. 以后点一下就更新（新装推荐）

第 2 步是从这台机器部署的。让 Cloudflare 改从用户的 fork 构建，以后在 GitHub 上点 **Sync fork** 就自动更新。这一步只能用户在后台点：

1. **Workers & Pages** → `companion-memory-proxy` → **Settings → Build** → **Connect**。
2. 选 GitHub 上的 fork。第一次会让装 Cloudflare 的 GitHub App，照提示装。
3. 构建命令 `npm ci`，部署命令 `npm run deploy`，保存。

连好以后，有 gh 的话可以替用户同步：`gh repo sync <用户的 fork>`。不连也能用，只是以后更新要 `git pull` 再 `npm run deploy`。

## 导入以前的记忆和聊天记录

整理好的条目直接写进库；聊天记录要先让模型从原话里抽候选，抽出来的进待审页「导入的」那一栏，用户在 `<Worker 地址>/admin` 里点了才算数。先看导入设置，里面有限额、抽取模型和给旧 AI 的提示词：

```bash
curl -s "<Worker 地址>/v1/import/info?namespace=default" -H "Authorization: Bearer <钥匙>"
```

`namespace` 用第 6 步那个。

### 整理好的记忆条目

格式是一行一条，日期、类型、标签都能省：

```text
- 2025-12-15 [偏好] 不吃香菜 #饮食
```

1. **拿到条目。** 用户手上有导出文件（md、jsonl、json）就直接用。记忆在别的 AI 那里的，把 `info` 返回的 `data.prompt` 给用户，让用户贴给那个 AI，把它的回答存成一个文件交给你。
2. **预览，不写库：**

   ```bash
   curl -sS -X POST <Worker 地址>/v1/import/entries/preview \
     -H "Authorization: Bearer <钥匙>" -H "Content-Type: application/json" \
     --data-binary @<(node -e 'process.stdout.write(JSON.stringify({text:require("fs").readFileSync(process.argv[1],"utf8")}))' <文件>)
   ```

   把条数、各类型多少、`warnings` 和几条例子给用户看，用户点头再写。
3. **写入：** 把预览返回的 `data.entries` 每 25 条一批 POST 到 `/v1/import/entries`：

   ```json
   {
     "namespace": "default",
     "fingerprint": "<整个文件的 sha256>",
     "name": "<文件名>",
     "mode": "direct",
     "start_index": 0,
     "total": 120,
     "entries": [ "...这一批的 25 条，原样用预览返回的对象..." ]
   }
   ```

   - `"direct"` 直接写进库：跟库里一字不差的跳过，跟库里某条很像的不硬写、转去待审页「导入的」等用户定，其余新建；带 `factKey` 的按 key 改写，旧版留着。用户说想一条条过目，才改成 `"review"`，全部先进审核。
   - 写完把返回的 `counts` 告诉用户：新建 `created`、改写 `updated`、跳过 `unchanged` 和 `duplicate`、转审核 `queued`、失败 `failed`。有 `queued` 的，请用户去 `/admin` → **待审** → **导入的** 看一眼。
   - 每批 `start_index` 加 25，`fingerprint`、`total` 不变。中途断了，用同一个 `fingerprint` 从断的地方接着发。

### 聊天记录

聊天记录会一天天交给夜里整理记忆的那个模型（`DREAM_MODEL`）读，抽出候选记忆。要花 Workers AI 的用量，量大时先导两三天的看看效果，再全导。

**最省事：让用户在网页上导。** `<Worker 地址>/admin` → **导入导出** → **导入聊天记录**，选文件就行，页面会拆、会切段、显示进度，关了下次选同一个文件接着做。它认：

- ChatGPT、Claude 导出的 `conversations.json`
- 酒馆（SillyTavern）的 `.jsonl`
- 通用 JSON / JSONL：消息数组，每条有 `role`（或 `sender`、`author`）和 `content`（或 `text`）
- 纯文本：「名字：内容」一行一句，「[2025-12-15 23:01] 名字: 内容」，日期单独一行当小标题，QQ、微信那种「时间 名字」一行、正文下一行

别的格式：你把它转成上面的通用 JSONL，每行一条 `{"role":"user","content":"……","time":"2025-12-15T23:01:00+08:00"}`（助手说的 `role` 是 `assistant`），交给用户在网页上导。

**用户要你直接导的话**，用接口：

1. 开一批（同一份文件用同一个 `fingerprint`，就能接着上次做）：

   ```json
   POST /v1/import/batches
   { "namespace": "default", "fingerprint": "<文件的 sha256>", "name": "<文件名>",
     "total_chunks": 42, "total_messages": 2300, "first_date": "2025-06-01", "last_date": "2025-12-31" }
   ```

   返回里的 `data.batch.id` 是这批的 ID，`data.done_keys` 是已经做完的段，跳过它们。
2. 按天切段，一段一段发。一段默认最多 60 条、3 万字，硬上限 80 条、4 万字；一天太多就切成几段：

   ```json
   POST /v1/import/chat/chunk
   { "namespace": "default", "import_id": "<批 ID>",
     "chunk": { "key": "2025-12-15#0", "day": "2025-12-15",
       "messages": [ { "seq": 0, "role": "user", "content": "……", "time": "2025-12-15T23:01:00+08:00", "speaker": "<说话人>" } ] } }
   ```

   `key` 每段不同、不超过 64 个字符；`seq` 在一段里不重复。一段一段串着发，别并发。
3. 做完告诉用户去 `/admin` → **待审** → **导入的** 里挑。

## 附：其它

- **不想用命令行部署的用户**：也可以照 README「1. 部署」在 Cloudflare 后台点着装，装好再从第 1 步往下（跳过第 2 步）。
- **查日志**：`npx wrangler tail companion-memory-proxy`。
- **别的设置**（召回条数、夜间整理用的模型等）：在 `<Worker 地址>/admin` 的「设置」里改，或者用同一个 `PATCH /api/gateway/config` 改 `settings`（按项合并，不是整份替换）。
