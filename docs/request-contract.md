# 请求契约与 thinking 边界

实现入口位于 `src/gateway/request.ts`，负责请求净化、结构预检和 Anthropic thinking 策略边界。

## 处理顺序

请求按以下链路依次执行，本地预检失败直接返回协议形状的 `400`（如 `messages.2.content: tool_use_id must match ...`），既不入库也不调用上游。

鉴权与身份选择 → 按协议净化 → 主模型 thinking 策略 → 合法性预检 → 兼容缓存转换 → 原文记录与召回 → 注入 → 最终出站校验 → 上游转发

原始请求仅用于计算会话指纹和记录原文。`metadata.session_id` 用于区分会话，发往上游前会从非规范 Anthropic metadata 中移除。

## 白名单边界

- 三种协议各自维护顶层字段名单，不在名单中的客户端杂项不转发。更新 SDK/采用新顶层扩展时，需要同步名单。
- Anthropic 进一步处理消息包装、已知内容块、thinking、output_config、metadata、客户端工具定义、缓存对象。
- `output_config.effort`、`output_config.format` 与 `thinking.display` 属于合法字段并保留，顶层 `display` 会被删除。
- JSON Schema、工具 input、服务端工具结果、引用和加密数据是业务/协议数据，不用顶层白名单递归清洗。
- 未知内容块返回带路径的 400，避免静默删除一段历史。thinking/redacted/compaction 等 opaque 历史出现未知字段也拒绝，不改写签名内容。
- 版本化服务端工具定义及其内部 payload 保留原结构，本地不重建全部 beta 或各 Provider 专属 schema。
- Chat Completions 与 Responses 仅净化顶层 envelope，其原生工具、消息和 reasoning 内部结构原样透传。

契约校验涵盖必填字段与类型、消息角色与内容、普通工具调用与结果配对顺序、重复调用 ID、JSON Schema 基本形状、缓存数量与 TTL、thinking budget 与 tool choice、beta binding 及常见输出设置。校验不覆盖完整 JSON Schema 语义、模型 token 上限与签名验证。顶层白名单遵循 Anthropic 官方协议，官方合法但特定上游未实现的字段仍可能由上游返回错误，对 `custom-*` 线路同样保留客户端传入的 effort 与输出格式。

## Thinking 审计矩阵

| 情形 | 召回/注入 | 思考历史及出站策略 |
| --- | --- | --- |
| 主模型、人类输入、默认 auto，原生 Anthropic 或 OpenRouter Claude Messages 线路 | 单次注入 | 客户端声明 enabled 或 adaptive 时按 drop_block 处理。未指定时，仅在历史已有思考块且未带 temperature 或强制工具时补充 adaptive 与绑定，若上游拒绝则按原样重发一次 |
| 主模型、人类输入、auto 走其他线路或 passthrough，thinking 开启或未指定 | 单次注入 | 历史不变，补丁仅附在本轮 user 尾部（Vertex 线路默认不校验前缀绑定） |
| 主模型、显式 disabled、人类输入 | 单次注入 | 不启用 adaptive，不自动加 beta，已有失配历史仍可能由上游报错 |
| 主模型、人类输入、drop_block | 单次注入 | 保留 enabled/adaptive 参数，合并 binding 和 beta |
| 纯 tool_result 续轮 | 不召回、不恢复旧补丁 | drop_block（含 auto 走原生 Anthropic 或 OpenRouter Claude 线路）设置照常发送，历史所有块顺序不变 |
| tool_result 后有独立用户文本 | 按新用户输入召回 | 记忆追加在结果和用户文字之后，不插到结果前 |
| 多次工具调用、分开的连续同角色消息 | 不重排消息 | 按 Anthropic 合并后的逻辑回合校验配对 |
| 多轮签名、空 thinking、redacted thinking | 不删除、不改写 | 本地检查必要字段，真实性及前缀绑定由上游验证 |
| 客户端压缩/换 system/换工具/换模型 | 不恢复影子历史 | passthrough 不保证旧签名有效，drop_block 依赖线路支持 |
| 非主模型 | 无召回、无记录 | 净化和结构校验仍执行，身份策略不启用 thinking |

`drop_block` 指示上游仅丢弃失配的思考块及受其影响的后续块，可能会损失部分推理连续性。切回 `passthrough` 或 `disabled` 后，先前已失配的历史无法自动恢复。原生 Anthropic 线路（2026-10-08 实测）与 OpenRouter 的 Claude Messages 线路（2026-11-16 实测）默认强制校验前缀绑定并支持 `thinking-binding-controls-2026-08-01` beta，因此 `auto` 在这两条线路上按 `drop_block` 处理，其余线路走 `passthrough`。

## 验证范围

`npm run test:gateway` 在本地 Worker 与 SQLite 路径上执行契约测试，覆盖跨空间来源与预算、无效请求零写入、工具循环、签名块保留、混合输入、缓存转换与 beta 头。外部 HTTP 调用使用 mock，端到端验签与具体上游能力仍取决于真实上游实现。

官方参考文档

- [Messages 请求参数](https://platform.claude.com/docs/en/api/messages/create)
- [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
