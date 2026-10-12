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
 *
 * Returns what `content.split("\n").map(JSON.parse)` would, skipping blank and
 * unparseable lines. A file that is one JSON array (older Claude transcripts)
 * is read whole, as before.
 */

import { open } from "node:fs/promises";

const CHUNK_BYTES = 16 * 1024 * 1024;
const HEAD_BYTES = 256;
const NEWLINE = 0x0a;

export async function readJsonlRecords(path, { skipLine, chunkBytes = CHUNK_BYTES } = {}) {
  const file = await open(path, "r");
  try {
    if (await firstByteIs(file, 0x5b /* "[" */)) return await readJsonArray(file);
    const records = [];
    const chunk = Buffer.alloc(chunkBytes);
    let carry = null;
    let position = 0;
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const buf = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
        pushRecord(records, buf, start, nl, skipLine);
        start = nl + 1;
      }
      carry = start < buf.length ? Buffer.from(buf.subarray(start)) : null;
    }
    if (carry) pushRecord(records, carry, 0, carry.length, skipLine);
    return records;
  } finally {
    await file.close();
  }
}

function pushRecord(records, buf, start, end, skipLine) {
  if (end <= start) return;
  if (skipLine && skipLine(buf.toString("utf8", start, Math.min(end, start + HEAD_BYTES)))) return;
  try { records.push(JSON.parse(buf.toString("utf8", start, end))); } catch { /* skip */ }
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
