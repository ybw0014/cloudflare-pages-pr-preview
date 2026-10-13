import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractZip } from "../src/extract.ts";
import { makeZip, type ZipItem as Item } from "./zip-fixture.ts";

async function withArchive(
  items: Item[],
  run: (zip: string, out: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pages-preview-"));
  try {
    const zip = path.join(dir, "artifact.zip");
    await writeFile(zip, makeZip(items));
    await run(zip, path.join(dir, "out"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const valid: Item[] = [
  { name: "index.html", data: "home" },
  { name: "assets/", mode: 0o040755 },
  { name: "assets/app.js", data: "ok" },
  { name: "foo/_worker.js", data: "nested allowed" },
];

test("extracts a valid ZIP, including implicit directories and nested _worker.js", async () => {
  await withArchive(
    [
      { name: "index.html", data: "home" },
      { name: "assets/app.js", data: "body{}", method: 8 },
      { name: "foo/_worker.js", data: "nested" },
    ],
    async (zip, out) => {
      await extractZip(zip, out);
      assert.equal(await readFile(path.join(out, "index.html"), "utf8"), "home");
      assert.equal(await readFile(path.join(out, "assets/app.js"), "utf8"), "body{}");
      assert.equal(await readFile(path.join(out, "foo/_worker.js"), "utf8"), "nested");
    },
  );
});

const rejected: Array<[string, Item[], RegExp]> = [
  [
    "traversal",
    [{ name: "index.html", data: "x" }, { name: "../escape" }],
    /relative path|Unsafe ZIP path/,
  ],
  [
    "backslash",
    [{ name: "index.html", data: "x" }, { name: "a\\b" }],
    /invalid characters|Unsafe ZIP path/,
  ],
  [
    "root worker file",
    [{ name: "index.html", data: "x" }, { name: "_worker.js" }],
    /forbidden root/,
  ],
  [
    "root worker implicit directory",
    [{ name: "index.html", data: "x" }, { name: "_worker.js/child" }],
    /forbidden root/,
  ],
  [
    "symlink",
    [
      { name: "index.html", data: "x" },
      { name: "link", data: "target", mode: 0o120777 },
    ],
    /Special ZIP/,
  ],
  [
    "special file",
    [
      { name: "index.html", data: "x" },
      { name: "device", data: "x", mode: 0o020600 },
    ],
    /Special ZIP/,
  ],
  [
    "duplicate",
    [{ name: "index.html", data: "x" }, { name: "assets/a" }, { name: "assets/a" }],
    /Duplicate/,
  ],
  [
    "file-directory conflict",
    [{ name: "index.html", data: "x" }, { name: "node" }, { name: "node/child" }],
    /path conflict/,
  ],
  ["missing index", [{ name: "assets/a" }], /index.html/],
  [
    "directory data",
    [
      { name: "index.html", data: "x" },
      { name: "dir/", data: "x", mode: 0o040755 },
    ],
    /Directory entry has data/,
  ],
];

for (const [name, items, expected] of rejected)
  test(`rejects ZIP ${name}`, async () => {
    await withArchive(items, async (zip, out) => assert.rejects(extractZip(zip, out), expected));
  });

test("enforces archive, entry, per-file, expanded-size, and actual expanded-size limits", async () => {
  await withArchive(valid, async (zip, out) =>
    assert.rejects(
      extractZip(zip, out, { zip: 1, entries: 99, file: 99, total: 99 }),
      /ZIP exceeds size limit/,
    ),
  );
  await withArchive(valid, async (zip, out) =>
    assert.rejects(
      extractZip(zip, out, { zip: 99_999, entries: 2, file: 99, total: 99 }),
      /entry limit/,
    ),
  );
  await withArchive([{ name: "index.html", data: "12345" }], async (zip, out) =>
    assert.rejects(
      extractZip(zip, out, { zip: 99_999, entries: 5, file: 4, total: 99 }),
      /file exceeds size limit/,
    ),
  );
  await withArchive(
    [
      { name: "index.html", data: "123" },
      { name: "a", data: "456" },
    ],
    async (zip, out) =>
      assert.rejects(
        extractZip(zip, out, { zip: 99_999, entries: 5, file: 9, total: 5 }),
        /expanded size limit/,
      ),
  );
  await withArchive([{ name: "index.html", data: "12345", declaredSize: 2 }], async (zip, out) =>
    assert.rejects(extractZip(zip, out, { zip: 99_999, entries: 5, file: 4, total: 99 })),
  );
  await withArchive(
    [
      { name: "index.html", data: "123", declaredSize: 2 },
      { name: "asset", data: "456", declaredSize: 2 },
    ],
    async (zip, out) =>
      assert.rejects(extractZip(zip, out, { zip: 99_999, entries: 5, file: 9, total: 5 })),
  );
});

test("rejects non-ZIP input", async () => {
  await withArchive([], async (_zip, out) => {
    const bad = `${out}.bad`;
    await writeFile(bad, "not a ZIP");
    await assert.rejects(extractZip(bad, out));
  });
});

test("enforces the actual-byte file limit while streaming deflated content", async () => {
  const inflated = "x".repeat(20_000);
  await withArchive(
    [
      { name: "index.html", data: "home", method: 8 },
      { name: "assets/large.txt", data: inflated, declaredSize: 100, method: 8 },
    ],
    async (zip, out) =>
      assert.rejects(
        extractZip(zip, out, { zip: 99_999, entries: 5, file: 1_000, total: 30_000 }),
        /actual size exceeds limit/,
      ),
  );
});
