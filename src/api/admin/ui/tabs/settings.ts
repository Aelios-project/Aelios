import { I, ICON_LINK, ICON_SPIN, SETTING_ROW, t } from "../helpers";

export const ADMIN_TAB_SETTINGS = `      <!-- ===== 设置 ===== -->
      <section x-show="savedApiKey.trim() && page === 'settings'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("设置", "Settings")}</h1>
            <p class="sub">${t("大多数保持默认就好，改完自动保存。", "The defaults suit most people. Changes save automatically.")}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="search w-[300px] max-w-full">${I.search}<span class="sr-only" x-text="L('搜索设置', 'Search settings')"></span><input x-model="gwQuery" type="search" :placeholder="L('搜索设置，中文名或变量名都行', 'Search settings by name or variable')"></label>
            <button type="button" @click="gwRefresh()" :disabled="gwBusy" class="btn btn-icon" :aria-label="L('重新读取线上设置', 'Reload settings')" :title="L('重新读取线上设置', 'Reload settings')">${I.refresh}</button>
          </div>
        </header>
        <p x-show="gwError" class="banner banner-warn" x-text="gwError"></p>

        <div class="grid gap-6 lg:grid-cols-[180px_minmax(0,1fr)] lg:items-start">
          <nav class="subnav sticky top-6 hidden lg:block" :aria-label="L('设置分区', 'Settings sections')">
            <button type="button" @click="scrollToId('s-common')" x-text="L('常用', 'Essentials')"></button>
            <button type="button" @click="scrollToId('s-assistants')" x-text="L('助手', 'Assistants')"></button>
            <button type="button" @click="scrollToId('s-upstream')" x-text="L('模型与上游', 'Models & upstream')"></button>
            <button type="button" @click="scrollToId('s-all')" x-text="L('全部设置', 'All settings')"></button>
            <button type="button" @click="scrollToId('s-connect')" x-text="L('连接与密钥', 'Connection & keys')"></button>
            <button type="button" @click="scrollToId('s-debug')" x-text="L('排查工具', 'Troubleshooting')"></button>
          </nav>

          <div class="flex min-w-0 flex-col gap-6">
            <section id="s-common" x-show="!gwQuery.trim()" class="panel px-[18px] pb-2 pt-4">
              <h2 class="h2 mb-1">${t("常用", "Essentials")}</h2>
              <p x-show="gwBusy && !gwGroups.length" class="py-3 text-[13px] muted" x-text="L('读取中…', 'Loading…')"></p>
              <div>
                <template x-for="item in gwCommon()" :key="item.name">${SETTING_ROW}</template>
              </div>
            </section>

            <section id="s-assistants" x-show="!gwQuery.trim()" class="panel">
              <div class="panel-head">
                <div>
                  <h2 class="h2">${t("助手", "Assistants")}</h2>
                  <p class="mt-1 text-[13px] muted">${t("每个助手一条接入路径，决定哪些模型带记忆、记忆存在哪。", "Each assistant has its own path, decides which models get memory, and where memories are kept.")}</p>
                </div>
                <button type="button" @click="gwAdd()" class="btn btn-sm">${I.plus}${t("添加助手", "Add assistant")}</button>
              </div>
              <div class="divide mt-3" style="border-top: 1px solid var(--div)">
                <p x-show="!gwIdentities.length && !gwBusy" class="empty">${t("还没有助手，点「添加助手」。", "No assistants yet. Add one.")}</p>
                <template x-for="(idn, i) in gwIdentities" :key="i">
                  <div>
                    <div class="row items-start">
                      <span class="avatar" aria-hidden="true" x-text="gwIdentityTitle(idn).slice(0, 1).toUpperCase()"></span>
                      <div class="min-w-0 flex-1">
                        <div class="font-semibold" x-text="gwIdentityTitle(idn)"></div>
                        <div class="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] muted">
                          <span><span x-text="L('接入路径 ', 'Path ')"></span><span class="mono" style="color: var(--t2)" x-text="(idn.slug || '').trim() ? '/' + idn.slug.trim() : L('还没起名字', 'not named yet')"></span></span>
                          <span><span x-text="L('带记忆的模型 ', 'Models with memory ')"></span><span class="mono" style="color: var(--t2)" x-text="(idn.modelsText || '').trim() || L('还没填', 'none yet')"></span></span>
                          <span><span x-text="L('记忆空间 ', 'Memory space ')"></span><span class="mono" style="color: var(--t2)" x-text="(idn.namespace || '').trim() || (idn.slug || '').trim() || '—'"></span></span>
                        </div>
                      </div>
                      <button type="button" @click="idn._open = !idn._open" class="btn btn-sm" :aria-expanded="idn._open ? 'true' : 'false'" x-text="idn._open ? L('收起', 'Done') : L('编辑', 'Edit')"></button>
                    </div>
                    <div x-show="gwSpaceHint(idn)" class="banner mx-[18px] mb-3">
                      <span class="min-w-0 flex-1" x-text="gwSpaceHint(idn) && gwSpaceHint(idn).text"></span>
                      <button type="button" @click="gwUseSpace(idn)" class="btn btn-sm" x-text="gwSpaceHint(idn) && (L('改用 ', 'Use ') + gwSpaceHint(idn).space)"></button>
                    </div>
                    <div x-show="idn._open" class="grid gap-3 px-[18px] pb-[18px]">
                      <label class="block"><span class="label">${t("名字（接入地址里的路径）", "Name (the path in its address)")}</span>
                        <input x-model="idn.slug" class="field" :placeholder="L('如 coder', 'e.g. coder')">
                      </label>
                      <div class="grid gap-3 sm:grid-cols-2">
                        <label class="block"><span class="label">${t("用户叫什么", "What the user is called")}</span>
                          <input x-model="idn.userName" class="field" :placeholder="L('用户叫什么,如 小南', 'e.g. Sam')">
                        </label>
                        <label class="block"><span class="label">${t("助手叫什么", "What the assistant is called")}</span>
                          <input x-model="idn.assistantName" class="field" :placeholder="L('助手叫什么,如 小北', 'e.g. Robin')">
                        </label>
                      </div>
                      <p class="-mt-1 text-xs muted">${t("夜间整理、日记、审核写记忆时只用这两个名字，不写「用户 / 助手」。助手名留空用路径名。", "The nightly run, journal and review use these names instead of “user” and “assistant”. A blank assistant name uses the path.")}</p>
                      <label class="block"><span class="label">${t("带记忆的模型（逗号分隔，支持 * 通配）", "Models with memory (comma-separated, * wildcards)")}</span>
                        <input x-model="idn.modelsText" class="field mono" placeholder="anthropic/claude-opus-5, *fable*">
                      </label>
                      <label class="block"><span class="label">${t("记忆存在哪个空间", "Which space holds its memories")}</span>
                        <input x-model="idn.namespace" class="field" :placeholder="L('留空就用名字', 'Blank uses the name')">
                      </label>
                      <p class="-mt-1 text-xs muted">${t("MCP 和 Claude Code 钩子没指定时都用 default。想和它们共用一份记忆，就填 default。", "MCP and the Claude Code hook use default unless told otherwise. Enter default to share one set of memories with them.")}</p>
                      <div>
                        <span class="label">${t("能用哪些钥匙接入", "Keys that can use it")}</span>
                        <div class="flex flex-wrap gap-x-4 gap-y-2">
                          <template x-for="k in gwKeyOptions" :key="k.id">
                            <label class="check"><input type="checkbox" :value="k.id" x-model="idn.keys"><span x-text="L(k.label, k.labelEn)"></span><span class="mono text-[11px] muted" x-text="k.id"></span></label>
                          </template>
                        </div>
                      </div>
                      <details>
                        <summary class="text-[13px] muted">${t("召回空间、思考块、字数上限、写代码过滤", "Recall spaces, thinking blocks, size limit, coding filter")}</summary>
                        <div class="mt-3 grid gap-3">
                          <label class="block"><span class="label">${t("召回空间", "Recall spaces")}</span>
                            <input x-model="idn.readNamespacesText" class="field" :placeholder="L('逗号分隔；留空只读写入空间；[] 不召回', 'Comma-separated; blank = its own space; [] = none')">
                          </label>
                          <p class="-mt-1 text-xs muted">${t("最多 8 个，共用注入预算。共享时填同一空间；迁移时写新空间、召回保留旧空间。", "Up to 8, sharing one budget. To share, use the same space; to migrate, write to the new one and keep recalling the old.")}</p>
                          <label class="block"><span class="label">${t("Claude 思考块", "Claude thinking blocks")}</span>
                            <select x-model="idn.anthropicThinking" class="field">
                              <option value="auto" x-text="L('自动（默认）：Anthropic 与 OR Claude 丢弃失配思考，其余透传', 'Auto (default): drop mismatched thinking on Anthropic and OpenRouter Claude, pass through elsewhere')"></option>
                              <option value="passthrough" x-text="L('原样透传（Anthropic 与 OR Claude 可能签名失配）', 'Pass through (Anthropic and OpenRouter Claude can reject mismatched signatures)')"></option>
                              <option value="drop_block" x-text="L('总是丢弃失配思考（需 beta，Vertex 勿用）', 'Always drop mismatched thinking (needs beta; not for Vertex)')"></option>
                            </select>
                          </label>
                          <label class="block"><span class="label">${t("单次记忆字数上限", "Memory characters per turn")}</span>
                            <input x-model="idn.maxMemoryChars" type="number" min="256" max="24000" class="field" :placeholder="L('留空默认 6000', 'Blank: 6000')">
                          </label>
                          <div>
                            <label class="check"><input type="checkbox" x-model="idn.codingFilter"><span>${t("写代码时只记说的话（默认开）", "When coding, keep only what was said (on by default)")}</span></label>
                            <p class="text-xs muted">${t("Claude Code、Codex、Cline 这类写代码的工具发来的请求，代码块记成 [code]，读文件、跑命令、改文件的步骤不记。关掉就全记。", "For requests from coding tools such as Claude Code, Codex and Cline, code blocks are saved as [code], and steps that read, run or edit code are not saved. Turn off to save everything.")}</p>
                          </div>
                        </div>
                      </details>
                      <div class="flex justify-end"><button type="button" @click="gwIdentities.splice(i, 1)" class="btn btn-sm btn-danger" x-text="L('移除这个助手', 'Remove this assistant')"></button></div>
                    </div>
                  </div>
                </template>
              </div>
            </section>

            <section id="s-upstream" x-show="!gwQuery.trim()" class="panel">
              <div class="panel-head"><h2 class="h2">${t("模型与上游", "Models & upstream")}</h2></div>
              <div class="divide mt-3" style="border-top: 1px solid var(--div)">
                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${t("上游地址", "Upstream")}</span><span class="chip" :class="gwAddress.trim() ? 'chip-ok' : 'chip-warn'" x-text="gwAddress.trim() ? L('已设置', 'Set') : L('未设置', 'Not set')"></span></div>
                      <div class="mt-0.5 truncate text-[13px] muted" x-text="gwAddress.trim() || L('Cloudflare AI Gateway 或兼容 OpenAI 的地址。供应商钥匙在 Cloudflare 里保管，不经过这里。', 'Cloudflare AI Gateway or any OpenAI-compatible address. Provider keys stay in Cloudflare.')"></div>
                    </div>
                    <button type="button" @click="gwToggle('上游')" class="btn btn-sm" x-text="gwIsOpen('上游') ? L('收起', 'Done') : L('编辑', 'Edit')"></button>
                  </div>
                  <div x-show="gwIsOpen('上游')" class="grid gap-2 px-[18px] pb-[18px]">
                    <input x-model="gwAddress" :aria-label="L('上游地址', 'Upstream')" class="field" :placeholder="L('CF 账号 ID（32 位），或完整地址，如 new-api 的 https://…/v1', 'Cloudflare account ID (32 chars), or a full address such as https://…/v1')">
                    <p class="text-xs leading-5 muted">${t("Claude（anthropic/…）的 messages 走 Cloudflare 的 AI REST API；chat 走 compat，全 provider；其余 messages / responses 走各 provider 原生端点。模型名带 provider/ 前缀。BYOK 钥匙在 AI Gateway 仪表盘；CF 令牌去 Worker Secrets 加 CLOUDFLARE_API_TOKEN，要有 AI Gateway Run 和 Workers AI Read。网关和运行地区在下面。", "Claude (anthropic/…) on messages goes to Cloudflare’s AI REST API; chat uses the compat endpoint for every provider; other messages / responses use each provider’s native endpoint. Model names carry a provider/ prefix. BYOK keys live in the AI Gateway dashboard; add CLOUDFLARE_API_TOKEN under Worker secrets, with AI Gateway Run and Workers AI Read. The gateway and where the Worker runs are set below.")} <a href="https://dash.cloudflare.com/" target="_blank" rel="noopener">${t("打开 Cloudflare ↗", "Open Cloudflare ↗")}</a></p>
                  </div>
                </div>

                <div class="px-[18px] py-1">
                  <template x-for="item in gwUpstreamSettings()" :key="item.name">${SETTING_ROW}</template>
                </div>

                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${t("ChatGPT 套餐", "ChatGPT plan")}</span><span class="chip" :class="chatgptChipClass()" x-text="chatgptChipText()"></span></div>
                      <div class="mt-0.5 text-[13px] muted">${t("模型名写 <code>chatgpt/…</code>，用量算在你的套餐里。只连你自己的账号。", "Use model names like <code>chatgpt/…</code>; usage counts toward your plan. Connect only your own account.")}</div>
                    </div>
                    <button type="button" @click="gwToggle('chatgpt'); if (gwIsOpen('chatgpt') && !chatgpt.loaded) chatgptLoad()" class="btn btn-sm" x-text="gwIsOpen('chatgpt') ? L('收起', 'Done') : L('管理', 'Manage')"></button>
                  </div>
                  <div x-show="gwIsOpen('chatgpt')" class="flex flex-col gap-3 px-[18px] pb-[18px]">
                    <p x-show="chatgpt.error" class="banner banner-warn" x-text="chatgpt.error"></p>
                    <div x-show="chatgpt.status && chatgpt.status.status === 'connected'" class="note rounded-[10px]" style="background: var(--soft)">
                      <p class="text-sm" style="color: var(--t1)">Using ChatGPT plan<span class="muted" x-text="chatgpt.status && chatgpt.status.email ? ' · ' + chatgpt.status.email : ''"></span></p>
                      <p class="mt-1 text-xs muted">${t("想让它带上记忆，把 <code>chatgpt/*</code> 加进助手的「带记忆的模型」。", "To give it memory, add <code>chatgpt/*</code> to an assistant’s models with memory.")} <a href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noopener">Manage usage</a></p>
                    </div>
                    <p x-show="chatgpt.status && chatgpt.status.status === 'plan_disabled'" class="banner">${t("已登录 ChatGPT，但没授权 Aelios 用套餐额度，所以不会发任何请求。点「重新授权」，在同意页里允许使用套餐。", "Signed in, but Aelios isn’t allowed to use your plan, so nothing is sent. Choose Re-authorize and allow plan use on the consent page.")}</p>
                    <div x-show="chatgpt.status && chatgpt.status.status === 'needs_login'" class="banner">
                      <span>${t("ChatGPT 的登录失效了（可能在 ChatGPT 设置里断开过，或很久没用）。重新登录一次就行。", "The ChatGPT sign-in expired (disconnected in ChatGPT settings, or unused for a long time). Sign in again.")}</span>
                      <span x-show="chatgpt.status && chatgpt.status.last_error" class="block text-xs muted" x-text="chatgpt.status && chatgpt.status.last_error"></span>
                    </div>
                    <div class="flex flex-wrap items-center gap-2">
                      <button type="button" @click="chatgptLogin({})" :disabled="chatgpt.busy" x-show="!chatgpt.status || ['disconnected','needs_login'].includes(chatgpt.status.status)" class="btn" style="background: #000; color: #fff; border-color: #000">Continue with ChatGPT</button>
                      <button type="button" @click="chatgptLogin({ reconsent: true })" :disabled="chatgpt.busy" x-show="chatgpt.status && chatgpt.status.status === 'plan_disabled'" class="btn btn-primary" x-text="L('重新授权', 'Re-authorize')"></button>
                      <button type="button" @click="chatgptTest()" :disabled="chatgpt.busy" x-show="chatgpt.status && chatgpt.status.status === 'connected'" class="btn btn-sm" x-text="chatgpt.testing ? L('测试中…', 'Testing…') : L('测试', 'Test')"></button>
                      <button type="button" @click="chatgptLogin({ account: 'new' })" :disabled="chatgpt.busy" x-show="chatgpt.status && chatgpt.status.registered" class="btn btn-sm" :title="L('换账号，或者保存的登记被拒绝时重新登记一次', 'Switch accounts, or register again if the saved registration is refused')" x-text="L('换一个 ChatGPT 账号', 'Use another ChatGPT account')"></button>
                      <button type="button" @click="chatgptLogout()" :disabled="chatgpt.busy" x-show="chatgpt.status && ['connected','plan_disabled','needs_login'].includes(chatgpt.status.status)" class="btn btn-sm btn-danger" x-text="L('退出登录', 'Sign out')"></button>
                    </div>
                    <div x-show="chatgpt.authorizeUrl" class="flex flex-col gap-2 rounded-[12px] p-3.5" style="background: var(--soft)">
                      <p class="text-[13px] leading-6">${t("① 在新打开的页面里登录 ChatGPT 并同意。没弹出来的话", "① Sign in to ChatGPT in the new tab and approve. If it didn’t open,")} <a :href="chatgpt.authorizeUrl" target="_blank" rel="noopener">${t("点这里打开", "open it here")}</a>.</p>
                      <p class="text-[13px] leading-6">${t("② 同意之后浏览器会跳到一个打不开的页面（<code>127.0.0.1</code>，提示无法连接），<b>这是正常的，别关</b>。把地址栏里那一整条地址复制下来，贴在下面。", "② After approving, the browser lands on a page that fails to load (<code>127.0.0.1</code>). <b>That’s expected — don’t close it.</b> Copy the whole address from the address bar and paste it below.")}</p>
                      <textarea x-model="chatgpt.pasted" rows="3" :aria-label="L('粘贴浏览器地址栏里的完整地址', 'Paste the full address from the address bar')" placeholder="http://127.0.0.1:1455/auth/callback?code=…&amp;state=…" class="field mono text-xs"></textarea>
                      <p class="text-xs muted">${t("如果电脑上开着 Codex CLI 之类也在用 1455 端口的程序，它会抢走这个回跳，先关掉再登。链接 10 分钟内有效。", "If something else on your computer uses port 1455 (such as Codex CLI), it will catch this redirect; close it first. The link works for 10 minutes.")}</p>
                      <div class="flex gap-2">
                        <button type="button" @click="chatgptFinish()" :disabled="chatgpt.busy" class="btn btn-primary btn-sm" x-text="L('完成登录', 'Finish sign-in')"></button>
                        <button type="button" @click="chatgpt.authorizeUrl = ''; chatgpt.pasted = ''; chatgpt.error = ''" class="btn btn-sm" x-text="L('取消', 'Cancel')"></button>
                      </div>
                    </div>
                    <div x-show="chatgpt.test" class="rounded-[12px] p-3.5" style="background: var(--soft)">
                      <template x-if="chatgpt.test && chatgpt.test.ok">
                        <div>
                          <p class="text-[13px]"><span x-text="L('通了：', 'Works: ')"></span><span class="mono" x-text="'chatgpt/' + chatgpt.test.model"></span> · <span x-text="chatgpt.test.latency_ms + ' ms'"></span> · “<span x-text="chatgpt.test.reply"></span>”</p>
                          <p class="mt-2 text-xs muted" x-text="L('这个账号能用的模型：', 'Models this account can use:')"></p>
                          <ul class="mt-1"><template x-for="m in (chatgpt.test.models || [])" :key="m.slug"><li class="mono text-[11px] muted" x-text="'chatgpt/' + m.slug + (m.name && m.name !== m.slug ? '（' + m.name + '）' : '')"></li></template></ul>
                        </div>
                      </template>
                      <template x-if="chatgpt.test && !chatgpt.test.ok">
                        <div>
                          <p class="text-[13px]" style="color: var(--err)" x-text="L('没通（', 'Failed (') + chatgpt.test.step + (chatgpt.test.status ? ' · ' + chatgpt.test.status : '') + L('）：', '): ') + chatgpt.test.error"></p>
                          <p x-show="chatgpt.test.status === 403" class="mt-1 text-xs muted">${t("403 也可能是地区限制：Worker 从哪个 Cloudflare 机房出去，OpenAI 就按那里的地区判断。", "A 403 can also be a region block: OpenAI judges by the Cloudflare location your Worker runs from.")}</p>
                        </div>
                      </template>
                    </div>
                  </div>
                </div>

                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${t("模型清单", "Model list")}</span><span class="chip" :class="modelList.items.length ? 'chip-ok' : ''" x-text="!modelList.loaded ? L('读取中', 'Loading') : modelList.items.length ? L('显示 ' + modelList.items.length + ' 个', modelList.items.length + ' shown') : L('显示全部', 'Showing all')"></span></div>
                      <div class="mt-0.5 text-[13px] muted">${t("客户端的模型下拉只显示这里选的，清单外的照样能用。留空显示上游目录里的全部。", "Your app’s model picker shows only these. Others still work. Leave empty to show the whole catalog.")}</div>
                    </div>
                    <button type="button" @click="gwToggle('models')" class="btn btn-sm" x-text="gwIsOpen('models') ? L('收起', 'Done') : L('编辑', 'Edit')"></button>
                  </div>
                  <div x-show="gwIsOpen('models')" class="flex flex-col gap-3 px-[18px] pb-[18px]">
                    <p x-show="modelList.error" class="banner banner-warn" x-text="modelList.error"></p>
                    <ul x-show="modelList.items.length" class="divide rounded-[12px]" style="background: var(--soft)">
                      <template x-for="(id, index) in modelList.items" :key="id">
                        <li class="px-3 py-1.5">
                          <div class="flex items-center gap-1">
                            <span class="mono min-w-0 flex-1 break-all text-xs" x-text="id"></span>
                            <button type="button" @click="modelListCheck(id)" :disabled="modelListState(id) === 'testing'" :aria-label="L('测试连通性 ', 'Test ') + id" :title="modelListCheckTitle(id)" class="icon-btn">
                              <span x-show="modelListState(id) === 'ok'" class="dot dot-ok"></span>
                              <span x-show="modelListState(id) === 'testing'" class="animate-spin">${ICON_SPIN}</span>
                              <span x-show="modelListState(id) === 'fail'" style="color: var(--err)">${ICON_LINK}</span>
                              <span x-show="!modelListState(id)">${ICON_LINK}</span>
                            </button>
                            <button type="button" @click="modelListRemove(id)" :disabled="modelList.busy" :aria-label="L('移除 ', 'Remove ') + id" :title="L('移除', 'Remove')" class="icon-btn">${I.minus}</button>
                          </div>
                          <p x-show="modelListState(id) === 'fail'" class="mt-1 break-words text-[11px]" style="color: var(--err)" x-text="modelList.checks[id] && modelList.checks[id].error"></p>
                        </li>
                      </template>
                    </ul>
                    <div class="flex gap-2">
                      <input x-model="modelList.typed" @keydown.enter.prevent="modelListAddTyped()" :aria-label="L('手填模型名', 'Type a model name')" :placeholder="L('手填模型名，如 openrouter/openai/gpt-6.1-sol:floor', 'Type a name, e.g. openrouter/openai/gpt-6.1-sol:floor')" class="field mono min-w-0 flex-1 text-xs">
                      <button type="button" @click="modelListAddTyped()" :disabled="modelList.busy || !modelList.typed.trim()" class="btn btn-primary" x-text="L('添加', 'Add')"></button>
                    </div>
                    <p class="text-xs muted">${t("自定义 Provider、动态路由、带后缀的写法（如 :floor）目录里都没有，这里手填。一次贴好几个也行，用逗号、空格隔开。", "Custom providers, dynamic routes and suffixes (like :floor) aren’t in the catalog; type them here. Paste several at once, separated by commas or spaces.")}</p>
                    <div class="flex flex-wrap gap-2">
                      <button type="button" @click="modelListTogglePicker()" :disabled="modelList.catalogLoading" class="btn btn-sm" x-text="modelList.catalogLoading ? L('读取中…', 'Loading…') : modelList.pickerOpen ? L('收起目录', 'Hide catalog') : L('从上游目录里选', 'Pick from the catalog')"></button>
                      <button type="button" x-show="modelList.items.length" @click="modelListClear()" :disabled="modelList.busy" class="btn btn-sm" x-text="L('清空，改回显示全部', 'Clear and show all')"></button>
                    </div>
                    <div x-show="modelList.pickerOpen && !modelList.catalogLoading" class="flex flex-col gap-2 rounded-[12px] p-3" style="background: var(--soft)">
                      <p x-show="modelList.catalogReason" class="text-xs muted" x-text="L('上游目录没读到（' + modelList.catalogReason + '）。先检查上游地址和 CF 令牌，或者直接手填。', 'Couldn’t read the catalog (' + modelList.catalogReason + '). Check the upstream and Cloudflare token, or type names in.')"></p>
                      <input x-model="modelList.query" @input="modelListSearch()" :aria-label="L('搜索模型', 'Search models')" :placeholder="L('搜索，如 claude、gpt-5、openrouter', 'Search, e.g. claude, gpt-5, openrouter')" class="field">
                      <p class="text-[11px] muted" x-text="L(modelList.total + ' 个可选', modelList.total + ' available') + (modelList.total > modelList.shown.length ? L('，只列前 ' + modelList.shown.length + ' 个，输入关键词缩小范围', '; showing the first ' + modelList.shown.length + ', type to narrow') : '')"></p>
                      <ul class="max-h-72 overflow-y-auto">
                        <template x-for="(id, index) in modelList.shown" :key="id">
                          <li class="flex items-center justify-between gap-2 py-1" :style="index ? 'border-top: 1px solid var(--div)' : ''">
                            <span class="mono min-w-0 break-all text-[11px]" x-text="id"></span>
                            <button type="button" @click="modelListAdd([id])" :disabled="modelList.busy" :aria-label="L('添加 ', 'Add ') + id" :title="L('添加', 'Add')" class="icon-btn" style="color: var(--ct)">${I.plus}</button>
                          </li>
                        </template>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <div x-show="gwDirty()" x-transition.opacity.duration.150ms class="savebar" role="status">
              <span class="text-sm">${t("助手和上游改了，还没保存", "Assistant or upstream changes aren’t saved yet")}</span>
              <div class="flex gap-2">
                <button type="button" @click="gwDiscard()" :disabled="gwBusy" class="btn btn-sm" x-text="L('放弃', 'Discard')"></button>
                <button type="button" @click="gwSave()" :disabled="gwBusy" class="btn btn-primary btn-sm" x-text="L('保存', 'Save')"></button>
              </div>
            </div>

            <section id="s-all" x-show="gwGroups.length" class="panel">
              <div class="panel-head">
                <h2 class="h2">${t("全部设置", "All settings")}</h2>
                <span class="text-xs muted" x-text="gwChangedCount() ? L('改过 ' + gwChangedCount() + ' 项，其余用默认', gwChangedCount() + ' changed; the rest use defaults') : L('全部是默认值', 'All defaults')"></span>
              </div>
              <div class="divide mt-3" style="border-top: 1px solid var(--div)">
                <template x-for="s in gwSections()" :key="s.group">
                  <div>
                    <button type="button" @click="gwToggle(s.group)" class="group-btn" :aria-expanded="gwGroupOpen(s.group) ? 'true' : 'false'">
                      <span class="min-w-0 flex-1 font-semibold" x-text="gLabel(s)"></span>
                      <span x-show="s.changed" class="chip chip-violet" x-text="L('改过 ' + s.changed + ' 项', s.changed + ' changed')"></span>
                      <span class="text-xs muted" x-text="L(s.items.length + ' 项', s.items.length + (s.items.length === 1 ? ' item' : ' items'))"></span>
                      <span class="chev" :class="gwGroupOpen(s.group) ? 'is-open' : ''">${I.chevron}</span>
                    </button>
                    <div x-show="gwGroupOpen(s.group)" class="px-[18px] pb-2">
                      <template x-for="item in s.items" :key="item.name">${SETTING_ROW}</template>
                    </div>
                  </div>
                </template>
                <p x-show="gwQuery.trim() && !gwSections().length" class="empty">${t("没有找到相关设置。", "No matching settings.")}</p>
              </div>
            </section>

            <section id="s-connect" x-show="!gwQuery.trim()" class="panel">
              <div class="panel-head"><h2 class="h2">${t("连接与密钥", "Connection & keys")}</h2></div>
              <div class="divide mt-3" style="border-top: 1px solid var(--div)">
                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="font-semibold">${t("这台设备的登录", "Sign-in on this device")}</div>
                      <div class="mt-0.5 truncate text-[13px] muted" x-text="tokenSaved() ? L('Token 已保存在本机浏览器里 · ', 'Your token is saved in this browser · ') + baseHost() : L('Token 改了还没保存', 'Token changed but not saved')"></div>
                    </div>
                    <button type="button" @click="tokenEditing = !tokenEditing" class="btn btn-sm" x-text="tokenEditing ? L('收起', 'Done') : L('更换', 'Change')"></button>
                    <button type="button" @click="signOut()" class="btn btn-sm btn-danger" x-text="L('退出', 'Sign out')"></button>
                  </div>
                  <div x-show="tokenEditing" class="grid gap-3 px-[18px] pb-[18px]">
                    <label class="block"><span class="label">${t("Worker 地址", "Worker address")}</span><input x-model="workerUrl" @change="savePrefs()" class="field" placeholder="https://…workers.dev"></label>
                    <label class="block"><span class="label">Token</span>
                      <span class="flex gap-2"><input x-model="apiKey" @keydown.enter.prevent="saveToken()" type="password" autocomplete="current-password" class="field min-w-0 flex-1"><button type="button" @click="saveToken()" class="btn btn-primary" x-text="L('保存', 'Save')"></button></span>
                    </label>
                  </div>
                </div>
                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2"><span class="font-semibold">${t("Worker 密钥", "Worker secrets")}</span><span class="chip" x-text="L(gwSecrets.filter(function(s) { return s.present; }).length + ' / ' + gwSecrets.length + ' 已设', gwSecrets.filter(function(s) { return s.present; }).length + ' of ' + gwSecrets.length + ' set')"></span></div>
                      <div class="mt-0.5 text-[13px] muted">${t("只在 Cloudflare 的 Worker 设置里改，这里只看状态。", "Changed only in Cloudflare’s Worker settings. This shows their status.")}</div>
                    </div>
                    <button type="button" @click="gwToggle('密钥')" class="btn btn-sm" x-text="gwIsOpen('密钥') ? L('收起', 'Done') : L('查看', 'View')"></button>
                  </div>
                  <div x-show="gwIsOpen('密钥')" class="grid gap-1.5 px-[18px] pb-[18px]">
                    <template x-for="s in gwSecrets" :key="s.name || s.label">
                      <p class="flex items-center gap-2 text-[13px]" :style="s.present ? '' : 'color: var(--t3)'"><span class="dot" :class="s.present ? 'dot-ok' : ''"></span><span x-text="L(s.label, s.labelEn || s.label)"></span><span x-show="s.name" class="mono text-[11px] muted" x-text="s.name"></span></p>
                    </template>
                  </div>
                </div>
              </div>
            </section>

            <section id="s-debug" x-show="!gwQuery.trim()" class="panel">
              <div class="panel-head"><h2 class="h2">${t("排查工具", "Troubleshooting")}</h2></div>
              <div class="divide mt-3" style="border-top: 1px solid var(--div)">
                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="font-semibold">${t("为什么想起了这件事", "Why was this recalled?")}</div>
                      <div class="mt-0.5 text-[13px] muted">${t("所选助手最近 20 次召回的打分，调召回时看。", "Scores from the selected assistant’s last 20 recalls, for tuning.")}</div>
                    </div>
                    <button type="button" @click="gwToggle('召回'); if (gwIsOpen('召回')) loadRecallHistory()" class="btn btn-sm" x-text="gwIsOpen('召回') ? L('收起', 'Close') : L('打开', 'Open')"></button>
                  </div>
                  <div x-show="gwIsOpen('召回')" class="flex flex-col gap-3 px-[18px] pb-[18px]">
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-xs muted" x-text="selectedIdentity ? L('记录按助手区分，不随单个召回空间合并。', 'Records are per assistant, not merged across recall spaces.') : L('先在左上「正在查看」里选一位助手。', 'Pick an assistant under “Viewing” first.')"></p>
                      <button type="button" @click="loadRecallHistory()" :disabled="recallHistoryLoading || !selectedIdentity" class="btn btn-sm" x-text="L('刷新记录', 'Refresh')"></button>
                    </div>
                    <div aria-live="polite">
                      <p x-show="recallHistoryLoading" class="text-xs muted" x-text="L('读取中…', 'Loading…')"></p>
                      <p x-show="recallHistoryError" class="text-xs" style="color: var(--err)" x-text="recallHistoryError"></p>
                      <p x-show="selectedIdentity && !recallHistoryLoading && !recallHistoryError && !recallHistory.length" class="text-xs muted" x-text="L('还没有召回记录。', 'No recalls yet.')"></p>
                    </div>
                    <template x-for="record in recallHistory" :key="record.id">
                      <details class="rounded-[12px] p-3" style="background: var(--soft)">
                        <summary class="text-sm" x-text="record.query || L('本轮召回', 'This turn’s recall')"></summary>
                        <p class="mt-2 text-xs muted" x-text="fmt(record.created_at) + ' · ' + recallStatusLabel(record.selection && record.selection.status) + ' · ' + L('带上 ' + (record.injected || 0) + ' 条', (record.injected || 0) + ' brought in')"></p>
                        <p class="mt-1 text-xs muted" x-text="recallReasonLabel(record.selection && record.selection.reason)"></p>
                        <p class="mt-1 text-xs muted" x-show="record.selection && record.selection.threshold != null" x-text="record.selection ? L('分数下限 ', 'Score floor ') + record.selection.threshold + (record.selection.elapsed_ms != null ? L(' · 重排与筛选 ', ' · rerank and filter ') + record.selection.elapsed_ms + ' ms' : '') + L(' · 分数不是正确率', ' · scores are not accuracy') : ''"></p>
                        <template x-for="(decision, i) in (record.decisions || [])" :key="i">
                          <div class="mt-2 pt-2" style="border-top: 1px solid var(--div)">
                            <p class="text-xs" :style="decision.injected ? 'color: var(--ct)' : 'color: var(--t3)'" x-text="(decision.injected ? L('已选 · ', 'Chosen · ') : L('未选 · ', 'Skipped · ')) + recallReasonLabel(decision.reason)"></p>
                            <p class="mt-1 text-xs muted" x-show="decision.score != null" x-text="decision.score != null ? L('相关分数 ', 'Relevance ') + Number(decision.score).toFixed(3) : ''"></p>
                            <p class="mt-1 whitespace-pre-wrap text-sm" x-text="decision.excerpt || ''"></p>
                            <p class="mono mt-1 break-all text-[11px] muted" x-text="(decision.namespace || '') + ' / ' + (decision.id || decision.kind || '')"></p>
                          </div>
                        </template>
                      </details>
                    </template>
                  </div>
                </div>
                <div>
                  <div class="row">
                    <div class="min-w-0 flex-1">
                      <div class="font-semibold">${t("维护", "Maintenance")}</div>
                      <div class="mt-0.5 text-[13px] muted">${t("检查和补齐向量，或者立刻把这个空间整理一遍。", "Check and fill in missing vectors, or run the nightly process for this space now.")}</div>
                    </div>
                    <button type="button" @click="gwToggle('维护')" class="btn btn-sm" x-text="gwIsOpen('维护') ? L('收起', 'Close') : L('打开', 'Open')"></button>
                  </div>
                  <div x-show="gwIsOpen('维护')" class="flex flex-col gap-3 px-[18px] pb-[18px]">
                    <p class="text-xs muted" x-text="L('当前空间：', 'Current space: ') + namespace"></p>
                    <div class="flex flex-wrap gap-2">
                      <button type="button" @click="runHealth()" class="btn btn-sm" x-text="L('检查向量库', 'Check vectors')"></button>
                      <button type="button" @click="runReindex(true)" class="btn btn-sm" x-text="L('重建索引（只预览）', 'Reindex (preview)')"></button>
                      <button type="button" @click="runBackfill(true)" class="btn btn-sm" x-text="L('查缺向量', 'Find missing vectors')"></button>
                      <button type="button" @click="runBackfill(false)" class="btn btn-sm" x-text="L('补缺向量', 'Fill missing vectors')"></button>
                      <button type="button" @click="runDream()" class="btn btn-primary btn-sm" x-text="L('立刻强制整理', 'Force a nightly run now')"></button>
                    </div>
                    <pre class="out" x-text="debugOutput || L('还没运行维护操作。', 'No maintenance run yet.')"></pre>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  </main>

  <div x-show="toast" x-transition.opacity.duration.150ms class="toast" role="status" x-text="toast"></div>
`;
