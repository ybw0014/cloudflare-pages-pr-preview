import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { associate, finish, guard, prepare } from "../src/preview.ts";
import { makeZip } from "./zip-fixture.ts";

const sha = "a".repeat(40);
const marker = "<!-- cloudflare-pages-pr-preview:v1 -->";
const dataMarker = "<!-- cloudflare-pages-pr-preview:data ";
const source = (
  status = "completed",
  conclusion: string | null = "success",
  headSha = sha,
  runNumber = 8,
  runId = 50,
) => ({
  id: runId,
  run_number: runNumber,
  run_attempt: 1,
  workflow_id: 7,
  repository: { id: 100 },
  head_repository: { id: 200 },
  head_branch: "patch",
  head_sha: headSha,
  event: "pull_request",
  path: ".github/workflows/pr.yml",
  name: "PR CI",
  status,
  conclusion,
});

function pr(state = "open", headSha = sha, baseBranch = "main") {
  return {
    number: 12,
    state,
    head: { repo: { id: 200 }, ref: "patch", sha: headSha },
    base: { repo: { id: 100 }, ref: baseBranch },
  };
}

function event(name: "pull_request_target" | "workflow_run", action: string, run = source()) {
  return name === "pull_request_target"
    ? {
        action,
        pull_request: {
          ...pr(action === "closed" ? "closed" : "open"),
          base: { ...pr().base },
          head: { ...pr().head },
        },
      }
    : {
        action,
        workflow_run: {
          ...run,
          repository: { id: 100 },
          head_repository: { id: 200 },
          name: "PR CI",
          path: ".github/workflows/pr.yml",
          event: "pull_request",
        },
      };
}

async function environment(name: "pull_request_target" | "workflow_run", payload: object) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pages-preview-lifecycle-"));
  const eventPath = path.join(dir, "event.json");
  await writeFile(eventPath, JSON.stringify(payload));
  const env: Record<string, string> = {
    GITHUB_TOKEN: "github-test-token",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_ID: "100",
    GITHUB_EVENT_NAME: name,
    GITHUB_EVENT_PATH: eventPath,
    INPUT_ACCOUNT_ID: "acct",
    INPUT_PROJECT_NAME: "pages",
    PREVIEW_BRANCH: "main",
  };
  return { dir, env };
}

function api(
  options: {
    source?: ReturnType<typeof source> | null;
    pull?: ReturnType<typeof pr>;
    comments?: any[];
    commentPages?: any[][];
    commentStatus?: number;
    patchStatus?: number;
    artifactExpired?: boolean;
  } = {},
) {
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  const comments = options.comments ?? [];
  const currentPull = options.pull ?? pr();
  let currentSource = options.source === undefined ? source() : options.source;
  let artifactExpired = options.artifactExpired ?? false;
  const currentRunId = () => currentSource?.id ?? 50;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const response = (value: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === "https://downloads.example.test/archive.zip")
      return new Response(
        new Uint8Array(
          makeZip([
            { name: "index.html", data: "trusted static payload" },
            { name: "assets/site.css", data: "body{}" },
          ]),
        ),
      );
    if (url.includes("/actions/artifacts/99/zip"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://downloads.example.test/archive.zip" },
      });
    if (url.endsWith("/repos/owner/repo")) return response({ id: 100, default_branch: "main" });
    if (url.includes("/actions/workflows?"))
      return response({ workflows: [{ id: 7, name: "PR CI", path: ".github/workflows/pr.yml" }] });
    if (url.includes("/actions/runs?head_sha="))
      return response({ workflow_runs: currentSource ? [currentSource] : [] });
    if (url.endsWith(`/actions/runs/${currentRunId()}/attempts/1`))
      return response(currentSource ?? source());
    if (url.endsWith(`/actions/runs/${currentRunId()}`))
      return response({ run_attempt: currentSource?.run_attempt ?? 1 });
    if (url.includes(`/actions/runs/${currentRunId()}/artifacts?`))
      return response({
        artifacts: [
          {
            id: 99,
            name: `build-${currentRunId()}-1`,
            expired: artifactExpired,
            workflow_run: {
              id: currentRunId(),
              repository_id: 100,
              head_repository_id: 200,
              head_branch: "patch",
              head_sha: sha,
            },
          },
        ],
      });
    if (url.includes("/pulls?state=")) return response([currentPull]);
    if (url.endsWith("/pulls/12")) return response(currentPull);
    if (url.includes("/issues/12/comments?")) {
      const page = Number(new URL(url).searchParams.get("page")) || 1;
      return response(options.commentPages?.[page - 1] ?? comments);
    }
    if (url.endsWith("/issues/12/comments") && method === "POST") {
      if (options.commentStatus && options.commentStatus >= 400)
        return response({}, options.commentStatus);
      comments.push({
        id: comments.length + 1,
        user: { login: "github-actions[bot]", type: "Bot" },
        body: body.body,
      });
      return response({ id: comments.length });
    }
    if (url.includes("/issues/comments/") && method === "PATCH") {
      if (options.patchStatus && options.patchStatus >= 400)
        return response({}, options.patchStatus);
      const id = Number(url.split("/").at(-1));
      const comment = [...comments, ...(options.commentPages?.flat() ?? [])].find(
        (entry) => entry.id === id,
      );
      if (comment) comment.body = body.body;
      return response(comment ?? {});
    }
    throw new Error(`Unexpected mock API request: ${method} ${url}`);
  }) as typeof fetch;
  return {
    fetcher,
    calls,
    comments,
    currentPull,
    setSource: (value: ReturnType<typeof source>) => (currentSource = value),
    setArtifactExpired: (value: boolean) => (artifactExpired = value),
  };
}

async function associateCandidate(env: Record<string, string>, fetcher: typeof fetch) {
  const result = await associate(env, fetcher);
  assert.equal(result.publish, "true", JSON.stringify(result));
  return {
    ...env,
    PR: result.pr,
    PR_HEAD: result.sha,
    HEAD_REPOSITORY_ID: result.head_repository_id,
    HEAD_REF: result.head_ref,
    BASE_BRANCH: result.base_branch,
    WORKFLOW_ID: result.workflow_id,
    RUN_ID: result.run_id,
    RUN_NUMBER: result.run_number,
    ATTEMPT: result.attempt,
    PREVIEW_STATUS: result.status,
    SHOULD_DEPLOY: result.deploy,
    ARTIFACT_ID: result.artifact_id,
    PR_CLOSED: result.closed,
  };
}

test("new fork PR gets the official waiting comment without implying approval", async () => {
  const ctx = await environment("pull_request_target", event("pull_request_target", "opened"));
  const mock = api({ source: null });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal(candidate.PREVIEW_STATUS, "Waiting for build");
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    const body = mock.comments[0].body as string;
    assert.match(body, /## Deploying pages with Cloudflare Pages/);
    assert.match(body, /Waiting for build/);
    assert.doesNotMatch(body, /approve|Preview URL:/i);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("closed fork PR updates the comment but never deploys", async () => {
  const ctx = await environment("pull_request_target", event("pull_request_target", "closed"));
  const mock = api({ pull: pr("closed") });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal(candidate.PREVIEW_STATUS, "Pull request closed");
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    assert.match(mock.comments[0].body, /Pull request closed/);
    assert.equal(
      mock.calls.some((call) => call.url.includes("/artifacts/99/zip")),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("source CI in progress and failures update the comment without deploying", async (t) => {
  for (const [status, conclusion, expected] of [
    ["in_progress", null, "Building"],
    ["completed", "action_required", "Waiting for build"],
    ["completed", "failure", "Build failed"],
    ["completed", "cancelled", "Build cancelled"],
    ["completed", "skipped", "Build skipped"],
  ] as const) {
    await t.test(expected, async () => {
      const run = source(status, conclusion);
      const ctx = await environment(
        "workflow_run",
        event("workflow_run", status === "completed" ? "completed" : "in_progress", run),
      );
      const mock = api({ source: run });
      try {
        const candidate = await associateCandidate(ctx.env, mock.fetcher);
        assert.equal(candidate.PREVIEW_STATUS, expected);
        assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
        assert.match(mock.comments[0].body, new RegExp(expected));
        if (conclusion === "action_required")
          assert.doesNotMatch(mock.comments[0].body, /Build failed/);
        assert.equal(
          mock.calls.some((call) => call.url.includes("/artifacts/99/zip")),
          false,
        );
      } finally {
        await rm(ctx.dir, { recursive: true, force: true });
      }
    });
  }
});

test("stale run cannot lower an accepted watermark", async () => {
  const ctx = await environment(
    "workflow_run",
    event("workflow_run", "completed", source("completed", "failure")),
  );
  const body = `${marker}\n${dataMarker}${JSON.stringify({
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 9, attempt: 1 },
    status: { name: "Building", sha, run_id: 51, run_number: 9, attempt: 1 },
    last_success: null,
  })} -->`;
  const mock = api({
    source: source("completed", "failure"),
    comments: [{ id: 2, user: { login: "github-actions[bot]", type: "Bot" }, body }],
  });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    assert.equal(
      mock.calls.some((call) => call.method === "PATCH" || call.method === "POST"),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("pending or failed previews label an old URL only as the last successful preview", async () => {
  const oldSha = "b".repeat(40);
  const oldSuccess = {
    url: "https://deadbeef.pages.pages.dev",
    sha: oldSha,
    run_id: 49,
    run_number: 7,
    attempt: 1,
  };
  const state = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 7, attempt: 1 },
    status: { name: "Deploy successful!", sha: oldSha, run_id: 49, run_number: 7, attempt: 1 },
    last_success: oldSuccess,
  };
  const comment = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(state)} -->`,
  };
  const ctx = await environment(
    "workflow_run",
    event("workflow_run", "completed", source("completed", "failure")),
  );
  const mock = api({ source: source("completed", "failure"), comments: [comment] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    await prepare(candidate, mock.fetcher);
    assert.match(comment.body, /Build failed/);
    assert.match(comment.body, /Last successful preview:/);
    assert.match(comment.body, /deadbeef\.pages\.pages\.dev/);
    assert.doesNotMatch(comment.body, /<td>Preview URL:<\/td>/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("a pending preview never presents the previous deployment as the current URL", async () => {
  const oldSha = "b".repeat(40);
  const state = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 7, attempt: 1 },
    status: { name: "Deploy successful!", sha: oldSha, run_id: 49, run_number: 7, attempt: 1 },
    last_success: {
      url: "https://deadbeef.pages.pages.dev",
      sha: oldSha,
      run_id: 49,
      run_number: 7,
      attempt: 1,
    },
  };
  const comment = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(state)} -->`,
  };
  const running = source("in_progress", null);
  const ctx = await environment("workflow_run", event("workflow_run", "in_progress", running));
  const mock = api({ source: running, comments: [comment] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    await prepare(candidate, mock.fetcher);
    assert.match(comment.body, /Building/);
    assert.match(comment.body, /Last successful preview:/);
    assert.doesNotMatch(comment.body, /<td>Preview URL:<\/td>/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("comment pagination finds the highest bot watermark and updates that comment", async () => {
  const headSha = "b".repeat(40);
  const saved = {
    url: "https://deadbeef.pages.pages.dev",
    sha: headSha,
    run_id: 50,
    run_number: 9,
    attempt: 1,
  };
  const top = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 9, attempt: 1 },
    status: { name: "Deploy successful!", sha: headSha, run_id: 50, run_number: 9, attempt: 1 },
    last_success: saved,
  };
  const winner = {
    id: 999,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(top)} -->`,
  };
  const firstPage = Array.from({ length: 99 }, (_, i) => ({
    id: i + 1,
    user: { login: "contributor", type: "User" },
    body: "human comment",
  }));
  firstPage.push({
    id: 998,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify({
      ...top,
      accepted: { run_number: 8, attempt: 1 },
      status: { name: "Building", sha: headSha, run_id: 49, run_number: 8, attempt: 1 },
      last_success: null,
    })} -->`,
  });
  const ctx = await environment("pull_request_target", event("pull_request_target", "opened"));
  const mock = api({ source: null, commentPages: [firstPage, [winner]] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    await prepare(candidate, mock.fetcher);
    assert.ok(mock.calls.some((call) => call.url.endsWith("page=2")));
    assert.ok(mock.calls.some((call) => call.method === "PATCH" && call.url.endsWith("/999")));
    assert.equal(winner.body.includes("Last successful preview:"), true);
    assert.equal(winner.body.includes("<td>Preview URL:</td>"), false);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("human marker forgery is ignored and corrupt bot metadata fails closed", async (t) => {
  await t.test("human comment", async () => {
    const ctx = await environment("pull_request_target", event("pull_request_target", "opened"));
    const fake = {
      id: 1,
      user: { login: "contributor", type: "User" },
      body: `${marker} ${dataMarker}invalid -->`,
    };
    const mock = api({ comments: [fake] });
    try {
      const candidate = await associateCandidate(ctx.env, mock.fetcher);
      await prepare(candidate, mock.fetcher);
      assert.equal(
        mock.calls.some((call) => call.method === "PATCH"),
        false,
      );
      assert.equal(mock.calls.filter((call) => call.method === "POST").length, 1);
    } finally {
      await rm(ctx.dir, { recursive: true, force: true });
    }
  });
  await t.test("corrupt bot metadata", async () => {
    const ctx = await environment("pull_request_target", event("pull_request_target", "opened"));
    const corrupt = { id: 1, user: { login: "github-actions[bot]", type: "Bot" }, body: marker };
    const mock = api({ comments: [corrupt] });
    try {
      const candidate = await associateCandidate(ctx.env, mock.fetcher);
      await assert.rejects(prepare(candidate, mock.fetcher), /corrupt metadata/);
      assert.equal(
        mock.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
        false,
      );
    } finally {
      await rm(ctx.dir, { recursive: true, force: true });
    }
  });
});

test("comment reservation failure prevents artifact download", async () => {
  const run = source();
  const ctx = await environment("pull_request_target", event("pull_request_target", "synchronize"));
  const mock = api({ source: run, commentStatus: 500 });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    await assert.rejects(prepare(candidate, mock.fetcher), /GitHub API request failed \(500\)/);
    assert.equal(
      mock.calls.some((call) => call.url.includes("/actions/artifacts/99/zip")),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("pull_request_target success waits for the workflow_run deployer and never reads an artifact", async () => {
  const run = source();
  const ctx = await environment("pull_request_target", event("pull_request_target", "synchronize"));
  const mock = api({ source: run });
  const paths = {
    ZIP_PATH: path.join(ctx.dir, "artifact.zip"),
    DOWNLOAD_DIR: path.join(ctx.dir, "download"),
    BUILD_DIR: path.join(ctx.dir, "build"),
    WRANGLER_DIR: path.join(ctx.dir, "wrangler"),
  };
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal(candidate.PREVIEW_STATUS, "Waiting for preview");
    assert.equal(candidate.SHOULD_DEPLOY, "false");
    assert.equal((await prepare({ ...candidate, ...paths }, mock.fetcher)).should_deploy, false);
    assert.match(mock.comments[0].body, /Waiting for preview/);
    assert.doesNotMatch(mock.comments[0].body, /Preview URL:/);
    assert.equal(
      mock.calls.some((call) => call.url.includes("/artifacts")),
      false,
    );
    assert.equal(
      mock.calls.some((call) => call.url.includes("/actions/artifacts/99/zip")),
      false,
    );
    assert.equal(
      mock.calls.some((call) => call.url.startsWith("https://api.cloudflare.com/")),
      false,
    );
    await assert.rejects(readFile(path.join(paths.BUILD_DIR, "index.html")));
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("pull_request_target keeps an already successful comment for the same head and run", async () => {
  const ctx = await environment("pull_request_target", event("pull_request_target", "synchronize"));
  const successUrl = "https://deadbeef.pages.pages.dev";
  const saved = {
    url: successUrl,
    sha,
    run_id: 50,
    run_number: 8,
    attempt: 1,
  };
  const state = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 8, attempt: 1 },
    status: { name: "Deploy successful!", sha, run_id: 50, run_number: 8, attempt: 1 },
    last_success: saved,
  };
  const comment = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(state)} -->`,
  };
  const mock = api({ source: source(), comments: [comment] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    assert.match(comment.body, /Deploy successful/);
    assert.match(comment.body, new RegExp(successUrl.replaceAll(".", "\\.")));
    assert.equal(
      mock.calls.some((call) => call.url.includes("/artifacts")),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("completed workflow_run alone downloads and prepares a successful artifact", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const mock = api({ source: source() });
  const paths = {
    ZIP_PATH: path.join(ctx.dir, "artifact.zip"),
    DOWNLOAD_DIR: path.join(ctx.dir, "download"),
    BUILD_DIR: path.join(ctx.dir, "build"),
    WRANGLER_DIR: path.join(ctx.dir, "wrangler"),
  };
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal(candidate.SHOULD_DEPLOY, "true");
    assert.equal((await prepare({ ...candidate, ...paths }, mock.fetcher)).should_deploy, true);
    assert.equal(
      await readFile(path.join(paths.BUILD_DIR, "index.html"), "utf8"),
      "trusted static payload",
    );
    const reservation = mock.calls.findIndex((call) => call.method === "POST");
    const artifact = mock.calls.findIndex((call) => call.url.includes("/actions/artifacts/99/zip"));
    assert.ok(reservation >= 0 && artifact > reservation);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("same source attempt can retry after deployment failure and recover", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const mock = api({ source: source() });
  const paths = {
    ZIP_PATH: path.join(ctx.dir, "artifact.zip"),
    DOWNLOAD_DIR: path.join(ctx.dir, "download"),
    BUILD_DIR: path.join(ctx.dir, "build"),
    WRANGLER_DIR: path.join(ctx.dir, "wrangler"),
  };
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal((await prepare({ ...candidate, ...paths }, mock.fetcher)).should_deploy, true);
    await finish({ ...candidate, DEPLOY_OUTCOME: "failure" }, mock.fetcher);
    assert.match(mock.comments[0].body, /Deployment failed/);
    assert.equal((await prepare({ ...candidate, ...paths }, mock.fetcher)).should_deploy, true);
    const deploymentUrl = await finish(
      {
        ...candidate,
        DEPLOY_OUTCOME: "success",
        DEPLOYMENT_URL: "https://deadbeef.pages.pages.dev",
      },
      mock.fetcher,
    );
    assert.equal(deploymentUrl, "https://deadbeef.pages.pages.dev");
    assert.match(mock.comments[0].body, /Deploy successful/);
    assert.match(mock.comments[0].body, /deadbeef\.pages\.pages\.dev/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("failed finish comment update leaves the newer watermark blocking an older run", async () => {
  const oldRun = source("completed", "success", sha, 7, 49);
  const oldCtx = await environment("workflow_run", event("workflow_run", "completed", oldRun));
  const oldMock = api({ source: oldRun });
  const oldCandidate = await associateCandidate(oldCtx.env, oldMock.fetcher);

  const currentRun = source("completed", "success", sha, 8, 50);
  const ctx = await environment("workflow_run", event("workflow_run", "completed", currentRun));
  const options: Parameters<typeof api>[0] = { source: currentRun };
  const mock = api(options);
  const paths = {
    ZIP_PATH: path.join(ctx.dir, "artifact.zip"),
    DOWNLOAD_DIR: path.join(ctx.dir, "download"),
    BUILD_DIR: path.join(ctx.dir, "build"),
    WRANGLER_DIR: path.join(ctx.dir, "wrangler"),
  };
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal((await prepare({ ...candidate, ...paths }, mock.fetcher)).should_deploy, true);
    options.patchStatus = 500;
    await assert.rejects(
      finish(
        {
          ...candidate,
          DEPLOY_OUTCOME: "success",
          DEPLOYMENT_URL: "https://deadbeef.pages.pages.dev",
        },
        mock.fetcher,
      ),
      /GitHub API request failed \(500\)/,
    );
    const oldCheck = api({ source: oldRun, comments: mock.comments });
    assert.equal((await prepare(oldCandidate, oldCheck.fetcher)).should_deploy, false);
    assert.match(mock.comments[0].body, /Deploying/);
    assert.equal(
      oldCheck.calls.some((call) => call.method === "PATCH" || call.method === "POST"),
      false,
    );
  } finally {
    await rm(oldCtx.dir, { recursive: true, force: true });
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("an in_progress event associated as Building remains safe when CI completes while queued", async () => {
  const running = source("in_progress", null);
  const completed = source("completed", "success");
  const ctx = await environment("workflow_run", event("workflow_run", "in_progress", running));
  const mock = api({ source: running });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    assert.equal(candidate.PREVIEW_STATUS, "Building");
    assert.equal(candidate.SHOULD_DEPLOY, "false");
    mock.setSource(completed);
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    assert.equal(
      mock.calls.some((call) => call.url.includes("/artifacts")),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("a completed source status that changes while queued is skipped without failing publication", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const mock = api({ source: source("completed", "success") });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    mock.setSource(source("completed", "failure"));
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    assert.equal(
      mock.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
      false,
    );
    assert.equal(
      mock.calls.some((call) => call.url.includes("/actions/artifacts/99/zip")),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("pull_request_target head changes or closes while queued are skipped", async (t) => {
  for (const change of ["head", "close"] as const) {
    await t.test(change, async () => {
      const ctx = await environment(
        "pull_request_target",
        event("pull_request_target", "synchronize"),
      );
      const mock = api({ source: null });
      try {
        const candidate = await associateCandidate(ctx.env, mock.fetcher);
        if (change === "head") mock.currentPull.head.sha = "b".repeat(40);
        else mock.currentPull.state = "closed";
        assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
        assert.equal(
          mock.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
          false,
        );
      } finally {
        await rm(ctx.dir, { recursive: true, force: true });
      }
    });
  }
});

test("an artifact expiring while queued skips the deployment with a notice", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const mock = api({ source: source() });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    mock.setArtifactExpired(true);
    assert.equal((await prepare(candidate, mock.fetcher)).should_deploy, false);
    assert.equal(
      mock.calls.some((call) => call.url.includes("/actions/artifacts/99/zip")),
      false,
    );
    assert.equal(
      mock.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
      false,
    );
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("successful deployment post-check records only the unique deployment URL", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const state = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 8, attempt: 1 },
    status: { name: "Deploying", sha, run_id: 50, run_number: 8, attempt: 1 },
    last_success: null,
  };
  const comment = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(state)} -->`,
  };
  const mock = api({ source: source(), comments: [comment] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    await finish(
      {
        ...candidate,
        DEPLOY_OUTCOME: "success",
        DEPLOYMENT_URL: "https://deadbeef.pages.pages.dev",
      },
      mock.fetcher,
    );
    assert.match(mock.comments[0].body, /Deploy successful/);
    assert.match(mock.comments[0].body, /https:\/\/deadbeef\.pages\.pages\.dev/);
    assert.match(mock.comments[0].body, /https:\/\/pr-12\.pages\.pages\.dev/);
    assert.doesNotMatch(mock.comments[0].body, /Last successful preview/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("PR head change during deployment does not publish a success URL", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const state = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 8, attempt: 1 },
    status: { name: "Deploying", sha, run_id: 50, run_number: 8, attempt: 1 },
    last_success: null,
  };
  const comment = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(state)} -->`,
  };
  const mock = api({ source: source(), comments: [comment] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    mock.currentPull.head.sha = "b".repeat(40);
    await finish(
      {
        ...candidate,
        DEPLOY_OUTCOME: "success",
        DEPLOYMENT_URL: "https://deadbeef.pages.pages.dev",
      },
      mock.fetcher,
    );
    assert.equal(
      mock.calls.some((call) => call.method === "PATCH"),
      false,
    );
    assert.match(comment.body, /Deploying/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("PR closure during deployment does not publish a success URL", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const state = {
    version: 1,
    repository_id: 100,
    pr: 12,
    workflow_id: 7,
    accepted: { run_number: 8, attempt: 1 },
    status: { name: "Deploying", sha, run_id: 50, run_number: 8, attempt: 1 },
    last_success: null,
  };
  const comment = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\n${dataMarker}${JSON.stringify(state)} -->`,
  };
  const mock = api({ source: source(), comments: [comment] });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    mock.currentPull.state = "closed";
    await finish(
      {
        ...candidate,
        DEPLOY_OUTCOME: "success",
        DEPLOYMENT_URL: "https://deadbeef.pages.pages.dev",
      },
      mock.fetcher,
    );
    assert.equal(
      mock.calls.some((call) => call.method === "PATCH"),
      false,
    );
    assert.match(comment.body, /Deploying/);
    assert.doesNotMatch(comment.body, /deadbeef\.pages\.pages\.dev/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("Cloudflare guard compares actual production branch with configured branch and PR branch", async () => {
  const ctx = await environment("workflow_run", event("workflow_run", "completed"));
  const mock = api({ source: source() });
  try {
    const candidate = await associateCandidate(ctx.env, mock.fetcher);
    const reserved = {
      version: 1,
      repository_id: 100,
      pr: 12,
      workflow_id: 7,
      accepted: { run_number: 8, attempt: 1 },
      status: { name: "Deploying", sha, run_id: 50, run_number: 8, attempt: 1 },
      last_success: null,
    };
    mock.comments.push({
      id: 1,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `${marker}\n${dataMarker}${JSON.stringify(reserved)} -->`,
    });
    let auth: string | null = null;
    const wrapped = (productionBranch: string): typeof fetch =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith("https://api.cloudflare.com/")) {
          auth = new Headers(init?.headers).get("authorization");
          return new Response(
            JSON.stringify({ success: true, result: { production_branch: productionBranch } }),
            {
              status: 200,
            },
          );
        }
        return mock.fetcher(input, init);
      }) as typeof fetch;
    await assert.rejects(
      guard({ ...candidate, PREVIEW_BRANCH: "" }, wrapped("main")),
      /PREVIEW_BRANCH/,
    );
    const deployEnv = { ...candidate, CLOUDFLARE_API_TOKEN: "cf-secret" };
    await guard(deployEnv, wrapped("main"));
    assert.equal(auth, "Bearer cf-secret");
    await assert.rejects(guard(deployEnv, wrapped("release")), /changed or conflicts/);
    await assert.rejects(guard(deployEnv, wrapped("pr-12")), /changed or conflicts/);
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});
