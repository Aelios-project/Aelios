# Secrets 与环境变量部署说明

本文说明如何区分 Cloudflare Worker 的 Secret 与 Variable、新部署时的密钥配置步骤，以及早期 fork 在 PR #9 之前部署过的密钥轮换与历史清理流程。

## 1. Secret 与 Variable 分类

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中，**Variable** 以明文保存，可能会被写入受 git 跟踪的 `wrangler.toml`。**Secret** 仅加密保存在 Cloudflare 服务端，永不写入仓库文件。

| 名称 | 类型 | 必填 | 用途 |
| --- | --- | --- | --- |
| `CHATBOX_API_KEY` | **Secret** | 必填 | 主访问密钥，用于客户端、管理面板 `/admin`、网关配置与 MCP |
| `CLOUDFLARE_API_TOKEN` | **Secret** | 可选 | Cloudflare 令牌，用于聊天网关转发（AI Gateway BYOK 与 AI REST API）、模型目录、Workers AI 转发及 Vectorize 维护工具 |
| `MEMORY_MCP_API_KEY` | **Secret** | 可选 | 独立的 MCP 与记忆接口密钥，不能修改网关设置 |
| `IM_API_KEY` | **Secret** | 可选 | 第二把客户端访问密钥，适合给 IM bot 或独立客户端使用 |
| `DEBUG_API_KEY` | **Secret** | 可选 | 维护与跨空间操作密钥 |
| `GUIDE_DOG_API_KEY` | **Secret** | 可选 | `/v1/guide-dog` 看图端点访问密钥 |
| `CF_AIG_TOKEN` | **Secret** | 可选 | AI Gateway 认证令牌，仅在无 `AI` 绑定且通过 `AI_GATEWAY_BASE_URL` 访问开启了 Authenticated Gateway 的网关时需要 |
| `GITHUB_DAILY_TOKEN` | **Secret** | 可选 | GitHub 日档拉取的只读 fine-grained PAT（仅需目标仓库 Contents 只读权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | 自动填充 | 执行 `npm run deploy` 时由 `scripts/setup-cloudflare.mjs` 从部署环境自动识别写入 `[vars]`，多账号环境下可手动补充 |
| `AI_GATEWAY_BASE_URL` | Variable | 可选 | 自定义或完整 AI Gateway 地址，可在 `/admin` 上游设置中配置 |
| 其他运行参数 | Variable | 可选 | 如 `DREAM_MODEL`、`DREAM_TIME_ZONE`、`MESSAGES_RETENTION_DAYS` 等，推荐在 `/admin` 设置中覆盖 |

判断原则很简单，凡是名称包含 `KEY` 或 `TOKEN` 的全部配为 **Secret**，其余非敏感参数配为 **Variable** 或在 `/admin` 面板中配置。

## 2. 新部署配置流程

1. Fork `Aelios-project/Aelios` 并在 Cloudflare Workers & Pages 中关联自己的 Fork（或本地克隆部署）。
2. 打开 Worker 的 **Settings → Variables and Secrets**，点击 **Add**，类型选择 **Secret**。
   - 添加 `CHATBOX_API_KEY`，填入自编的高强度随机密钥（例如 `openssl rand -base64 32` 生成的值）。
   - 需要完整聊天转发时添加 `CLOUDFLARE_API_TOKEN`（建议包含 `AI Gateway Run`、`AI Gateway Read` 与 `Workers AI Read` 权限，另可按需加上 `Vectorize Read`）。
   - 按实际需要添加 `MEMORY_MCP_API_KEY`、`IM_API_KEY`、`DEBUG_API_KEY`、`GUIDE_DOG_API_KEY`、`CF_AIG_TOKEN` 或 `GITHUB_DAILY_TOKEN`。
3. 使用以下命令完成构建、建库、建索引、迁移与部署。

```bash
npm ci
npm run deploy
```

`scripts/setup-cloudflare.mjs` 仅同步非敏感变量与资源绑定，不会把任何密钥写进 `wrangler.toml`。本地部署后运行 `git checkout -- wrangler.toml` 还原临时写入的绑定信息，避免提交环境配置。

## 3. 早期 Fork 迁移与密钥轮换（PR #9 之前）

如果在 PR #9 合并之前（2026 年 6 月底前）曾运行过旧版 `setup-cloudflare.mjs`，明文密钥可能已经进入你的 fork 的 `wrangler.toml` git 历史。请按以下顺序排查并处理。

### 第 0 步 同步最新代码

```bash
git remote add upstream https://github.com/Aelios-project/Aelios
git fetch upstream
git checkout main
git merge upstream/main
```

若合并时 `wrangler.toml` 发生冲突，直接删除其中的密钥行。确认 `scripts/setup-cloudflare.mjs` 中的 `visibleVarNames` 已不包含任何 `*_KEY` 或 `*_TOKEN`。

### 第 1 步 检查 git 历史是否包含真实密钥

在仓库根目录执行以下命令。

```bash
git log -p --all -- wrangler.toml | grep -nE "CHATBOX_API_KEY|MEMORY_MCP_API_KEY|GUIDE_DOG_API_KEY|CF_AIG_TOKEN|CLOUDFLARE_API_TOKEN|IM_API_KEY|DEBUG_API_KEY|GITHUB_DAILY_TOKEN" | grep "="
```

- 如果没有任何输出，说明 git 历史未记录密钥，可直接跳至第 3 步。
- 如果出现带真实密钥值的赋值行，需按泄漏处理并继续第 2 步。

### 第 2 步 轮换密钥并清理 git 历史

先完成轮换，再清理历史。一旦密钥进入过公开仓库，必须视为已经暴露并立刻替换。

1. 在 Cloudflare Dashboard 撤销旧的 `CLOUDFLARE_API_TOKEN` / `CF_AIG_TOKEN`，生成新令牌。
2. 重新生成所有暴露过的自编密钥（如 `CHATBOX_API_KEY`、`MEMORY_MCP_API_KEY` 等）。
3. 将新密钥全部以 **Secret** 类型写入 Worker 的 Variables and Secrets。
4. 使用 BFG Repo-Cleaner 或 `git filter-repo` 清除历史中的旧密钥并强制推送。

```bash
git clone --mirror <你的 fork 地址>.git fork-mirror.git
cat <<'KEYS' > secrets-to-clean.txt
CHATBOX_API_KEY=
MEMORY_MCP_API_KEY=
GUIDE_DOG_API_KEY=
IM_API_KEY=
DEBUG_API_KEY=
CF_AIG_TOKEN=
CLOUDFLARE_API_TOKEN=
KEYS
java -jar bfg.jar --replace-text secrets-to-clean.txt fork-mirror.git
cd fork-mirror.git
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force
```

### 第 3 步 清理当前工作树并改用 Secret

检查本地 `wrangler.toml` 的 `[vars]` 段，删除所有 `*_KEY` 与 `*_TOKEN` 行，随后通过命令行或控制台写入 Secret。

```bash
npx wrangler secret put CHATBOX_API_KEY
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put MEMORY_MCP_API_KEY
npx wrangler secret put IM_API_KEY
npx wrangler secret put DEBUG_API_KEY
npx wrangler secret put GUIDE_DOG_API_KEY
npx wrangler secret put CF_AIG_TOKEN
npx wrangler secret put GITHUB_DAILY_TOKEN
```

仅配置你需要启用的可选项即可。随后提交清理后的 `wrangler.toml` 并重新部署验证。

```bash
git add wrangler.toml
git commit -m "chore: remove secrets from wrangler.toml"
git push
npm run deploy
```

部署完成后访问 `/health`，确认返回 `"ok": true`。

## 4. 历史背景

早期 `scripts/setup-cloudflare.mjs` 的 `visibleVarNames` 曾包含若干密钥变量，导致部署时将环境变量写入受 git 跟踪的 `wrangler.toml`。Issue #7 披露该问题后，PR #9 已将这些密钥从 `visibleVarNames` 中移除，脚本不再写入任何凭证。
