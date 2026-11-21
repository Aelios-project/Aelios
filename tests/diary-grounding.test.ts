import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatBootStable } from "../src/assembler/types";
import { buildDiaryWriterPrompt, normalizeDiaryWriterResult } from "../src/memory/diaryWriter";
import { buildWeeklyRollupPrompt } from "../src/memory/weeklyRollup";
import { buildMonthlyRollupPrompt } from "../src/memory/monthlyRollup";
import { groundedSourceIds, IMPRESSION_DISCLAIMER } from "../src/memory/impression";

test("diary prompt forbids invented specifics and requires source ids", () => {
  const prompt = buildDiaryWriterPrompt({
    dateLabel: "2026-08-27",
    messages: [{
      id: "msg_1",
      conversation_id: "c1",
      namespace: "partner-a",
      role: "user",
      content: "今天有点累",
      source: "chat",
      created_at: "2026-08-27T12:00:00.000Z"
    }],
    existingDraft: null
  });
  assert.match(prompt, /source_message_ids/);
  assert.match(prompt, /unsupported by the transcript/);
  assert.match(prompt, /complaining after work in the evening/);
  assert.match(prompt, /Write in first person \(I\) for the assistant/);
  assert.doesNotMatch(prompt, /具体细节优先于抽象概括/);
  assert.doesNotMatch(prompt, /古法PPT/);
});

test("named speakers replace 用户/助手 in the diary prompt", () => {
  const prompt = buildDiaryWriterPrompt({
    dateLabel: "2026-08-27",
    messages: [{
      id: "msg_1",
      conversation_id: "c1",
      namespace: "default",
      role: "user",
      content: "今天有点累",
      source: "chat",
      created_at: "2026-08-27T12:00:00.000Z"
    }],
    existingDraft: null,
    speakers: { userName: "小南", assistantName: "小北" }
  });
  assert.match(prompt, /the user is 小南, and the assistant is 小北/);
  assert.match(prompt, /\[msg_1\].*\[小南\]/);
  assert.match(prompt, /小南 seemed tired today/);
  assert.doesNotMatch(prompt, /Write in first person \(I\) for the assistant/);
});

test("claimed source ids that are not in the day's transcript are dropped", () => {
  assert.deepEqual(
    groundedSourceIds(["msg_1", "msg_fake", "msg_1"], ["msg_1", "msg_2"]),
    ["msg_1"]
  );
  assert.deepEqual(groundedSourceIds(["msg_fake"], ["msg_1"]), []);
});

test("diary JSON keeps title/summary and reads source_message_ids", () => {
  const parsed = normalizeDiaryWriterResult({
    title: "有点累",
    summary: "她今天显得累。",
    source_message_ids: ["msg_1", ""]
  });
  assert.equal(parsed?.title, "有点累");
  assert.deepEqual(parsed?.source_message_ids, ["msg_1"]);
});

test("named speakers replace 用户/助手 in weekly and monthly rollups", () => {
  const speakers = { userName: "小南", assistantName: "小北" };
  const weekly = buildWeeklyRollupPrompt({
    week: "2026-W36",
    startDate: "2026-08-31",
    endDate: "2026-09-06",
    dailyLogs: [{ date: "2026-09-01", title: "累", summary: "小南有点累。" }],
    speakers
  });
  assert.match(weekly, /the user is 小南, and the assistant is 小北/);
  assert.doesNotMatch(weekly, /use second person for the user/);
  const monthly = buildMonthlyRollupPrompt({
    month: "2026-09",
    weeklyLogs: [{ week: "2026-W36", title: "一周", summary: "还好。" }],
    speakers
  });
  assert.match(monthly, /Never use generic labels like user\/assistant/);
  assert.doesNotMatch(monthly, /use second person for the user/);
});

test("boot impressions carry the issue #35 disclaimer", () => {
  const text = formatBootStable({
    impressions: {
      daily: { label: "2026-08-27", title: "昨日", summary: "聊了缓存" },
      weekly: null,
      monthly: null,
      max_chars: 1000
    },
    precious: [],
    glossary: [],
    schema_version: "v3-1",
    cache_prefix_end: true
  });
  assert.match(text, new RegExp(IMPRESSION_DISCLAIMER));
  assert.match(text, /聊了缓存/);
});
