import { groundCandidate } from "../grounding";
import type { RollingPacket } from "./payload";
import type { WindowEvent, WindowProposal } from "./extract";
import type { StateDelta } from "./state";
import { decisionKey } from "../currentState/scopeKey";

export interface GroundedWindowEvent extends WindowEvent {
  source_message_ids: string[];
  reason?: "explicit_write" | "protected_target";
}

export interface GroundedWindow {
  events: GroundedWindowEvent[];
  state_delta: StateDelta;
}

function groundedStateDelta(
  packet: RollingPacket,
  delta: WindowProposal["state_delta"],
  events: GroundedWindowEvent[]
): StateDelta {
  const sources = new Map(packet.messages.map(message => [message.id, message.message_id ?? message.id]));
  const grounded = new Set(events.filter(event => event.op !== "no_op").flatMap(event => event.evidence_ids));
  const cited = (ids: string[]) => !ids.length || ids.some(id => !grounded.has(id))
    ? []
    : [...new Set(ids.map(id => sources.get(id) ?? id))];
  const topics = new Set([...packet.rolling_state.episodes.map(item => item.key), ...packet.rolling_state.open.map(item => item.label)]);
  return {
    episodes: delta.episodes?.flatMap((episode) => {
      const evidenceIds = cited(episode.evidence_ids);
      if (!evidenceIds.length || !events.some(event => event.op !== "no_op" && event.episode_key === episode.key)) return [];
      return [{ key: episode.key, label: episode.label, last_seq: packet.window.to_seq, evidence_ids: evidenceIds }];
    }),
    open: delta.open?.flatMap((item) => {
      const evidenceIds = cited(item.evidence_ids);
      return evidenceIds.length ? [{ ...item, evidence_ids: evidenceIds }] : [];
    }),
    close: delta.close?.filter((key) => topics.has(key)),
  };
}

const comparable = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]/gu, "");

export function groundWindowProposal(
  packet: RollingPacket,
  proposal: WindowProposal,
): GroundedWindow {
  const recalled = new Map(packet.recall_hits.map((hit) => [hit.id, hit]));
  const messages = new Map(packet.messages.map((message) => [message.id, message]));
  const events = proposal.events.flatMap((event): GroundedWindowEvent[] => {
    const evidenceIds = [...new Set(event.evidence_ids)];
    if (!evidenceIds.length || evidenceIds.some((id) => !messages.has(id)) || !event.attributed_role || !event.evidence_quote) return [];
    const target = event.target_memory_id ? recalled.get(event.target_memory_id) : undefined;
    if (event.op === "update" && !target) return [];
    const evidence = evidenceIds.flatMap((id) => {
      const message = messages.get(id);
      return message ? [message] : [];
    });
    const candidate = {
      type: event.type,
      content: event.content,
      source_message_ids: evidenceIds,
      attributed_role: event.attributed_role,
      evidence_quote: event.evidence_quote,
      confidence: 0.8,
      importance: 0.6,
      tags: [],
    };
    const [checked] = groundCandidate(candidate, evidence);
    if (!checked) return [];
    const sourceIds = [...new Set(checked.source_message_ids.map(id => messages.get(id)?.message_id ?? id))];
    const content = comparable(event.content);
    const quote = event.evidence_quote;
    const duplicate = packet.explicit_writes.some((item) =>
      (content && comparable(item.content) === content)
      || (item.source_message_ids.some(id => sourceIds.includes(id)) && item.content.includes(quote))
    );
    const decision = event.type === "decision" && event.attributed_role === "user" && event.decision && decisionKey(event.decision.scope_key)
      ? { ...event.decision, state_of: event.decision.state_of.filter(id => recalled.has(id)) }
      : undefined;
    const reason = duplicate ? "explicit_write"
      : target && (target.protected || target.status !== "active" || target.version_status === "superseded") && !decision
        ? "protected_target" : undefined;
    return [{
      ...event,
      op: reason ? "no_op" : event.op,
      reason,
      target_memory_id: event.op === "update" ? target?.id : undefined,
      source_message_ids: sourceIds,
      evidence_ids: checked.source_message_ids,
      decision,
    }];
  });
  return { events, state_delta: groundedStateDelta(packet, proposal.state_delta, events) };
}
