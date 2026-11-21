# Aelios

**A long-term memory for your AI.** Switch windows, switch clients, and switch models while keeping one continuous memory.

English | [简体中文](README.zh-CN.md) · QQ group `1091783659`

Aelios runs on Cloudflare Workers as a memory gateway. Your Chatbox, Claude Code, Codex, or custom agent connects to Aelios, and Aelios forwards the request to your model while recording conversations and bringing back relevant context on every turn.

```text
your client  →  Aelios (identify, recall, record)  →  upstream model
```

## Let an AI set it up

If you use Claude Code, Codex, Cursor, or an AI connected to the Cloudflare MCP server, send it this prompt.

```text
Install and set up Aelios (my AI memory gateway) for me. Read https://raw.githubusercontent.com/Aelios-project/Aelios/main/docs/setup-with-ai.md first and follow it. When I need to click something in the browser or enter a key myself, stop and tell me where.
```

This works from a blank Cloudflare account or an existing deployment. The AI forks and deploys Aelios, creates the Cloudflare API token, configures your first assistant, and optionally imports old memories or chat logs, then hands you a Base URL, API Key, and model name. You only need a free Cloudflare account and a model provider key. You approve login in the browser and store provider keys in your Cloudflare dashboard so credentials stay out of chat. The guide is written in Chinese, and the AI will talk to you in your language.

The recommended setup pairs **API mode** with the **MCP connector**. API mode records and recalls automatically on every turn, while MCP lets the assistant actively search, remember, and manage its own notes. If you only have a Claude subscription without API access, connect MCP on its own (and add the Claude Code hook if you use Claude Code).

To install manually, follow the three steps below.

## Quick start

### 1. Deploy

Fork this repository first, then deploy from your fork so future updates stay one click away (see [Updating to the latest version](#updating-to-the-latest-version)).

1. Click **Fork** at the top right of this page.
2. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a repository**, connect GitHub, and select your fork. Keep the project name `companion-memory-proxy`, set the build command to `npm ci`, and set the deploy command to `npm run deploy`. The deploy script creates the D1 database, Vectorize index, and Queue automatically and applies all migrations.
3. Open your Worker's **Settings → Variables and Secrets** and add a **Secret** named `CHATBOX_API_KEY` with a strong random password (for example `openssl rand -base64 32`). This is the only required secret. Optional keys are documented in [SECRETS.md](SECRETS.md).

After deployment, Cloudflare gives you a Worker URL like the following.

```text
https://companion-memory-proxy.<your-subdomain>.workers.dev
```

Always deploy through `npm run deploy`. Running a bare `wrangler deploy` skips resource provisioning and migrations.

**One-click deploy button** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Aelios-project/Aelios)

The button creates an independent copy in your GitHub account without a **Sync fork** button, which makes future upgrades manual. If you still deploy with it, fill in `CHATBOX_API_KEY`, keep Vectorize Dimensions `1024` and Metric `cosine`, use build command `npm ci`, and use deploy command `npm run deploy`. See [Deployed with the button](#deployed-with-the-button) to switch an existing button deployment over to a fork.

### 2. Add an assistant

Open your admin panel in a browser.

```text
https://<your-worker-url>/admin
```

Sign in with your Worker URL and `CHATBOX_API_KEY`, then open **Settings**.

1. Under **Models & upstream**, enter your 32-character Cloudflare account ID (or a custom OpenAI-compatible base URL). For full chat forwarding through Cloudflare AI Gateway, also add `CLOUDFLARE_API_TOKEN` as a Worker Secret.
2. Under **Assistants**, click **Add assistant** and fill in the fields.

   | Field | Purpose | Example |
   | --- | --- | --- |
   | Name (`slug`) | URL segment in lowercase letters | `coder` |
   | Primary models | Only matching models recall and record memory (supports `*`) | `anthropic/claude-opus-4-5`, `*deepseek*` |
   | Keys | Which Worker API keys may use this assistant | check Main key (`CHATBOX_API_KEY`) |

3. Click **Save**.

Each assistant gets its own URL path. An assistant named `coder` is served at the following base URL.

```text
https://<your-worker-url>/coder/v1
```

Only registered primary models trigger recall and recording. Utility models such as background classifiers or lightweight sub-models pass through quietly.

When you use coding agents such as Claude Code, Codex, Cline, or opencode, Aelios records spoken conversation only. Code blocks are stored as `[code]`, and shell or file-editing tool steps are omitted. To record everything verbatim, turn off the coding speech filter in the assistant's advanced options.

### 3. Connect your client

Use `CHATBOX_API_KEY` as the API key and include the provider prefix in the model name (for example `anthropic/claude-opus-4-5` or `deepseek/deepseek-chat`).

| Client | Configuration |
| --- | --- |
| Chatbox, Cherry Studio, OpenAI-compatible apps | Base URL `https://<your-worker-url>/coder/v1` |
| Claude Code | `ANTHROPIC_BASE_URL=https://<your-worker-url>/coder` |
| Codex | `base_url = "https://<your-worker-url>/coder/v1"` with `wire_api = "responses"` |

Calling `/v1` without an assistant slug routes to the first assistant authorized for that API key.

Test the loop by sending `"Please remember my test codeword is apple-star-0428."`, then asking `"What is my test codeword?"` in a fresh conversation.

## Updating to the latest version

GitHub forks stay on the commit where you forked them until you sync.

1. Open your fork on GitHub and click **Sync fork → Update branch**.
2. Cloudflare detects the new commit, builds, runs `npm run deploy`, applies any new D1 migrations, and deploys automatically.

Your memories, settings, assistants, and secrets live inside your Cloudflare account. Keep runtime configuration inside `/admin` so syncing your fork never hits merge conflicts.

### Deployed with the button

Switching from a button-created copy to a fork keeps all existing Cloudflare data intact.

1. Fork `Aelios-project/Aelios` on GitHub.
2. If you renamed the D1 database or Vectorize index during the button setup, add `CMP_D1_NAME` and `CMP_VECTORIZE_NAME` under **Settings → Build → Build Variables and Secrets** with your custom names so the deploy script reuses them.
3. Under **Settings → Build**, click **Disconnect**, then **Connect** and select your fork with build command `npm ci` and deploy command `npm run deploy`.
4. Merge any pull request Cloudflare opens on your fork to align the Worker name.

## How Aelios works

- **Per-turn recall** On every human turn to a primary model, Aelios searches Vectorize (`memo-kb`) and D1 full-text indexes, scores passages in one batch with Workers AI reranker (`@cf/baai/bge-reranker-base`), and appends the relevant clean originals to that turn. No generative LLM runs on the recall hot path.
- **Daytime Dream** Enabled by default (`ROLLING_DREAM`). As new chats accumulate (10 messages or 8,000 characters by default), `@cf/cloudflare/clef-flash` checks whether the stretch contains anything worth keeping, and `DREAM_MODEL` (default `workers-ai/@cf/zai-org/glm-4.7-flash`) writes review candidates or explicit decisions.
- **Nightly Dream and Clef review** A daily cron (`10 20 * * *` UTC) processes any remaining messages from the previous day (with a 3-day backfill window), lets Cloudflare's `@cf/cloudflare/clef` decision model auto-review pending candidates (`CLEF_AUTO_REVIEW`, on by default and undoable per item), writes daily, weekly, and monthly journal entries, and enforces retention rules.
- **Multi-space reading** Each assistant writes to one `namespace` and can read up to 8 spaces via `readNamespaces` (for example reading an archived space or shared documentation alongside its own space).
- **Provenance and cleanup** Raw chat lines live for 7 days by default (`MESSAGES_RETENTION_DAYS`). Unused memories expire after 180 days (pinned, identity, and persona memories never expire) and are hard-deleted 30 days later. Removing a noisy line in `/admin` leaves memories intact by default, while withdrawal removes memories that explicitly cited that line.

For the full storage, Dream, provenance, and current-decision architecture, read [docs/memory-lifecycle.md](docs/memory-lifecycle.md).

## Daily management in `/admin`

Open `/admin` to inspect and manage every memory space. The sidebar switches between Chinese and English (following your browser language by default) and between light and dark themes.

| Page | Purpose |
| --- | --- |
| **Home** | Today's conversations (heart to keep as a keepsake, trash to remove noisy or unwanted lines), pending items, last night's Dream summary, and the latest journal entry |
| **Review** | Pending memory candidates. With Clef auto-review enabled, decisions appear under **Auto-handled this week** with one-click undo. Switching Clef off keeps daily candidates waiting for manual or MCP review. Imported candidates always wait under **Imported** |
| **Journal** | Daily, weekly, and monthly entries (weeks older than ~5 weeks fold into the monthly entry), with **Rewrite from the originals** for days still within transcript retention |
| **Memories** | Browse, search, edit, merge, and inspect version history across **Core**, **Keepsakes**, **Our words**, **Notebook**, **Handoff**, and **World facts** |
| **Star map** | Interactive 3D memory graph opened in its own page (`/admin/starmap`) |
| **Nightly** | Daytime Dream backlog and window status, 7-day nightly run history, per-night harvest, and manual Dream runs |
| **Import & export** | Backup export (`md` or `jsonl`), structured entry import, chat log extraction, and zero-LLM chat archiving |
| **Settings** | Common settings, assistants, models & upstream (including ChatGPT plan and model list), all settings, keys, and troubleshooting (recall logs and vector maintenance) |

### Running Dream by hand

To catch up a missed night or run a specific date right away, follow these steps.

1. Open **Nightly** and verify the selected memory space under **Viewing** in the top left.
2. Under **Run a night by hand**, choose the date (or click **Re-run this night** on a failed run) and untick **Preview only** to perform a real write.
3. Click **Start**. Non-preview runs queue on `MEMORY_QUEUE` and continue in the background even after you close the page.
4. Each run processes one batch (`DREAM_MAX_MESSAGES`, default `40`). Run again if more batches remain for that date. The final batch automatically generates that day's journal entry.

If a task remains unconfirmed for more than 20 minutes, inspect the Worker logs and click **Mark as interrupted** before queuing a new run.

### Export, import, and chat archive

Everything on **Import & export** operates on the currently selected space.

- **Export** Downloads `md` or `jsonl`. Markdown puts one memory per line with date, content, `#tags`, and a backtick key. Editing and re-importing updates matching keys in place while preserving revision history.
- **Import entries** Accepts lines like `- 2025-12-15 [preference] Likes oolong tea #drinks` (date, type, and tags are optional) as well as plain lists or paragraphs. You can save directly (exact duplicates skip, close matches route to Review) or send everything to Review.
- **Import chat logs** Parses ChatGPT and Claude `conversations.json`, SillyTavern `.jsonl`, and `Name: message` transcripts in the browser, chunks by day, and extracts candidates via `DREAM_MODEL` into Review → **Imported**. Only lines cited by candidates are stored alongside them, independent of 7-day raw chat cleanup. Re-selecting the same file resumes where you left off.
- **Chat archive** Selecting **Archive originals only for keyword search** saves full transcripts with zero model calls. Turn on **Archive new chats** (`CHAT_ARCHIVE_ENABLED`) under **Settings → Data retention** to archive new conversations automatically. MCP clients search archived text with `search_chat` (2 to 120 characters) and pass a hit ID to `search_chat`'s `around` parameter to view nearby messages in the same conversation. Archives stay indefinitely by default (`CHAT_ARCHIVE_RETENTION_DAYS`).

## Integrations and optional features

### Full Cloudflare AI Gateway and custom model list

1. In Cloudflare **AI → AI Gateway**, create a gateway and store your provider keys (BYOK).
2. Add `CLOUDFLARE_API_TOKEN` as a Worker Secret (permissions `AI Gateway Run`, `AI Gateway Read`, `Workers AI Read`, and optionally `Vectorize Read`).
3. Enter your 32-character Cloudflare account ID under `/admin` → **Settings → Models & upstream**, then configure your assistants.

Without AI Gateway or a Cloudflare token, memory recall, MCP, and Workers AI Dream still run out of the box.

To keep client model pickers uncluttered, open **Settings → Models & upstream → Model list → Edit** to pick the models you actually use, add custom provider or dynamic-route names, and test connectivity per model. `GET /v1/models` then returns that exact list in order while keeping all other models callable by name.

### Use your ChatGPT Plus or Pro plan

Connect your personal ChatGPT plan via OpenAI's Sign in with ChatGPT without an OpenAI API key.

1. Open `/admin` → **Settings → Models & upstream → ChatGPT plan → Manage → Continue with ChatGPT** and sign in.
2. Your browser redirects to an unreachable `127.0.0.1` URL. Copy that full address from the address bar, paste it back into `/admin`, and click **Finish sign-in**.
3. Call models as `chatgpt/<model>` (click **Test** to inspect available models) and add `chatgpt/*` to an assistant's primary models to enable memory.

Tokens are encrypted in D1 with a key derived from `CHATBOX_API_KEY` (rotating that key requires signing in again). Chat Completions, Anthropic Messages, and Responses clients all work on this route, including function tools and web search, while hosted tools (image generation, file search, code interpreter, remote MCP) are unsupported. You can also set `DREAM_MODEL` or `DIARY_MODEL` to `chatgpt/<model>`, which counts toward your plan usage. Technical details on GPT prompt caching and recall placement live in [docs/memory-gateway.md](docs/memory-gateway.md).

### MCP connector (Claude app, Claude Code, Codex)

Connect any remote Streamable HTTP MCP client to the following URL.

```text
https://<your-worker-url>/mcp?token=<CHATBOX_API_KEY>
```

Prefer `MEMORY_MCP_API_KEY` when sharing connector URLs across devices because `?token=` is stored by clients.

- **Claude web and mobile apps** Add a custom connector at `claude.ai/customize/connectors` with the URL above and set read-only tools to **Always allow**. Because the official Claude app ignores server-supplied MCP instructions, paste the guidance below into your user preferences or project instructions.

```text
You have access to my Aelios memory connector for long-term memory. Call wake_up at the start of every new conversation before replying. Call recall whenever I mention people, past events, or preferences, or before guessing something about me. Call remember right away when I share new facts, change my mind, or make a promise. Call log_conversation as the chat winds down so tonight's diary and memory pass can reflect on it.
```

- **Direct-chat clients** Chats in the official Claude app skip the gateway, so `log_conversation` hands the transcript to Aelios for daytime/nightly Dream and journals. Gateway clients record automatically and skip `log_conversation`.
- **Tool sets** Twelve everyday tools are listed by default. Append `&tools=all` to include maintenance tools (`memory_get` and `memory_export`).

### Magpie gateway plugin

If your agents already route through [magpie](https://github.com/yetone/magpie), its Aelios plugin integrates via `GET /v1/hook/identities`, `POST /v1/hook/recall`, and `POST /v1/hook/record` without changing the agent's model upstream. See [docs/memory-gateway.md](docs/memory-gateway.md#hook-接口magpie-插件用).

### Claude Code hook (subscription-only)

If you use Claude Code with a subscription and cannot route through API mode, install the Python hook in [integrations/claude-code/README.md](integrations/claude-code/README.md) for automatic per-message recall and batched transcript ingestion.

### Vision proxy (`guide-dog`)

Add the `GUIDE_DOG_API_KEY` Worker Secret and point image-description requests to `https://<your-worker-url>/v1/guide-dog/chat/completions` (or base URL `https://<your-worker-url>/v1/guide-dog` with model `companion`). This route describes images and writes no memory.

### Companion Worker (`Aelios-resident`)

[Aelios-resident](https://github.com/Aelios-project/Aelios-resident) is a separate Durable Object companion running on Cloudflare Workers Free with Telegram and web chat unified into one thread. Point its settings page at your Aelios URL, API key, and assistant slug to give it shared long-term memory, handoff letters, web search, and scheduled check-ins.

## Common pitfalls and Workers Free notes

- **Deploy command** Always run `npm run deploy` so D1, Vectorize, Queue, and migrations stay provisioned.
- **Workers Free plan budget** Daytime Dream (`ROLLING_DREAM`, on by default) and nightly Dream share Workers AI's 10,000 daily neurons. On the Free plan, switch off **Daytime Dream** in `/admin` Settings if you want all extraction to run once at night.
- **Model naming** Include the provider prefix (`anthropic/claude-opus-4-5`, `deepseek/deepseek-chat`), and list only primary chat models under an assistant so utility models stay out of memory.
- **Assistant slugs** Use lowercase URL-safe English names with no spaces.
- **Vectorize index** Keep `memo-kb` (1024-dim cosine) intact.
- **Manual Dream preview** Untick **Preview only** on the Nightly page when running a real catch-up batch.

## Documentation map

- AI-assisted installation runbook [docs/setup-with-ai.md](docs/setup-with-ai.md)
- Gateway architecture, upstream routing, GPT caching, and magpie hooks [docs/memory-gateway.md](docs/memory-gateway.md)
- Memory storage, recall, daytime/nightly Dream, provenance, and retention [docs/memory-lifecycle.md](docs/memory-lifecycle.md)
- Request sanitization, schema validation, and Anthropic thinking matrix [docs/request-contract.md](docs/request-contract.md)
- Secrets vs. variables and legacy key rotation [SECRETS.md](SECRETS.md)
- Security policy and vulnerability reporting [SECURITY.md](SECURITY.md)

---

# For maintainers

## Cloudflare resources

| Resource | Default name |
| --- | --- |
| Worker | `companion-memory-proxy` |
| D1 database | `companion_memory_proxy` |
| Vectorize index | `memo-kb` (1024-dim, cosine) |
| Queue | `companion-memory` (`max_batch_size = 1`) |
| Embedding model | `workers-ai/@cf/baai/bge-m3` |
| Reranker model | `@cf/baai/bge-reranker-base` |
| Default Dream / Diary model | `workers-ai/@cf/zai-org/glm-4.7-flash` |
| Triage / Review models | `@cf/cloudflare/clef-flash` / `@cf/cloudflare/clef` |

When helping someone deploy, always deploy from the user's own fork and keep all secrets inside their Cloudflare account.

## Endpoints

All endpoints other than `/health` and `/admin` require `Authorization: Bearer <key>` (or `?token=` on `/mcp`). Gateway routes authorize by assistant key lists, and memory APIs enforce `memory:read` / `memory:write` scopes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health and binding status |
| `GET` | `/admin`, `/admin/starmap` | Admin panel and 3D memory star map |
| `GET` | `/v1/models` | Upstream model catalog or saved `modelList` |
| `POST` | `/<slug>/v1/chat/completions`, `/messages`, `/responses` | Memory-aware model gateway (bare `/v1/...` uses key's first assistant) |
| `GET` / `PATCH` | `/api/gateway/config`, `/env`, `/spaces`, `/recalls` | Owner configuration, defaults, spaces, and recall diagnostics |
| `GET` / `POST` | `/api/gateway/models`, `/models/test`, `/chatgpt/*` | Model catalog, single-model test, and ChatGPT plan sign-in |
| `GET` / `POST` | `/v1/hook/identities`, `/recall`, `/record` | External gateway hook endpoints (magpie plugin) |
| `GET` / `POST` | `/mcp` | Streamable HTTP MCP server |
| `GET` / `POST` / `PATCH` / `DELETE` | `/v1/memories`, `/v1/memories/:id`, `/revisions`, `/export` | Memory CRUD, revision history, and `md`/`jsonl` export |
| `POST` | `/v1/memory/recall`, `/v1/search/memories`, `/v1/ingest/messages` | Dynamic recall, unmetered raw search, and chat ingest |
| `DELETE` | `/v1/raw/:id` | Delete a raw chat line (`?mode=clean` default, or `?mode=withdraw` to withdraw cited derived memories) |
| `GET` | `/v1/memory_boot` | Cold-start pack (omits current handoff) |
| `GET` / `PUT` / `DELETE` | `/v1/handoff` | Current handoff letter with `expected_revision` optimistic lock |
| `GET` / `POST` / `PATCH` / `DELETE` | `/v1/notebook`, `/v1/notebook/:id` | Named working-note pages (`DELETE ?confirm=all` clears the space) |
| `GET` / `POST` / `DELETE` | `/v1/precious`, `/v1/glossary` | Keepsake originals and shared glossary |
| `GET` / `POST` | `/v1/diary`, `/v1/diary/recent`, `/admin/diary-rewrite` | Journal reads and rewriting a retained day from raw chat |
| `GET` / `POST` | `/v1/dream/status`, `/run`, `/resolve`, `/admin/dream/harvest` | Dream status, sync or queued manual runs, stale-run resolution, and per-night harvest |
| `GET` / `POST` | `/v1/candidates`, `/decisions`, `/:id/undo`, `/:id/sources` | Candidate review queue, Clef auto-decisions, undo, and cited lines |
| `GET` / `POST` | `/v1/import/*` | Transfer endpoints (`info`, `entries/preview`, `entries`, `batches`, `chat/chunk`, `candidates`) |

## MCP tools

- **Default 12 tools** `wake_up`, `recall`, `remember`, `keep_moment`, `forget`, `learn_word`, `read_diary`, `search_chat`, `log_conversation`, `list_memories`, `handoff`, `notebook`
- **When `CLEF_AUTO_REVIEW` is off** Also lists `memory_candidates` and `memory_review`
- **With `&tools=all`** Also lists `memory_get` and `memory_export`
- **Legacy aliases** `memory_boot`, `memory_recall`, `memory_search`, `memory_upsert`, `memory_supersede`, `memory_archive`, `memory_delete`, `memory_ingest`, `memory_pin`, `glossary_set`, `diary_get`, and `memory_list` stay callable for older scripts while remaining hidden from `tools/list`

## Dream model and output budget

Background extraction, daytime Dream, weekly summaries, and chat imports use `DREAM_MODEL` (default `workers-ai/@cf/zai-org/glm-4.7-flash`). Daily journals and monthly summaries optionally override this with `DIARY_MODEL`. Output length is configured via `DREAM_MAX_TOKENS` (1 to 65,536). Leaving any text setting blank in `/admin` falls back to the effective default displayed beside that field. The repository `wrangler.toml` sets `DREAM_MAX_TOKENS` to `8000`. If neither the deployment nor Settings provides a current or legacy value, Workers AI uses `8000` and other gateways use the upstream provider's default. The ChatGPT plan route always applies its own limit.

## Local verification

Tests require Node.js 22+.

```bash
npm ci
npm run verify
npm run lint
```

`npm run verify` runs TypeScript typechecks, the full test suite, and five verification scripts including applying every D1 migration in `migrations/` to a local database. CI requires `npm run lint` to pass with zero errors. Existing `noNonNullAssertion` warnings are non-blocking, and bulk Biome autofix must be avoided because converting `x!.y` to `x?.y` hides unexpected nulls.

## License

AGPL-3.0. You are free to use and modify Aelios. If you offer a modified version as a network service, publish your modified source code under the same license. The final v1 release is tagged `v1-final` (licensed under MIT at the time).

## Community

QQ group `1091783659`
