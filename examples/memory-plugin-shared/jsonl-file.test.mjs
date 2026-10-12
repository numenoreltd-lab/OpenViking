import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readJsonlRecords } from "./lib/jsonl-file.mjs";

// What the hooks did before: the whole file as one string, split on newlines.
function wholeFileParse(content) {
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data;
  } catch { /* not a JSON array */ }
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

async function withFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "ov-jsonl-file-"));
  const path = join(dir, "t.jsonl");
  try {
    await writeFile(path, content);
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SAMPLE = [
  JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
  "",
  "   ",
  JSON.stringify({ type: "response_item", payload: { text: "한글 multibyte ✓ text spanning chunks" } }),
  "not json",
  JSON.stringify({ type: "compacted", payload: { replacement_history: ["x".repeat(500)] } }),
  JSON.stringify({ type: "response_item", payload: { text: "crlf line" } }) + "\r",
  JSON.stringify({ type: "response_item", payload: { text: "last line has no newline" } }),
].join("\n");

test("matches the whole-file parse at every chunk size, including splits inside multibyte characters", async () => {
  await withFile(SAMPLE, async (path) => {
    const expected = wholeFileParse(SAMPLE);
    for (const chunkBytes of [1, 2, 3, 7, 64, 1 << 20]) {
      assert.deepEqual(await readJsonlRecords(path, { chunkBytes }), expected, `chunkBytes=${chunkBytes}`);
    }
  });
});

test("skipLine drops a line before it is parsed", async () => {
  await withFile(SAMPLE, async (path) => {
    const seen = [];
    const records = await readJsonlRecords(path, {
      chunkBytes: 5,
      skipLine: (head) => { seen.push(head); return head.startsWith('{"type":"compacted"'); },
    });
    assert.equal(records.some((r) => r.type === "compacted"), false);
    assert.deepEqual(records, wholeFileParse(SAMPLE).filter((r) => r.type !== "compacted"));
    assert.ok(seen.every((head) => head.length <= 256));
  });
});

test("reads a single JSON array whole, as older transcripts are written", async () => {
  const content = `  \n${JSON.stringify([{ type: "user" }, { type: "assistant" }])}`;
  await withFile(content, async (path) => {
    assert.deepEqual(await readJsonlRecords(path, { chunkBytes: 4 }), [{ type: "user" }, { type: "assistant" }]);
  });
});

test("an empty or blank file yields no records", async () => {
  for (const content of ["", "\n\n  \n"]) {
    await withFile(content, async (path) => {
      assert.deepEqual(await readJsonlRecords(path), []);
    });
  }
});

test("a missing file rejects so the caller can log transcript_read", async () => {
  await assert.rejects(readJsonlRecords(join(tmpdir(), "ov-jsonl-file-missing", "nope.jsonl")), { code: "ENOENT" });
});
