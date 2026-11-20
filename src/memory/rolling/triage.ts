import type { RollingPacket } from "./payload";

export interface TriageAnswers {
  novel: number;
  covered?: number;
  changesRecalled?: number;
  decision: number;
}

export interface WindowTriage {
  classify(packet: RollingPacket): Promise<TriageAnswers | null>;
}

export function needsExtraction(
  answers: TriageAnswers | null,
  explicitCue: boolean,
): boolean {
  if (explicitCue) return true;
  if (!answers) throw new Error("Rolling triage failed");
  return (
    answers.decision >= 0.5 ||
    (answers.changesRecalled ?? 0) >= 0.5 ||
    (answers.novel >= 0.5 && (answers.covered ?? 0) < 0.7)
  );
}
