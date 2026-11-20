import type { Env, MessageRecord } from "../../types";
import { isExplicitDecisionText } from "../currentState/decisionCues";
import { DreamModelTimeoutError } from "../dream/modelCall";
import { groundWindowProposal } from "./apply";
import { finishRollingWindow, releaseInterruptedWindow, saveRollingDraft, saveRollingProgress, saveShadowPart } from "./checkpoint";
import { dreamWindowExtractor, type WindowExtractor } from "./extract";
import { claimRollingWindow, type RollingClaim } from "./inbox";
import { commitRollingDrafts } from "./live";
import { rollingExplicitWrites, rollingRecallHits, type RollingPacket } from "./payload";
import { activeRollingLane, rollingSettings, type RollingLane } from "./settings";
import { applyStateDelta, loadRollingState } from "./state";
import { needsExtraction, type WindowTriage } from "./triage";
import { clefTriage } from "./triage/clef";
import { splitMessage } from "./window";

export interface RollingRunResult {
  ran: boolean;
  windowKey?: string;
  extracted: boolean;
  reason?: string;
  retryAfter?: number;
}

interface RollingAdapters {
  triage?: WindowTriage;
  extractor?: WindowExtractor;
}

class RollingStageError extends Error {}

async function preparePacket(env: Env, claim: RollingClaim, adapters: RollingAdapters): Promise<RollingPacket | null> {
  const { namespace, lane, key, rows, progress } = claim;
  const [snapshot, recallHits, explicitWrites] = await Promise.all([
    loadRollingState(env, namespace, lane),
    rollingRecallHits(env, namespace, rows),
    rollingExplicitWrites(env, namespace, rows)
  ]);
  const packet: RollingPacket = {
    window: { key, from_seq: rows[0].inbox_seq, to_seq: rows[rows.length - 1].inbox_seq },
    rolling_state: snapshot.state,
    messages: rows,
    recall_hits: recallHits,
    explicit_writes: explicitWrites
  };
  if (progress.extract !== undefined) return packet;

  const cue = rows.some((message) => message.role === "user" && isExplicitDecisionText(message.content));
  const budget = Math.min(progress.chars, 8000);
  let remaining = budget;
  const transcript = rows.flatMap((message) => {
    if (remaining <= 0) return [];
    const prefix = message.chars <= remaining ? message : splitMessage(message, remaining)[0];
    remaining -= prefix.chars;
    return [prefix];
  });
  progress.clefCalls += 1;
  progress.triage = await (adapters.triage ?? clefTriage(env)).classify({ ...packet, messages: transcript }).catch(() => null);
  if (!progress.triage && !cue) throw new RollingStageError("triage_failed");
  progress.extract = needsExtraction(progress.triage, cue);
  return await saveRollingProgress(env.DB, claim) ? packet : null;
}

async function processParts(env: Env, claim: RollingClaim, packet: RollingPacket, extractor: WindowExtractor): Promise<void> {
  const { namespace, lane, key, rows, progress } = claim;
  if (!progress.extract) return;
  const parts = rows.length === 1 ? splitMessage(rows[0], progress.chars).map(row => [row]) : [rows];
  for (const [index, messages] of parts.entries()) {
    const partKey = String(index);
    if (progress.completed.includes(partKey)) continue;
    const snapshot = await loadRollingState(env, namespace, lane);
    const input = { ...packet, rolling_state: snapshot.state, messages };
    progress.extractorCalls += 1;
    const proposal = await extractor.extract(input);
    if (!proposal) throw new RollingStageError("extraction_failed");
    const grounded = groundWindowProposal(input, proposal);
    const state = applyStateDelta(snapshot.state, grounded.state_delta, `${key}:${partKey}`, rollingSettings(env).stateChars);
    const count = grounded.events.filter(event => event.op !== "no_op").length;
    progress.eventCount += count;
    progress.completed.push(partKey);
    try {
      const saved = lane === "shadow"
        ? await saveShadowPart(env.DB, claim, index, grounded, { ...snapshot, state })
        : await saveRollingDraft(env.DB, claim, { part: index, grounded, recall_ids: packet.recall_hits.map(hit => hit.id) });
      if (!saved) {
        throw new RollingStageError("lease_changed");
      }
    } catch (error) {
      progress.completed.pop();
      progress.eventCount -= count;
      throw error;
    }
  }
}

export async function runRollingWindow(
  env: Env,
  namespace: string,
  adapters: RollingAdapters = {}
): Promise<RollingRunResult> {
  const lane = activeRollingLane(env);
  if (!lane) return { ran: false, extracted: false, reason: "off" };
  return runLane(env, namespace, lane, adapters);
}

async function runLane(env: Env, namespace: string, lane: RollingLane, adapters: RollingAdapters, resumeKey?: string): Promise<RollingRunResult> {
  const { claim, retryAfter } = await claimRollingWindow(env, namespace, lane, resumeKey);
  if (!claim) return { ran: false, extracted: false, reason: retryAfter ? "busy" : "no_window", retryAfter };
  const { key, attempts, progress } = claim;
  const maxAttempts = rollingSettings(env).maxAttempts;
  try {
    if (attempts > maxAttempts) throw new RollingStageError("attempts_exhausted");
    if (!progress.committing) {
      const packet = await preparePacket(env, claim, adapters);
      if (!packet) throw new RollingStageError("lease_changed");
      await processParts(env, claim, packet, adapters.extractor ?? dreamWindowExtractor(env, namespace, progress.model));
      if (lane === "on" && progress.extract) {
        progress.committing = true;
        if (!await saveRollingProgress(env.DB, claim)) throw new RollingStageError("lease_changed");
      }
    }
    const finished = progress.committing ? await commitRollingDrafts(env, claim) : await finishRollingWindow(env.DB, claim);
    if (!finished) throw new RollingStageError("lease_changed");
    return { ran: true, windowKey: key, extracted: progress.extract === true };
  } catch (error) {
    const reason = error instanceof RollingStageError ? error.message
      : error instanceof DreamModelTimeoutError ? "extractor_timeout" : "window_processing_failed";
    console.warn("rolling: window attempt failed", { namespace, window: key, attempt: attempts, reason });
    if (attempts >= maxAttempts && reason !== "lease_changed" && await finishRollingWindow(env.DB, claim, reason)) {
      return { ran: true, windowKey: key, extracted: false, reason };
    }
    const released = await saveRollingProgress(env.DB, claim, true) || await releaseInterruptedWindow(env.DB, claim);
    return {
      ran: true, windowKey: key, extracted: false, reason,
      ...(released ? { retryAfter: Math.min(60, 2 ** attempts) } : {})
    };
  }
}

/** Nightly reconciles a previously started live commit before taking unfinished messages. */
export async function recoverRollingCommit(env: Env, namespace: string, messages: MessageRecord[]): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT window_key FROM rolling_inbox
    WHERE namespace=? AND done_at IS NULL AND window_key GLOB 'rolling_*'
      AND json_extract(progress,'$.committing')=1 AND message_id IN (SELECT value FROM json_each(?))
    LIMIT 1`).bind(namespace, JSON.stringify(messages.map(message => message.id))).first<{ window_key: string }>();
  if (!row) return false;
  const result = await runLane(env, namespace, "on", {}, row.window_key);
  return result.ran;
}
