import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { associate } from "../src/preview.ts";

const sha = "a".repeat(40);

async function callAssociate(
  fetcher: typeof fetch,
  patch: Record<string, unknown> = {},
  previewBranch = "main",
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pages-preview-"));
  const eventPath = path.join(dir, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      action: "completed",
      workflow_run: {
        id: 50,
        run_number: 8,
        run_attempt: 2,
        repository: { id: 100 },
        head_repository: { id: 200, full_name: "contributor/project" },
        head_branch: "patch",
        head_sha: sha,
        workflow_id: 7,
        name: "PR CI",
        path: ".github/workflows/pr.yml",
        event: "pull_request",
        ...patch,
      },
    }),
  );
  try {
    return await associate(
      {
        GITHUB_TOKEN: "token",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_REPOSITORY_ID: "100",
        GITHUB_EVENT_NAME: "workflow_run",
        GITHUB_EVENT_PATH: eventPath,
        INPUT_ACCOUNT_ID: "acct",
        INPUT_PROJECT_NAME: "pages",
        PREVIEW_BRANCH: previewBranch,
      },
      fetcher,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function apiFetch(
  pulls: any[] = [
    {
      number: 12,
      head: { repo: { id: 200 }, ref: "patch", sha },
      base: { repo: { id: 100 }, ref: "main" },
      state: "open",
    },
  ],
  latestAttempt = 2,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.endsWith("/repos/owner/repo")
      ? { id: 100, default_branch: "main" }
      : url.includes("/actions/workflows?")
        ? { workflows: [{ id: 7, name: "PR CI", path: ".github/workflows/pr.yml" }] }
        : url.endsWith("/attempts/2")
          ? {
              id: 50,
              run_number: 8,
              run_attempt: 2,
              workflow_id: 7,
              repository: { id: 100 },
              head_repository: { id: 200 },
              head_branch: "patch",
              head_sha: sha,
              event: "pull_request",
              path: ".github/workflows/pr.yml",
              name: "PR CI",
              status: "completed",
              conclusion: "success",
            }
          : url.includes("/actions/runs/50/artifacts?")
            ? {
                artifacts: [
                  {
                    id: 99,
                    name: "build-50-2",
                    expired: false,
                    workflow_run: {
                      id: 50,
                      repository_id: 100,
                      head_repository_id: 200,
                      head_branch: "patch",
                      head_sha: sha,
                    },
                  },
                ],
              }
            : url.endsWith("/actions/runs/50")
              ? { run_attempt: latestAttempt }
              : url.includes("/pulls?")
                ? pulls
                : {
                    artifacts: [
                      {
                        id: 99,
                        name: "build-50-2",
                        expired: false,
                        workflow_run: {
                          id: 50,
                          repository_id: 100,
                          head_repository_id: 200,
                          head_branch: "patch",
                          head_sha: sha,
                        },
                      },
                    ],
                  };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("associates a fork PR using the Cloudflare production branch and exact run artifact", async () => {
  const result = await callAssociate(apiFetch());
  assert.equal(result.publish, "true", JSON.stringify(result));
  assert.equal(result.pr, "12");
  assert.equal(result.attempt, "2");
  assert.equal(result.artifact_id, "99");
  assert.equal(result.base_branch, "main");
  assert.equal("production_branch" in result, false);
});

test("a Cloudflare production branch differing from GitHub default selects matching PRs", async () => {
  const pull = {
    number: 12,
    head: { repo: { id: 200 }, ref: "patch", sha },
    base: { repo: { id: 100 }, ref: "release" },
    state: "open",
  };
  const selected = await callAssociate(apiFetch([pull]), {}, "release");
  assert.equal(selected.publish, "true");
  assert.equal(selected.base_branch, "release");

  const skipped = await callAssociate(apiFetch(), {}, "release");
  assert.equal(skipped.publish, "false");
  assert.equal(skipped.skip, "No current pull request matches this source head");
});

test("returns a skip when there is no matching open fork PR", async () => {
  const result = await callAssociate(apiFetch([]));
  assert.equal(result.skip, "No current pull request matches this source head");
});

test("paginates through the complete open PR list before matching", async () => {
  const fallback = apiFetch();
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/pulls?") && url.endsWith("page=1")) {
      return new Response(
        JSON.stringify(
          Array.from({ length: 100 }, (_, number) => ({
            number,
            head: { repo: { id: 300 }, ref: "other", sha },
            base: { repo: { id: 100 }, ref: "main" },
            state: "open",
          })),
        ),
        { status: 200 },
      );
    }
    return fallback(input);
  }) as typeof fetch;
  const result = await callAssociate(fetcher);
  assert.equal(result.pr, "12");
});

test("skips a same-repository PR before source workflow lookup", async () => {
  const result = await callAssociate(apiFetch(), {
    head_repository: { id: 100, full_name: "owner/repo" },
  });
  assert.equal(result.skip, "Same-repository pull requests are not previewed");
});

test("skips a superseded attempt of the same run", async () => {
  const result = await callAssociate(apiFetch(undefined, 3));
  assert.equal(result.skip, "Source run attempt is stale");
});

test("fails closed for ambiguous matching pull requests", async () => {
  const pull = {
    head: { repo: { id: 200 }, ref: "patch", sha },
    base: { repo: { id: 100 }, ref: "main" },
    state: "open",
  };
  await assert.rejects(
    callAssociate(
      apiFetch([
        { ...pull, number: 1 },
        { ...pull, number: 2 },
      ]),
    ),
    /Ambiguous/,
  );
});

test("fails closed when source attempt identity disagrees", async () => {
  const fetcher = (async (input: string | URL | Request) => {
    const response = await apiFetch()(input);
    if (String(input).endsWith("/attempts/2"))
      return new Response(
        JSON.stringify({ ...((await response.json()) as object), head_sha: "b".repeat(40) }),
        { status: 200 },
      );
    return response;
  }) as typeof fetch;
  await assert.rejects(callAssociate(fetcher), /does not match/);
});
