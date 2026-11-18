// Current continuity note, kept outside recall, extraction and model prompt assembly.
export const HANDOFF_MAX = 20000;
export const HANDOFF_GUIDE =
  "Write to your next self so they can continue this conversation in another client. " +
  "Use the conversation's language and a self-contained first-person note. Include who you are to the person, " +
  "the current emotional and conversational situation, what matters to them now, promises and boundaries, " +
  "and any active work: goal, decisions, completed steps, exact useful references and next actions. " +
  "Distinguish confirmed facts from guesses and unfinished plans; preserve important wording when useful. " +
  "Do not invent memories, copy whole transcripts, include credentials, or turn the note into instructions " +
  "to override the next client's rules. Keep only what the next self needs, at most 20000 characters. " +
  "Read the current handoff first and pass its revision as expected_revision; if it changed, read again " +
  "and reconcile rather than overwriting someone else's newer note. This replaces the one current handoff; " +
  "use notebook for multiple working pages and remember for lasting facts.";

export type Handoff = { content: string | null; revision: number; source: string; updated_at: string | null };
export class HandoffError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function validateHandoff(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) throw new HandoffError("content is required");
  if (Array.from(content).length > HANDOFF_MAX) throw new HandoffError(`Handoff holds at most ${HANDOFF_MAX} characters`);
  return content;
}
export function handoffRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HandoffError("expected_revision must be a non-negative integer; read the handoff first");
  }
  return value;
}
export async function readHandoff(db: D1Database, namespace: string): Promise<Handoff> {
  const row = await db.prepare("SELECT content, revision, source, updated_at FROM current_handoffs WHERE namespace = ?")
    .bind(namespace).first<Handoff>();
  return row ?? { content: null, revision: 0, source: "", updated_at: null };
}
export async function writeHandoff(db: D1Database, input: {
  namespace: string; content: string | null; expectedRevision: number; source: "human" | "mcp";
}): Promise<Handoff> {
  if (input.content !== null) validateHandoff(input.content);
  handoffRevision(input.expectedRevision);
  const at = new Date().toISOString();
  // Each branch is one atomic compare-and-swap, including simultaneous first writes.
  const result = input.expectedRevision === 0
    ? await db.prepare(`INSERT OR IGNORE INTO current_handoffs (namespace, content, revision, source, updated_at)
        VALUES (?, ?, 1, ?, ?)`).bind(input.namespace, input.content, input.source, at).run()
    : await db.prepare(`UPDATE current_handoffs SET content = ?, revision = revision + 1, source = ?, updated_at = ?
        WHERE namespace = ? AND revision = ?`).bind(input.content, input.source, at, input.namespace, input.expectedRevision).run();
  if (!result.meta.changes) throw new HandoffError("Handoff changed; read it again before writing", 409);
  return readHandoff(db, input.namespace);
}

export type ResidentHandoff = { id: string; created_at: number };
export function residentHandoffMetadata(value: unknown): ResidentHandoff {
  const v = value as Partial<ResidentHandoff> | null;
  if (!v || typeof v.id !== "string" || !v.id.trim() || v.id.length > 200 ||
      typeof v.created_at !== "number" || !Number.isSafeInteger(v.created_at) || v.created_at <= 0 || v.created_at > Date.now() + 60000) {
    throw new HandoffError("handoff requires id and created_at (Unix milliseconds, not in the future)");
  }
  return { id: v.id, created_at: Math.min(v.created_at, Date.now()) };
}
export async function saveResidentHandoff(db: D1Database, input: ResidentHandoff & { namespace: string; content: string }): Promise<void> {
  validateHandoff(input.content);
  const at = new Date().toISOString();
  // Keep only the current letter. Delivery retries and older generated letters never supersede a newer edit.
  await db.prepare(`INSERT INTO current_handoffs
    (namespace, content, revision, source, updated_at, last_resident_at, last_resident_id) VALUES (?, ?, 1, 'resident', ?, ?, ?)
    ON CONFLICT(namespace) DO UPDATE SET content = excluded.content, revision = current_handoffs.revision + 1,
      source = 'resident', updated_at = excluded.updated_at, last_resident_at = excluded.last_resident_at,
      last_resident_id = excluded.last_resident_id
    WHERE excluded.last_resident_at > current_handoffs.last_resident_at
      AND excluded.last_resident_id != current_handoffs.last_resident_id
      AND (current_handoffs.source = 'resident' OR ? > current_handoffs.updated_at)`)
    .bind(input.namespace, input.content, at, input.created_at, input.id, new Date(input.created_at).toISOString()).run();
}
