// GENERATED FROM examples/memory-plugin-shared/lib. DO NOT EDIT.
/**
 * Read a JSONL transcript record by record.
 *
 * Hosts append to one transcript for the whole life of a thread, and a long
 * one passes V8's string limit (~512 MB): `readFile(path, "utf-8")` then throws
 * `Invalid string length` on every hook, and nothing more of that thread is
 * captured. Reading in chunks and decoding one line at a time keeps memory to
 * what the records themselves take.
 *
 * `skipLine(head)` sees the first bytes of a line and can drop it before it is
 * parsed — for record types a caller never reads, which in a long Codex rollout
 * are most of the file.
 */

import { open } from "node:fs/promises";

const CHUNK_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 256;
const NEWLINE = 0x0a;

/**
 * Returns what `content.split("\n").map(JSON.parse)` would, skipping blank and
 * unparseable lines. A file that is one JSON array (older Claude transcripts)
 * is read whole, as before.
 */
export async function readJsonlRecords(path, { skipLine, chunkBytes = CHUNK_BYTES } = {}) {
  const file = await open(path, "r");
  try {
    if (await firstByteIs(file, 0x5b /* "[" */)) return await readJsonArray(file);
    const records = [];
    await scanLines(file, 0, (record) => records.push(record), skipLine, chunkBytes);
    return records;
  } finally {
    await file.close();
  }
}

/**
 * Call `onRecord(record, offset, end)` for each record from byte `start` on;
 * `[offset, end)` are the record's bytes in the file. Holding no records
 * itself, it lets a caller keep only what it needs, and a caller that saves an
 * `offset` can later resume there instead of reading the file from the top.
 */
export async function forEachJsonlRecord(path, onRecord, { start = 0, skipLine, chunkBytes = CHUNK_BYTES } = {}) {
  const file = await open(path, "r");
  try {
    await scanLines(file, start, onRecord, skipLine, chunkBytes);
  } finally {
    await file.close();
  }
}

/** Whether the file is one JSON array rather than JSONL. */
export async function startsWithJsonArray(path) {
  const file = await open(path, "r");
  try {
    return await firstByteIs(file, 0x5b /* "[" */);
  } finally {
    await file.close();
  }
}

/** Up to `length` bytes of the file from `offset`, or null if it cannot be read. */
export async function readBytesAt(path, offset, length) {
  let file;
  try {
    file = await open(path, "r");
    const buf = Buffer.alloc(length);
    const { bytesRead } = await file.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

async function scanLines(file, start, onRecord, skipLine, chunkBytes) {
  const chunk = Buffer.alloc(chunkBytes);
  let carry = null;
  let position = start;
  for (;;) {
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    const base = position - (carry ? carry.length : 0);
    position += bytesRead;
    const buf = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let lineStart = 0;
    for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, lineStart)) {
      emitRecord(buf, lineStart, nl, base, onRecord, skipLine);
      lineStart = nl + 1;
    }
    carry = lineStart < buf.length ? Buffer.from(buf.subarray(lineStart)) : null;
  }
  if (carry) emitRecord(carry, 0, carry.length, position - carry.length, onRecord, skipLine);
}

function emitRecord(buf, start, end, base, onRecord, skipLine) {
  if (end <= start) return;
  if (skipLine && skipLine(buf.toString("utf8", start, Math.min(end, start + HEAD_BYTES)))) return;
  let record;
  try { record = JSON.parse(buf.toString("utf8", start, end)); } catch { return; }
  onRecord(record, base + start, base + end);
}

async function firstByteIs(file, expected) {
  const buf = Buffer.alloc(4096);
  for (let position = 0; ;) {
    const { bytesRead } = await file.read(buf, 0, buf.length, position);
    if (bytesRead === 0) return false;
    for (const byte of buf.subarray(0, bytesRead)) {
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
      return byte === expected;
    }
    position += bytesRead;
  }
}

// The old whole-file path, kept for single-array transcripts, which are small.
async function readJsonArray(file) {
  const content = (await file.readFile()).toString("utf8");
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data;
  } catch { /* not a JSON array */ }
  const records = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return records;
}
