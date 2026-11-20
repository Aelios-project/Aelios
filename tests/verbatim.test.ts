import { strict as assert } from "node:assert";
import { test } from "node:test";
import { copiesSourceText } from "../src/memory/verbatim";

test("a copy survives reflowed punctuation, spacing and case", () => {
  assert.ok(copiesSourceText("她说：「我决定，改回 ACP」", "我决定改回acp。"));
  assert.ok(copiesSourceText("Quoted: we will Ship The Gateway On Friday!", "We will ship the gateway on friday"));
});

test("shared vocabulary is not a copy, and short or generic lines never count", () => {
  assert.equal(copiesSourceText("项目改用 ACP 协议接入", "我决定改回 ACP。"), false);
  assert.equal(copiesSourceText("她回了一句好的", "好的"), false);
  assert.equal(copiesSourceText("", "我决定改回 ACP。"), false);
});
