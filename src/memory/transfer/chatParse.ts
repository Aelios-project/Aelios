// 把各家导出的聊天记录认成统一的一条条消息，再按天切段。
//
// 这个文件的函数会原样搬进后台页面在浏览器里跑 (见 CHAT_PARSE_FUNCTIONS 和 chatParseBrowserScript)：
// 聊天记录动辄几十上百兆，在浏览器里解析、切段，一段段送到 Worker，不整份上传。
// 所以这里的函数必须自给自足：不 import、不用模块级常量，互相只按函数名调用，常量写在函数体里。
//
// 认得的格式：
// - ChatGPT 导出的 conversations.json (mapping 树，沿 current_node 取当前那一支)
// - Claude 导出的 conversations.json (chat_messages)
// - SillyTavern (酒馆) 的 .jsonl 聊天文件 (第一行是元数据，之后每行 {name, is_user, send_date, mes})
// - 通用 JSON / JSONL：消息数组，或带 messages 的对话数组 (role/sender/author + content/text)
// - 纯文本 / md：「【咲咲】……」「咲咲：……」「[2025-12-15 23:01] 咲咲: ……」「You said: / ChatGPT said:」，
//   日期单独一行当小标题也认；QQ、微信那种「时间 名字」一行、正文下一行也认。

export interface ChatMessage {
  /** 认不出是谁说的 (纯文本里按名字分的) 时为 null，等页面上选「哪个是你」。 */
  role: "user" | "assistant" | null;
  speaker: string | null;
  content: string;
  /** ISO 时间，不知道就 null */
  time: string | null;
  /** 只知道哪天 (纯文本里的日期小标题) 时的 YYYY-MM-DD */
  date: string | null;
  conversation?: string;
}

export interface ChatSpeaker {
  name: string;
  count: number;
  role: "user" | "assistant" | null;
}

export interface ParsedChat {
  format: string;
  messages: ChatMessage[];
  speakers: ChatSpeaker[];
  conversations: number;
  skipped: number;
  warnings: string[];
}

export interface ChatChunk {
  key: string;
  day: string | null;
  messages: Array<{ seq: number; role: "user" | "assistant"; content: string; time: string | null; speaker: string | null; conversation?: string }>;
  chars: number;
}

/** 文字或文字片段数组 → 纯文本。图片、文件之类的块跳过。 */
export function chatContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const block = part as Record<string, unknown>;
          if (typeof block.text === "string" && (block.type === undefined || block.type === "text")) return block.text;
        }
        return "";
      })
      .filter((text) => text.trim())
      .join("\n");
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.parts)) return chatContentText(object.parts);
    if (typeof object.text === "string") return object.text;
    if (typeof object.content === "string" || Array.isArray(object.content)) return chatContentText(object.content);
  }
  return "";
}

/** 各种时间写法 → ISO。不带时区的按本地时间 (浏览器里就是用户自己的时区)。 */
export function chatNormalizeTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let numeric: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) numeric = value;
  if (typeof value === "string" && /^\d{9,13}(\.\d+)?$/.test(value.trim())) numeric = Number(value.trim());
  if (numeric !== null) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) || date.getFullYear() < 1990 ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/);
  if (match) {
    return new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).toISOString();
  }
  match = text.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})(?::(\d{2}))? ?([ap]m)?$/i);
  if (match) {
    const month = months.indexOf(match[1].slice(0, 3).toLowerCase());
    if (month >= 0) {
      let hour = +match[4];
      const meridiem = (match[7] || "").toLowerCase();
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      return new Date(+match[3], month, +match[2], hour, +match[5], +(match[6] || 0)).toISOString();
    }
  }
  match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[\sT]+(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?)?$/);
  if (match) {
    return new Date(+match[1], +match[2] - 1, +match[3], +(match[4] || 12), +(match[5] || 0), +(match[6] || 0)).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed) && /\d{4}/.test(text)) return new Date(parsed).toISOString();
  return null;
}

/** 说话人 → user / assistant；system、tool 之类返回 "skip"；认不出 (人名) 返回 null。 */
export function chatRoleOf(value: unknown): "user" | "assistant" | "skip" | null {
  let name = value;
  if (name && typeof name === "object") {
    const object = name as Record<string, unknown>;
    name = object.role ?? object.name ?? null;
  }
  if (typeof name !== "string") return null;
  const text = name.trim().toLowerCase();
  if (!text) return null;
  const users = ["user", "human", "you", "me", "you said", "我", "用户", "本人", "自己"];
  const assistants = ["assistant", "ai", "bot", "model", "char", "character", "chatgpt said", "助手", "机器人"];
  const assistantPrefixes = ["chatgpt", "gpt", "claude", "gemini", "kimi", "deepseek", "copilot", "grok", "qwen", "豆包", "小克"];
  const skips = ["system", "tool", "function", "developer", "系统"];
  if (users.indexOf(text) >= 0) return "user";
  if (assistants.indexOf(text) >= 0) return "assistant";
  if (skips.indexOf(text) >= 0) return "skip";
  for (const prefix of assistantPrefixes) {
    if (text.indexOf(prefix) === 0) return "assistant";
  }
  return null;
}

/** 一行开头的「时间 + 说话人」。返回 null 表示这行不像一条新消息。 */
export function chatSpeakerHead(line: string): { time: string | null; name: string; rest: string } | null {
  let rest = line.trim();
  let time: string | null = null;
  const timeRe =
    /^[[(（]?((?:\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?[\sT]*)?\d{1,2}[:：]\d{2}(?:[:：]\d{2})?)[\])）]?\s*/;
  const timeMatch = rest.match(timeRe);
  if (timeMatch) {
    time = timeMatch[1];
    rest = rest.slice(timeMatch[0].length);
  }
  const forms = [
    /^【([^】\n]{1,24})】\s*(.*)$/,
    /^\[([^\]\n]{1,24})\]\s*(.*)$/,
    /^\*\*([^*\n]{1,24})\*\*\s*[:：]\s*(.*)$/,
    /^((?:You|ChatGPT|Claude|Gemini) said)\s*[:：]\s*(.*)$/i,
    /^([^\s:：【】[\]()（）]{1,24}?)\s*[:：]\s*(.*)$/,
    /^([A-Za-z][\w.-]{0,15}(?: [A-Za-z][\w.-]{0,15}){0,2})\s*[:：]\s*(.*)$/
  ];
  for (const form of forms) {
    const match = rest.match(form);
    if (!match) continue;
    const name = match[1].trim();
    const body = match[2] || "";
    if (!name || /^\d+$/.test(name) || /^\/\//.test(body)) continue;
    if (/^\d{1,2}[:：]\d{2}/.test(name)) continue;
    return { time, name, rest: body };
  }
  // QQ / 微信导出：「2025-12-15 23:01:05 咲咲」一行，正文在下一行。
  if (time && /^[^\s:：]{1,24}$/.test(rest)) return { time, name: rest, rest: "" };
  return null;
}

/** 单独一行的日期 (小标题)：「## 2025-12-15」「2025年12月15日 星期一」「—— 2025/12/15 ——」 */
export function chatDateHeading(line: string): string | null {
  const text = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-—=*~\s]+|[-—=*~\s]+$/g, "");
  const match = text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*(?:[（(]?(?:星期|周|週)[一二三四五六日天][)）]?|[A-Za-z]{3,9})?$/);
  if (!match) return null;
  const month = +match[2];
  const day = +match[3];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function chatFromText(text: string): ParsedChat {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const counts = new Map<string, number>();
  for (const line of lines) {
    const head = chatSpeakerHead(line);
    if (head) counts.set(head.name, (counts.get(head.name) || 0) + 1);
  }
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const top = ranked.length > 0 ? ranked[0][1] : 0;
  const accepted = new Set<string>();
  for (const [name, count] of ranked) {
    const known = chatRoleOf(name) !== null;
    if (accepted.size >= 8 && !known) continue;
    if (known || (count >= 2 && count >= top * 0.05)) accepted.add(name);
  }
  // 一段很短的聊天里，有人只说了一句：凑不齐两个人时，只出现一次的名字也算。
  // 长聊天不这么做，正文里「注意：」「地址：」这种行会被当成换人说话。
  if (accepted.size < 2) {
    for (const [name] of ranked) {
      if (accepted.size >= 8) break;
      accepted.add(name);
    }
  }

  const messages: ChatMessage[] = [];
  let current: ChatMessage | null = null;
  let currentDate: string | null = null;
  let skipped = 0;
  const push = () => {
    if (current?.content.trim()) {
      current.content = current.content.replace(/\n{3,}/g, "\n\n").trim();
      messages.push(current);
    }
    current = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) (current as ChatMessage).content += "\n";
      continue;
    }
    const heading = chatDateHeading(trimmed);
    if (heading) {
      push();
      currentDate = heading;
      continue;
    }
    const head = chatSpeakerHead(trimmed);
    if (head && accepted.has(head.name)) {
      push();
      const role = chatRoleOf(head.name);
      if (role === "skip") {
        current = null;
        continue;
      }
      let time: string | null = null;
      if (head.time) {
        const full = /^\d{4}/.test(head.time) ? head.time : currentDate ? `${currentDate} ${head.time}` : null;
        time = full ? chatNormalizeTime(full) : null;
      }
      current = { role, speaker: head.name, content: head.rest, time, date: time ? null : currentDate };
      continue;
    }
    if (current) (current as ChatMessage).content += `${(current as ChatMessage).content ? "\n" : ""}${trimmed}`;
    else if (!/^#{1,6}\s/.test(trimmed) && !/^[-=*_]{3,}$/.test(trimmed)) skipped += 1;
  }
  push();
  const warnings: string[] = [];
  if (messages.length === 0) warnings.push("没认出谁说了什么。纯文本请写成「名字：内容」一行一条。");
  return { format: "text", messages, speakers: [], conversations: 1, skipped, warnings };
}

function chatPushMessage(
  out: ChatMessage[],
  input: { role: "user" | "assistant" | null; speaker: string | null; content: string; time: string | null }
): boolean {
  const content = input.content.replace(/\r\n?/g, "\n").trim();
  if (!content) return false;
  out.push({ role: input.role, speaker: input.speaker, content, time: input.time, date: null });
  return true;
}

export function chatFromChatGpt(conversations: unknown[]): { messages: ChatMessage[][]; skipped: number } {
  const result: ChatMessage[][] = [];
  let skipped = 0;
  for (const raw of conversations) {
    if (!raw || typeof raw !== "object") continue;
    const conversation = raw as Record<string, unknown>;
    const mapping = (conversation.mapping || {}) as Record<string, Record<string, unknown>>;
    const nodes: Array<Record<string, unknown>> = [];
    let nodeId = typeof conversation.current_node === "string" ? conversation.current_node : null;
    const seen = new Set<string>();
    while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
      seen.add(nodeId);
      nodes.push(mapping[nodeId]);
      nodeId = typeof mapping[nodeId].parent === "string" ? (mapping[nodeId].parent as string) : null;
    }
    if (nodes.length === 0) {
      for (const key of Object.keys(mapping)) nodes.push(mapping[key]);
      nodes.sort((a, b) => {
        const am = (a.message || {}) as Record<string, unknown>;
        const bm = (b.message || {}) as Record<string, unknown>;
        return Number(am.create_time || 0) - Number(bm.create_time || 0);
      });
    } else {
      nodes.reverse();
    }
    const messages: ChatMessage[] = [];
    for (const node of nodes) {
      const message = node.message as Record<string, unknown> | null | undefined;
      if (!message) continue;
      const author = (message.author || {}) as Record<string, unknown>;
      const role = chatRoleOf(author.role);
      const metadata = (message.metadata || {}) as Record<string, unknown>;
      const content = (message.content || {}) as Record<string, unknown>;
      const type = content.content_type;
      if (role !== "user" && role !== "assistant") continue;
      if (metadata.is_visually_hidden_from_conversation) continue;
      if (message.recipient && message.recipient !== "all") continue;
      if (type && type !== "text" && type !== "multimodal_text") {
        skipped += 1;
        continue;
      }
      const ok = chatPushMessage(messages, {
        role,
        speaker: null,
        content: chatContentText(content.parts || []),
        time: chatNormalizeTime(message.create_time) || chatNormalizeTime(conversation.create_time)
      });
      if (!ok) skipped += 1;
    }
    if (messages.length > 0) result.push(messages);
  }
  return { messages: result, skipped };
}

export function chatFromClaude(conversations: unknown[]): { messages: ChatMessage[][]; skipped: number } {
  const result: ChatMessage[][] = [];
  let skipped = 0;
  for (const raw of conversations) {
    if (!raw || typeof raw !== "object") continue;
    const conversation = raw as Record<string, unknown>;
    const items = Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [];
    const messages: ChatMessage[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const message = item as Record<string, unknown>;
      const role = chatRoleOf(message.sender);
      if (role !== "user" && role !== "assistant") continue;
      const fromBlocks = Array.isArray(message.content) ? chatContentText(message.content) : "";
      const ok = chatPushMessage(messages, {
        role,
        speaker: null,
        content: fromBlocks || chatContentText(message.text),
        time: chatNormalizeTime(message.created_at) || chatNormalizeTime(conversation.created_at)
      });
      if (!ok) skipped += 1;
    }
    if (messages.length > 0) result.push(messages);
  }
  return { messages: result, skipped };
}

/** 一条通用消息对象 → 消息。不像消息返回 undefined；像但是空的/系统的返回 null。 */
export function chatFromGenericItem(raw: unknown): ChatMessage | null | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const contentValue = item.content ?? item.text ?? item.mes ?? item.message ?? item.body ?? item.parts;
  const hasRole =
    "role" in item || "sender" in item || "author" in item || "from" in item || "is_user" in item || "name" in item || "speaker" in item;
  if (contentValue === undefined || !hasRole) return undefined;
  if (item.is_system === true) return null;
  let role: "user" | "assistant" | "skip" | null = null;
  let speaker: string | null = null;
  if (typeof item.is_user === "boolean") {
    role = item.is_user ? "user" : "assistant";
    speaker = typeof item.name === "string" ? item.name : null;
  } else {
    const who = item.role ?? item.sender ?? item.author ?? item.from ?? item.speaker ?? item.name;
    role = chatRoleOf(who);
    if (role === null) {
      const named = who && typeof who === "object" ? (who as Record<string, unknown>).name : who;
      speaker = typeof named === "string" ? named.trim() : null;
    }
  }
  if (role === "skip") return null;
  const content = chatContentText(contentValue).replace(/\r\n?/g, "\n").trim();
  if (!content) return null;
  const time = chatNormalizeTime(
    item.created_at ?? item.create_time ?? item.timestamp ?? item.time ?? item.date ?? item.send_date ?? item.createdAt ?? item.sent_at
  );
  return { role, speaker, content, time, date: null };
}

export function chatFromGeneric(items: unknown[]): { messages: ChatMessage[][]; skipped: number; recognized: boolean } {
  const result: ChatMessage[][] = [];
  let skipped = 0;
  let recognized = false;
  const loose: ChatMessage[] = [];
  for (const raw of items) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const object = raw as Record<string, unknown>;
      const nested = object.messages ?? object.chat_messages ?? object.conversation ?? object.chat;
      if (Array.isArray(nested)) {
        const inner = chatFromGeneric(nested);
        if (inner.recognized) {
          recognized = true;
          skipped += inner.skipped;
          for (const list of inner.messages) result.push(list);
          continue;
        }
      }
    }
    const message = chatFromGenericItem(raw);
    if (message === undefined) {
      skipped += 1;
      continue;
    }
    recognized = true;
    if (message === null) {
      skipped += 1;
      continue;
    }
    loose.push(message);
  }
  if (loose.length > 0) result.push(loose);
  return { messages: result, skipped, recognized };
}

/** 认格式并解析。fileName 只用来辅助判断。 */
export function parseChatExport(text: string, fileName?: string): ParsedChat {
  const source = String(text || "").replace(/^﻿/, "");
  const trimmed = source.trim();
  let format = "text";
  let groups: ChatMessage[][] = [];
  let skipped = 0;
  const warnings: string[] = [];

  let json: unknown;
  let jsonOk = false;
  if (/^[[{]/.test(trimmed)) {
    try {
      json = JSON.parse(trimmed);
      jsonOk = true;
    } catch {
      jsonOk = false;
    }
  }

  if (jsonOk) {
    const list = Array.isArray(json) ? json : [json];
    const first = list.find((item) => item && typeof item === "object") as Record<string, unknown> | undefined;
    if (first && "mapping" in first) {
      format = "chatgpt";
      const parsed = chatFromChatGpt(list);
      groups = parsed.messages;
      skipped = parsed.skipped;
    } else if (first && Array.isArray(first.chat_messages)) {
      format = "claude";
      const parsed = chatFromClaude(list);
      groups = parsed.messages;
      skipped = parsed.skipped;
    } else {
      format = "json";
      const parsed = chatFromGeneric(Array.isArray(json) ? json : [json]);
      groups = parsed.messages;
      skipped = parsed.skipped;
      if (!parsed.recognized) warnings.push("这份 JSON 里没找到聊天消息 (要有 role / sender 和 content / text)。");
    }
  } else if (/^[[{]/.test(trimmed) || /\.jsonl$/i.test(fileName || "")) {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    const items: unknown[] = [];
    let bad = 0;
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {
        bad += 1;
      }
    }
    if (items.length > 0 && bad <= Math.max(1, lines.length * 0.1)) {
      const head = items[0] as Record<string, unknown> | null;
      const isTavern = !!head && typeof head === "object" && ("user_name" in head || "character_name" in head) && !("mes" in head);
      format = isTavern ? "sillytavern" : "jsonl";
      const parsed = chatFromGeneric(isTavern ? items.slice(1) : items);
      groups = parsed.messages;
      skipped = parsed.skipped + bad;
      if (!parsed.recognized) warnings.push("这份 JSONL 里没找到聊天消息。");
    } else {
      const parsed = chatFromText(source);
      format = parsed.format;
      groups = [parsed.messages];
      skipped = parsed.skipped;
      for (const warning of parsed.warnings) warnings.push(warning);
    }
  } else {
    const parsed = chatFromText(source);
    groups = [parsed.messages];
    skipped = parsed.skipped;
    for (const warning of parsed.warnings) warnings.push(warning);
  }

  groups = groups.filter((group) => group.length > 0);
  let messages: ChatMessage[] = [];
  if (groups.length > 1) {
    // 好几段对话：按时间排到一起 (没时间的跟着前一条)，同一天的才切在一段里。
    const keyed: Array<{ key: string; index: number; message: ChatMessage }> = [];
    let index = 0;
    for (const [conversation, group] of groups.entries()) {
      let carry = "";
      for (const message of group) {
        carry = message.time || message.date || carry;
        keyed.push({ key: carry, index, message: { ...message, conversation: String(conversation) } });
        index += 1;
      }
    }
    keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1));
    messages = keyed.map((item) => item.message);
  } else {
    messages = groups[0] || [];
  }

  const counts = new Map<string, ChatSpeaker>();
  for (const message of messages) {
    if (!message.speaker) continue;
    const entry = counts.get(message.speaker) || { name: message.speaker, count: 0, role: message.role };
    entry.count += 1;
    counts.set(message.speaker, entry);
  }
  const speakers = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  return { format, messages, speakers, conversations: Math.max(groups.length, messages.length > 0 ? 1 : 0), skipped, warnings };
}

/** 页面上选好「哪几个名字是你」之后：这些名字算 user，其余没认出的名字算 assistant。 */
export function chatApplyRoles(messages: ChatMessage[], userSpeakers: string[]): ChatMessage[] {
  const users = new Set(userSpeakers);
  return messages.map((message) => {
    if (!message.speaker || !(users.has(message.speaker) || message.role === null)) return message;
    return { ...message, role: users.has(message.speaker) ? "user" : "assistant" };
  });
}

/** ISO 时间在某个时区是哪天。 */
export function chatDayLabel(iso: string, timeZone: string, format?: Intl.DateTimeFormat): string {
  const date = new Date(iso);
  try {
    const formatter = format ?? new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = formatter.formatToParts(date);
    const values: Record<string, string> = {};
    for (const part of parts) values[part.type] = part.value;
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * 按天切段：同一天的放一起，一段最多 maxMessages 条、maxChars 字，超了同一天再开一段。
 * 没时间的消息跟着前一条那天；整份都没时间的归到「nodate」，按顺序切。
 * key 是「那天#第几段」，同一份文件每次切出来都一样，断了能接着做。
 */
export function chatChunkByDay(
  messages: ChatMessage[],
  options: { timeZone: string; maxMessages?: number; maxChars?: number; keepConversations?: boolean }
): ChatChunk[] {
  const maxMessages = options.maxMessages || 60;
  const maxChars = options.maxChars || 30000;
  const chunks: ChatChunk[] = [];
  const perDay = new Map<string, number>();
  let formatter: Intl.DateTimeFormat | undefined;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { /* chatDayLabel falls back to UTC */ }
  let current: ChatChunk | null = null;
  let lastDay: string | null = null;
  let seq = 0;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const day: string | null = message.time ? chatDayLabel(message.time, options.timeZone, formatter) : message.date || lastDay;
    lastDay = day;
    const length = message.content.length;
    const fits =
      current !== null &&
      current.day === day &&
      current.messages.length < maxMessages &&
      (current.chars + length <= maxChars || current.messages.length === 0);
    if (!fits) {
      const base: string = day || "nodate";
      const count = (perDay.get(base) || 0) + 1;
      perDay.set(base, count);
      current = { key: `${base}#${count}`, day, messages: [], chars: 0 };
      chunks.push(current);
    }
    const target = current as ChatChunk;
    target.messages.push({ seq, role: message.role, content: message.content, time: message.time, speaker: message.speaker,
      ...(options.keepConversations && message.conversation !== undefined ? { conversation: message.conversation } : {}) });
    target.chars += length;
    seq += 1;
  }
  return chunks;
}

// 后台页面在浏览器里要用的函数。搬过去的是编译后的函数源码 (Function.prototype.toString)。
export const CHAT_PARSE_FUNCTIONS = [
  chatContentText,
  chatNormalizeTime,
  chatRoleOf,
  chatSpeakerHead,
  chatDateHeading,
  chatFromText,
  chatPushMessage,
  chatFromChatGpt,
  chatFromClaude,
  chatFromGenericItem,
  chatFromGeneric,
  parseChatExport,
  chatApplyRoles,
  chatDayLabel,
  chatChunkByDay
];

/** 函数源码里声明的名字。打包时可能被改名 (跟别的模块撞名会加数字)，fn.name 又被保留成原名，所以从源码里读。 */
function declaredName(fn: (...args: never[]) => unknown): string {
  const match = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(fn.toString());
  return match ? match[1] : fn.name;
}

/**
 * 给后台页面的 <script> 用：这些函数的源码拼在一起，最后挂一个 window.AeliosChat 给页面调。
 * - wrangler 打包默认保留函数名，会在函数体里插 __name(...) 调用，浏览器里没有这个助手，先垫一个空的。
 * - 「</」换成「<\/」：这段要嵌进 HTML 的 <script> 里，不能提前把标签关掉。
 */
export function chatParseBrowserScript(): string {
  const exported = { parseChatExport, chatApplyRoles, chatChunkByDay, chatDayLabel };
  const table = Object.entries(exported)
    .map(([name, fn]) => `${name}: ${declaredName(fn as (...args: never[]) => unknown)}`)
    .join(", ");
  return [
    "(function () {",
    "var __name = function (fn) { return fn; };",
    ...CHAT_PARSE_FUNCTIONS.map((fn) => fn.toString()),
    `window.AeliosChat = { ${table} };`,
    "})();"
  ]
    .join("\n")
    .replace(/<\//g, "<\\/");
}
