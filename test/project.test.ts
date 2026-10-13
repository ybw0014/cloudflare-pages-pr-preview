import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { project } from "../src/preview.ts";

const env = {
  INPUT_ACCOUNT_ID: "acct",
  INPUT_PROJECT_NAME: "pages",
  CLOUDFLARE_API_TOKEN: "cf-secret",
};

function response(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

function stepEnv(action: string, id: string): string {
  const start = action.indexOf(`    - id: ${id}\n`);
  assert.notEqual(start, -1, `Missing action step: ${id}`);
  const next = action.indexOf("\n    - id: ", start + 1);
  const step = action.slice(start, next === -1 ? undefined : next);
  const env = step.match(/^      env:\n((?:        .*\n?)*)/m)?.[1];
  assert.ok(env, `Missing environment for action step: ${id}`);
  return env;
}

test("project resolves and validates Cloudflare production branch", async () => {
  assert.equal(
    await project(env, response({ success: true, result: { production_branch: "release" } })),
    "release",
  );
});

test("project fails closed for Cloudflare errors and invalid production branches", async (t) => {
  for (const [name, fetcher] of [
    ["HTTP error", response({}, 403)],
    ["API failure", response({ success: false, result: { production_branch: "main" } })],
    ["missing branch", response({ success: true, result: {} })],
    ["empty branch", response({ success: true, result: { production_branch: "" } })],
    ["non-string branch", response({ success: true, result: { production_branch: 12 } })],
    ["invalid branch", response({ success: true, result: { production_branch: "../release" } })],
    ["invalid standalone at sign", response({ success: true, result: { production_branch: "@" } })],
  ] as const) {
    await t.test(name, async () => assert.rejects(project(env, fetcher)));
  }
});

test("only project lookup and official deploy/guard receive the Cloudflare token", async () => {
  const action = await readFile(new URL("../action.yml", import.meta.url), "utf8");
  assert.doesNotMatch(action, /^  branch:/m);
  assert.equal((action.match(/CLOUDFLARE_API_TOKEN:/g) ?? []).length, 2);
  assert.match(stepEnv(action, "project"), /CLOUDFLARE_API_TOKEN: \$\{\{ inputs\.api-token \}\}/);
  const productionBranch = /PREVIEW_BRANCH: \$\{\{ steps\.project\.outputs\.production_branch \}\}/;
  for (const id of ["associate", "prepare", "deploy", "finish"])
    assert.match(stepEnv(action, id), productionBranch, `${id} must receive PREVIEW_BRANCH`);
  assert.match(action, /preCommands: node "\$PREVIEW_ACTION_PATH\/src\/preview\.ts" guard/);
});
