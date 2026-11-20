import type { DatabaseSync } from "node:sqlite";
import type { RollingPacket } from "../../src/memory/rolling/payload";
import type { WindowProposal } from "../../src/memory/rolling/extract";

export const SYNTHETIC_DAY = "2026-11-17";
export const SYNTHETIC_AT = `${SYNTHETIC_DAY}T10:00:00.000Z`;
export const NOVEL = { novel: 0.9, decision: 0 };
export const ORDINARY = { novel: 0.1, decision: 0 };

export function insertLine(
  sqlite: DatabaseSync, id: string, content: string,
  { namespace = "default", role = "user", at = SYNTHETIC_AT, source = "mcp", capture = null, model = null }:
    { namespace?: string; role?: string; at?: string; source?: string; capture?: string | null; model?: string | null } = {}
): void {
  sqlite.prepare(`INSERT INTO messages
    (id,conversation_id,namespace,role,content,created_at,source,capture_kind,request_model)
    VALUES(?,'synthetic',?,?,?,?,?,?,?)`)
    .run(id, namespace, role, content, at, source, capture, model);
}

export function seedAffectionateDialogue(sqlite: DatabaseSync, capture?: () => void): void {
  for (let index = 0; index < 200; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    const content = index === 0 ? "Let's call our nightly check-in Moon Post."
      : index === 180 ? "From now on, Sunday is our longer check-in."
        : role === "user" ? "I liked hearing about your day. Tell me more when you feel like it."
          : "That was my favorite part too. I'm glad we had a little time to talk.";
    insertLine(sqlite, `chat_${index}`, content, { role });
    capture?.();
  }
}

export function episodeProposal(packet: RollingPacket): WindowProposal {
  const selected = packet.messages.find(item => item.id === "chat_0" || item.id === "chat_180");
  if (!selected) return { events: [], state_delta: {} };
  const key = "moon-post";
  return {
    events: [{
      op: packet.rolling_state.episodes.some(item => item.key === key) ? "continuation" : "new",
      episode_key: key, type: "event", attributed_role: "user", content: selected.content,
      evidence_ids: [selected.id], evidence_quote: selected.content
    }],
    state_delta: { episodes: [{ key, label: "Moon Post check-ins", last_seq: 0, evidence_ids: [selected.id] }] }
  };
}
