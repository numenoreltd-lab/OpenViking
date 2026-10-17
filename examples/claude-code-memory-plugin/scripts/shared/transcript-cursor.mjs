// GENERATED FROM examples/memory-plugin-shared/lib. DO NOT EDIT.
/**
 * Read a transcript's turns from where the last read left off.
 *
 * Hosts append to one transcript for a thread's whole life, and every capture
 * hook used to read it from the top. Past a few GB that runs out of heap: the
 * hook dies before it can log, and nothing more of the thread is captured.
 *
 * Here the transcript is cut at every boundary record (one that starts a turn:
 * Codex turn_context, a Claude Code prompt) and each turn's records are turned
 * into turns on their own. Only one turn is held at a time, and the result
 * carries a cursor — the newest boundary's byte offset and how many turns come
 * before it — so the next read starts there instead of at byte 0.
 *
 * Cutting at every boundary, never by size, makes the turns a function of the
 * file alone: a read from the top and one resumed at any cursor agree. It also
 * scopes an extractor's de-duplication to one turn, where reading the whole
 * file let a record in one turn suppress a repeat in a much later one (a
 * long-running command's output, recorded under one call id across turns).
 */

import { findLastHumanTurnIndex } from "./capture-utils.mjs";
import { forEachJsonlRecord, readBytesAt, readJsonlRecords, startsWithJsonArray } from "./jsonl-file.mjs";

// Bytes of the boundary line a cursor keeps, to recognize it on resume.
const CURSOR_HEAD_BYTES = 128;

async function cursorStart(path, cursor, keepFrom) {
  if (
    cursor?.path !== path
    || !Number.isSafeInteger(cursor.offset) || cursor.offset <= 0
    || !Number.isSafeInteger(cursor.turnsBefore) || cursor.turnsBefore < 0
    // Turns before the cursor are not read again, so it fits only a caller
    // that needs none of them.
    || cursor.turnsBefore > keepFrom
    || typeof cursor.head !== "string"
  ) return null;
  const head = await readBytesAt(path, cursor.offset, CURSOR_HEAD_BYTES);
  return head?.toString("latin1") === cursor.head ? cursor : null;
}

/**
 * Resumes at `cursor` (from an earlier result) when the file still has that
 * boundary there; otherwise reads from the top. Keeps the turns from index
 * `keepFrom`, and with `keepLast` only that many of the newest.
 *
 * - `isBoundary(record)`: the record starts a turn.
 * - `extractTurns(records, { first })`: the turns of the records from one
 *   boundary to the next; `first` is true for the records before the first.
 *
 * Returns `{ turns, totalTurns, lastHumanTurnIndex, cursor, readFrom }`:
 * `turns` are the last `turns.length` of `totalTurns`, indexes count the whole
 * transcript, and `readFrom` is the byte offset this read started at. Throws
 * when the file cannot be read.
 */
export async function readTurnsFromCursor(path, {
  cursor, keepFrom = 0, keepLast = 0, isBoundary, extractTurns, skipLine,
}) {
  const start = await cursorStart(path, cursor, keepFrom);
  const result = {
    turns: [], totalTurns: start ? start.turnsBefore : 0, lastHumanTurnIndex: -1, cursor: null,
    readFrom: start ? start.offset : 0,
  };
  let first = !start;

  const flush = (records) => {
    if (!records.length) return;
    const turns = extractTurns(records, { first });
    first = false;
    const base = result.totalTurns;
    const human = findLastHumanTurnIndex(turns);
    if (human >= 0) result.lastHumanTurnIndex = base + human;
    for (let i = Math.max(0, keepFrom - base); i < turns.length; i += 1) result.turns.push(turns[i]);
    if (keepLast > 0 && result.turns.length > keepLast) result.turns.splice(0, result.turns.length - keepLast);
    result.totalTurns += turns.length;
  };

  // A transcript written as one JSON array (older Claude Code) is read whole.
  if (!start && await startsWithJsonArray(path)) {
    flush(await readJsonlRecords(path));
    return result;
  }

  let segment = [];
  let last = null;
  await forEachJsonlRecord(path, (record, offset) => {
    if (isBoundary(record)) {
      flush(segment);
      segment = [];
      last = { offset, turnsBefore: result.totalTurns };
    }
    segment.push(record);
  }, { start: result.readFrom, skipLine });
  flush(segment);

  if (last) {
    const head = await readBytesAt(path, last.offset, CURSOR_HEAD_BYTES);
    if (head?.length === CURSOR_HEAD_BYTES) {
      result.cursor = { path, offset: last.offset, turnsBefore: last.turnsBefore, head: head.toString("latin1") };
    }
  }
  return result;
}
