import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadArtifact } from "../src/preview.ts";

test("authenticates only the GitHub artifact endpoint and downloads the signed redirect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pages-preview-"));
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (calls.length === 1)
      return new Response(null, {
        status: 302,
        headers: { location: "https://downloads.example.test/archive.zip?sig=secret" },
      });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;
  try {
    const output = path.join(dir, "archive.zip");
    await downloadArtifact("secret-token", "owner/repo", 42, output, fetcher, 3);
    assert.equal(calls[0]?.url, "https://api.github.com/repos/owner/repo/actions/artifacts/42/zip");
    assert.equal(calls[0]?.auth, "Bearer secret-token");
    assert.equal(calls[1]?.auth, null);
    assert.deepEqual(await readFile(output), Buffer.from([1, 2, 3]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects oversized artifact bytes and non-HTTPS redirect URLs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pages-preview-"));
  try {
    const over = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
    await assert.rejects(
      downloadArtifact("secret-token", "owner/repo", 1, path.join(dir, "over.zip"), over, 2),
      /size limit/,
    );
    const redirect = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://evil.test/file" },
      })) as typeof fetch;
    await assert.rejects(
      downloadArtifact("secret-token", "owner/repo", 1, path.join(dir, "redirect.zip"), redirect),
      /HTTPS/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
