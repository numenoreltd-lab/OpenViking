/**
 * Shared OpenViking HTTP + transcript helpers for the Codex capture hooks.
 *
 * Stop (auto-capture), PreCompact and SessionEnd all do the same three things:
 * talk to the OV session API with the plugin's headers, parse the JSONL
 * rollout at `transcript_path`, and append everything past the state cursor.
 * This module owns that logic so the three hooks cannot drift apart.
 *
 * Codex-local on purpose: it depends on Codex rollout shapes and on
 * `session-state.mjs`, so it does not belong under `scripts/shared/`.
 */

import { extractCaptureTranscript, findLastHumanTurnIndex } from "./capture-utils.mjs";
import { CAPTURE_FORMAT_VERSION, resolveOvSessionId, saveState } from "./session-state.mjs";
import { makeAgentFetchJSON } from "./shared/agent-hook-runtime.mjs";
import { sendSessionMessages } from "./shared/batch-send.mjs";
import { readJsonlRecords } from "./shared/jsonl-file.mjs";

/**
 * Build the `{ fetchJSONRes, fetchJSON }` pair used by every capture hook.
 * The peer id is read through a getter because callers only know it after
 * loading state (which happens under the session lock).
 */
export function makeFetchJSON(cfg, { getActorPeerId = () => "" } = {}) {
  const { fetchJSON: fetchJSONRes } = makeAgentFetchJSON(cfg, process.cwd(), {
    defaultTimeoutMs: cfg.captureTimeoutMs,
    getActorPeerId,
    // A capture hook would rather retry a body it cannot parse than record the
    // turn as sent.
    requireJsonBody: true,
  });

  async function fetchJSON(path, init = {}) {
    const r = await fetchJSONRes(path, init);
    return r.ok ? (r.result ?? null) : null;
  }

  return { fetchJSONRes, fetchJSON };
}

export function commitOvSession(fetchJSONRes, ovSessionId, body = {}) {
  return fetchJSONRes(`/api/v1/sessions/${encodeURIComponent(ovSessionId)}/commit`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Rollout records nothing in capture-utils reads. A long thread re-records its
// whole history on every compaction, so these are most of its bytes; dropping
// them before JSON.parse keeps a multi-GB rollout readable. Codex writes
// `timestamp` then `type` first; a line in any other shape is simply parsed.
const UNCAPTURED_ROLLOUT_LINE =
  /^\{"timestamp":"[^"]*","type":"(?:compacted|world_state|token_usage_record|event_msg","payload":\{"type":"token_count)"/;

function isUncapturedRolloutLine(head) {
  return UNCAPTURED_ROLLOUT_LINE.test(head);
}

/**
 * Read and normalize the rollout at `transcriptPath`.
 *
 * `ok` distinguishes "read it, it has N turns" from "could not read it".
 * Callers must not treat `ok: false` as a transcript shrink — resetting the
 * cursor on a transient read error replays the whole session.
 */
export async function readTranscriptTurns(transcriptPath, cfg, logError) {
  if (!transcriptPath) return { turns: [], excludedLegacyTurnIndices: [], ok: false };
  try {
    const entries = await readJsonlRecords(transcriptPath, { skipLine: isUncapturedRolloutLine });
    if (!entries.length) return { turns: [], excludedLegacyTurnIndices: [], ok: true };
    return { ...extractCaptureTranscript(entries, cfg), ok: true };
  } catch (err) {
    logError?.("transcript_read", err);
    return { turns: [], excludedLegacyTurnIndices: [], ok: false };
  }
}

export function hasCaptureKeyword(turns) {
  return turns.some((turn) =>
    /\b(remember|memorize|store|save|capture|note|record)\b|记住|保存|记录|记忆/i.test(turn.text)
  );
}

/**
 * Append every transcript turn past `state.capturedTurnCount`.
 *
 * Advances the cursor (and persists it) after each durably sent batch, so a
 * failure halfway through never replays what already landed. Mutates `state`;
 * the caller owns the session lock.
 *
 * `shouldSend(newTurns)` lets a caller veto the send (keyword capture mode)
 * without disturbing the cursor.
 *
 * Returns `{ newTurns, added, ovSessionId, skipped, unreadable }`. `unreadable`
 * separates "the transcript is empty" from "the transcript could not be read":
 * committing on the latter would archive a session whose tail turns were never
 * seen, so callers must keep the session live instead.
 */
export async function catchUpTurns({
  state,
  transcriptPath,
  fetchJSONRes,
  activePeerId = "",
  cfg,
  log,
  logError,
  heartbeat,
  shouldSend,
}) {
  // Remember the rollout path so the SessionStart sweep can catch up turns for
  // a session whose Stop/SessionEnd workers never ran.
  if (transcriptPath) state.transcriptPath = transcriptPath;

  const { turns, excludedLegacyTurnIndices, ok } = await readTranscriptTurns(transcriptPath, cfg, logError);

  if (ok && state.captureFormatVersion !== CAPTURE_FORMAT_VERSION) {
    const oldCursor = Math.max(0, Number(state.capturedTurnCount) || 0);
    state.capturedTurnCount = oldCursor - excludedLegacyTurnIndices.filter((index) => index < oldCursor).length;
    state.captureFormatVersion = CAPTURE_FORMAT_VERSION;
    // The caller holds the session lock. Persist the corrected cursor before
    // any append; a failed send must retry from this new coordinate system.
    await saveState(state, { touch: false });
    log?.("capture_format_migrated", {
      oldCursor,
      correctedCursor: state.capturedTurnCount,
      excludedLegacyTurnIndices,
    });
  }

  if (!ok || turns.length === 0) {
    log?.("transcript_empty", {
      readable: ok,
      previouslyCaptured: state.capturedTurnCount,
    });
    return { newTurns: [], added: 0, ovSessionId: "", unreadable: Boolean(transcriptPath) && !ok };
  }

  // Post-compact transcript-shrink defense: codex's /compact may rewrite or
  // truncate transcript_path. Resume at the latest human turn so the current
  // interaction is captured without replaying compacted history.
  if (turns.length < state.capturedTurnCount) {
    const humanIndex = findLastHumanTurnIndex(turns);
    log?.("transcript_shrink_detected", {
      cached: state.capturedTurnCount,
      observed: turns.length,
      resumeFrom: Math.max(0, humanIndex),
      fallback: humanIndex < 0 ? "full_transcript" : undefined,
    });
    state.capturedTurnCount = Math.max(0, humanIndex);
  }

  const maxCatchUp = Number(cfg?.captureCatchUpMaxTurns) || 0;
  if (maxCatchUp > 0 && turns.length - state.capturedTurnCount > maxCatchUp) {
    log?.("catch_up_capped", {
      previouslyCaptured: state.capturedTurnCount,
      skipped: turns.length - maxCatchUp - state.capturedTurnCount,
      kept: maxCatchUp,
    });
    state.capturedTurnCount = turns.length - maxCatchUp;
  }

  const newTurns = turns.slice(state.capturedTurnCount);
  log?.("transcript_parse", {
    totalTurns: turns.length,
    previouslyCaptured: state.capturedTurnCount,
    newTurns: newTurns.length,
  });
  if (newTurns.length === 0) return { newTurns, added: 0, ovSessionId: "" };

  if (shouldSend && !shouldSend(newTurns)) {
    log?.("skip", { stage: "capture_mode", reason: "keyword mode without capture trigger" });
    return { newTurns, added: 0, ovSessionId: "", skipped: "capture_mode" };
  }

  // Only revive the OV session id when there is something to send; otherwise
  // an already-committed session would look live again on every hook run.
  const ovSessionId = resolveOvSessionId(state);
  if (!ovSessionId) {
    logError?.("resolve_ov_session", "failed to derive OV session id");
    return { newTurns, added: 0, ovSessionId: "" };
  }

  const payloads = newTurns.map((turn) => {
    const body = turn.parts?.length
      ? { role: turn.role, parts: turn.parts }
      : { role: turn.role, content: turn.text };
    if (activePeerId) body.peer_id = activePeerId;
    return body;
  });

  const r = await sendSessionMessages(fetchJSONRes, ovSessionId, payloads, {
    // The transcript and persisted cursor own retries, including SessionStart
    // catch-up. Queueing the same tail would create a second retry owner.
    onSent: async (n) => {
      state.capturedTurnCount += n;
      await saveState(state);
      await heartbeat?.();
    },
  });
  return { newTurns, added: r.sent, ovSessionId };
}
