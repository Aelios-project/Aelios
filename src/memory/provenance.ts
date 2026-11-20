import type { KeyProfile } from "../types";

// Only the writing entry point constructs this object. The public source/author
// strings can both be supplied by a client and cannot establish identity.
export interface MemoryProvenance {
  creation_mode: "agent_explicit" | "user_explicit" | "dream_derived" | "imported" | "unknown";
  recording_actor: string;
  credential_namespace?: string;
  claimed_author?: string;
  attributed_actor: "user" | "assistant" | "tool" | "unknown";
  evidence_relation: "verbatim" | "paraphrase" | "interpretation" | "unknown";
  completeness: "partial" | "unknown";
  // Only cited inputs can revoke a record. Read-only context is audit data.
  inputs?: string[];
  context_refs?: string[];
  candidate_id?: string;
}

export function explicitWrite(
  profile: KeyProfile,
  channel: "rest" | "mcp",
  signature?: string | null,
): MemoryProvenance {
  return {
    creation_mode: channel === "mcp" ? "agent_explicit" : "unknown",
    ...(profile.chooseNamespace ? {} : { credential_namespace: profile.namespace }),
    ...(signature ? { claimed_author: signature } : {}),
    recording_actor: `${channel}:${profile.source}`,
    attributed_actor: "unknown",
    evidence_relation: "unknown",
    completeness: "unknown",
  };
}

export function dreamOrigin(
  cited: string[],
  context: { messages?: string[]; memories?: string[]; dates?: string[]; candidates?: string[]; target?: string } = {}
): MemoryProvenance {
  const inputs = new Set(cited.map(id => `message:${id}`));
  if (context.target) inputs.add(`memory:${context.target}`);
  const seen = [
    ...(context.messages ?? []).map(id => `message:${id}`),
    ...(context.memories ?? []).map(id => `memory:${id}`),
    ...(context.dates ?? []).map(id => `day:${id}`),
    ...(context.candidates ?? []).map(id => `candidate:${id}`)
  ];
  return {
    creation_mode: "dream_derived",
    recording_actor: "dream",
    attributed_actor: "unknown",
    evidence_relation: "interpretation",
    completeness: "partial",
    inputs: [...inputs],
    context_refs: [...new Set(seen.filter(ref => !inputs.has(ref)))]
  };
}

export const importOrigin: MemoryProvenance = {
  creation_mode: "imported",
  recording_actor: "import",
  attributed_actor: "unknown",
  evidence_relation: "unknown",
  completeness: "unknown",
};

export function parseOrigin(value?: string | null): MemoryProvenance | undefined {
  return value ? (JSON.parse(value) as MemoryProvenance) : undefined;
}

/** Historical signatures also protect a note from automatic rewriting. */
export function isExplicitMemory(row: {source?: string | null; authored_by?: string | null; provenance?: string | MemoryProvenance | null}): boolean {
  const origin = typeof row.provenance === "string" ? parseOrigin(row.provenance) : row.provenance;
  return Boolean(row.authored_by || row.source === "mcp" || row.source === "remember_now" ||
    origin?.creation_mode === "agent_explicit" || origin?.creation_mode === "user_explicit");
}

export function reviewedOrigin(
  candidate: { id: string; source: string; target_memory_id?: string | null; provenance?: string | null },
  reviewer: string,
  edited = false,
): MemoryProvenance {
  const origin =
    parseOrigin(candidate.provenance) ??
    (candidate.source.startsWith("import_")
      ? importOrigin
      : ({
          creation_mode: "unknown",
          attributed_actor: "unknown",
          evidence_relation: "unknown",
          completeness: "unknown",
        } as const));
  return {
    ...origin,
    ...(candidate.source === "dream_update" && candidate.target_memory_id
      ? {inputs:[...new Set([...("inputs" in origin ? origin.inputs ?? [] : []), `memory:${candidate.target_memory_id}`])]} : {}),
    recording_actor: reviewer,
    candidate_id: candidate.id,
    ...(edited ? ({ attributed_actor: "unknown", evidence_relation: "interpretation" } as const) : {}),
  };
}
