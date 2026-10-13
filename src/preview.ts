import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { extractZip } from "./extract.ts";

const githubApi = "https://api.github.com";
const cloudflareApi = "https://api.cloudflare.com/client/v4";
const workflowPath = ".github/workflows/pr.yml";
const workflowName = "PR CI";
const marker = "<!-- cloudflare-pages-pr-preview:v1 -->";
const dataMarker = "<!-- cloudflare-pages-pr-preview:data ";
const shaPattern = /^[a-f0-9]{40}$/i;
const projectPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type Env = Record<string, string | undefined>;
type Status =
  | "Waiting for build"
  | "Waiting for preview"
  | "Building"
  | "Deploying"
  | "Build failed"
  | "Build cancelled"
  | "Build skipped"
  | "Deployment failed"
  | "Deploy successful!"
  | "Pull request closed";
type Tuple = { run_number: number; attempt: number };
type Successful = {
  url: string;
  sha: string;
  run_id: number;
  run_number: number;
  attempt: number;
} | null;
type State = {
  version: 1;
  repository_id: number;
  pr: number;
  workflow_id: number;
  accepted: Tuple;
  status: { name: Status; sha: string; run_id: number; run_number: number; attempt: number };
  last_success: Successful;
};
type Candidate = {
  pr: number;
  sha: string;
  head_repository_id: number;
  head_ref: string;
  base_branch: string;
  workflow_id: number;
  run_id: number;
  run_number: number;
  attempt: number;
  status: Status;
  deploy: boolean;
  artifact_id: number;
  closed: boolean;
};
class SkipEvent extends Error {}

const need = (env: Env, key: string): string => {
  const value = env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
const positive = (value: unknown, allowZero = false): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1))
    throw new Error("Invalid trusted numeric metadata");
  return n;
};
const repoName = (env: Env): string => {
  const repo = need(env, "GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
    throw new Error("Invalid repository identity");
  return repo;
};
function validBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch !== "@" &&
    branch === branch.trim() &&
    !/\s/.test(branch) &&
    !["~", "^", ":", "?", "*", "[", "]", "\\"].some((char) => branch.includes(char)) &&
    !Array.from(branch).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !branch.startsWith("/") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.includes("@{") &&
    !branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  );
}
const compare = (a: Tuple, b: Tuple): number =>
  a.run_number - b.run_number || a.attempt - b.attempt;
const artifactName = (run: number, attempt: number): string => `build-${run}-${attempt}`;

export class GitHub {
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }

  async pages<T>(url: string, key?: string): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const value = await this.request<T[] | Record<string, T[]>>(
        `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const batch = Array.isArray(value) ? value : key ? value[key] : undefined;
      if (!Array.isArray(batch)) throw new Error("Unexpected paginated API response");
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
  }
}

async function eventData(
  env: Env,
  fetcher?: typeof fetch,
): Promise<{ event: any; repo: string; repositoryId: number; github: GitHub; repository: any }> {
  const repo = repoName(env);
  const github = new GitHub(need(env, "GITHUB_TOKEN"), fetcher);
  const repository = await github.request<any>(`${githubApi}/repos/${repo}`);
  const repositoryId = positive(env.GITHUB_REPOSITORY_ID);
  if (repository.id !== repositoryId) throw new Error("Caller repository identity is invalid");
  const event = JSON.parse(await fs.readFile(need(env, "GITHUB_EVENT_PATH"), "utf8")) as any;
  return { event, repo, repositoryId, github, repository };
}

async function fixedWorkflow(github: GitHub, repo: string): Promise<number> {
  const rows = await github.pages<any>(`${githubApi}/repos/${repo}/actions/workflows`, "workflows");
  const matches = rows.filter((row) => row.path === workflowPath);
  if (matches.length !== 1 || matches[0].name !== workflowName)
    throw new Error("Could not uniquely identify the fixed PR CI workflow");
  return positive(matches[0].id);
}

function statusFromConclusion(conclusion: string | null | undefined): Status {
  if (conclusion === "action_required") return "Waiting for build";
  if (conclusion === "cancelled") return "Build cancelled";
  if (conclusion === "skipped" || conclusion === "neutral") return "Build skipped";
  return "Build failed";
}

async function sourceRun(
  github: GitHub,
  repo: string,
  workflowId: number,
  run: any,
  repositoryId: number,
  headRepositoryId: number,
): Promise<any> {
  const id = positive(run.id);
  const attempt = positive(run.run_attempt);
  const source = await github.request<any>(
    `${githubApi}/repos/${repo}/actions/runs/${id}/attempts/${attempt}`,
  );
  if (
    source.id !== id ||
    source.run_attempt !== attempt ||
    source.workflow_id !== workflowId ||
    source.repository?.id !== repositoryId ||
    source.head_repository?.id !== headRepositoryId ||
    source.event !== "pull_request" ||
    source.path !== workflowPath ||
    source.name !== workflowName ||
    source.run_number !== run.run_number ||
    source.head_sha !== run.head_sha ||
    source.head_branch !== run.head_branch
  )
    throw new Error("Source run API metadata does not match trusted event data");
  const latest = await github.request<any>(`${githubApi}/repos/${repo}/actions/runs/${id}`);
  if (latest.run_attempt !== attempt) throw new SkipEvent("Source run attempt is stale");
  return source;
}

async function locatePull(
  github: GitHub,
  repo: string,
  repositoryId: number,
  number: number,
  headRepositoryId: number,
  ref: string,
  sha: string,
  baseBranch: string,
  closed: boolean,
): Promise<any> {
  const pr = await github.request<any>(`${githubApi}/repos/${repo}/pulls/${number}`);
  if (
    pr.number !== number ||
    pr.base?.repo?.id !== repositoryId ||
    pr.head?.repo?.id !== headRepositoryId ||
    pr.head?.ref !== ref ||
    pr.head?.sha !== sha ||
    pr.base?.ref !== baseBranch ||
    pr.state !== (closed ? "closed" : "open")
  )
    throw new SkipEvent("Pull request changed before publication");
  return pr;
}

async function resolve(
  env: Env,
  fetcher?: typeof fetch,
  staleArtifactsAreSkips = false,
): Promise<{ candidate: Candidate; github: GitHub; repo: string; repositoryId: number }> {
  const repo = repoName(env);
  const github = new GitHub(need(env, "GITHUB_TOKEN"), fetcher);
  const repository = await github.request<any>(`${githubApi}/repos/${repo}`);
  const repositoryId = positive(env.GITHUB_REPOSITORY_ID);
  if (repository.id !== repositoryId) throw new Error("Caller repository identity is invalid");
  const event = JSON.parse(await fs.readFile(need(env, "GITHUB_EVENT_PATH"), "utf8")) as any;
  const workflowId = await fixedWorkflow(github, repo);
  const project = need(env, "INPUT_PROJECT_NAME");
  const account = need(env, "INPUT_ACCOUNT_ID");
  if (!projectPattern.test(project) || !/^[A-Za-z0-9_-]+$/.test(account))
    throw new Error("Invalid Cloudflare account or Pages project");
  const baseBranch = need(env, "PREVIEW_BRANCH");
  if (!validBranch(baseBranch)) throw new Error("Invalid Cloudflare production branch");

  let prNumber: number | undefined;
  let headRepositoryId: number;
  let headRef: string;
  let sha: string;
  let closed = false;
  let source: any | null = null;
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    const run = event.workflow_run;
    if (
      !run ||
      run.repository?.id !== repositoryId ||
      run.head_repository?.id == null ||
      !run.head_branch ||
      !shaPattern.test(run.head_sha ?? "")
    )
      throw new Error("Missing or inconsistent workflow_run metadata");
    if (run.head_repository.id === repositoryId)
      throw new SkipEvent("Same-repository pull requests are not previewed");
    if (
      run.name !== workflowName ||
      run.path !== workflowPath ||
      run.workflow_id !== workflowId ||
      run.event !== "pull_request"
    )
      throw new Error("workflow_run does not come from the fixed fork PR CI workflow");
    if (!(["in_progress", "completed"] as string[]).includes(event.action))
      throw new Error("Unsupported workflow_run action");
    source = await sourceRun(github, repo, workflowId, run, repositoryId, run.head_repository.id);
    headRepositoryId = run.head_repository.id;
    headRef = run.head_branch;
    sha = run.head_sha;
  } else if (env.GITHUB_EVENT_NAME === "pull_request_target") {
    const pr = event.pull_request;
    if (
      !pr ||
      !Number.isSafeInteger(pr.number) ||
      pr.base?.repo?.id !== repositoryId ||
      pr.head?.repo?.id == null ||
      !pr.head.ref ||
      !shaPattern.test(pr.head.sha ?? "")
    )
      throw new Error("Missing or inconsistent pull_request_target metadata");
    if (pr.head.repo.id === repositoryId)
      throw new SkipEvent("Same-repository pull requests are not previewed");
    if (!"opened reopened synchronize closed".split(" ").includes(event.action))
      throw new Error("Unsupported pull_request_target action");
    prNumber = positive(pr.number);
    headRepositoryId = positive(pr.head.repo.id);
    headRef = pr.head.ref;
    sha = pr.head.sha;
    closed = event.action === "closed";
  } else throw new Error("Unsupported event type");

  const pulls = await github.pages<any>(
    `${githubApi}/repos/${repo}/pulls?state=${closed ? "closed" : "open"}`,
  );
  const matches = pulls.filter(
    (pr) =>
      pr.base?.repo?.id === repositoryId &&
      pr.base?.ref === baseBranch &&
      pr.head?.repo?.id === headRepositoryId &&
      pr.head?.ref === headRef &&
      pr.head?.sha === sha &&
      (closed ? pr.state === "closed" : pr.state === "open") &&
      (prNumber === undefined || pr.number === prNumber),
  );
  if (!matches.length) throw new SkipEvent("No current pull request matches this source head");
  if (matches.length !== 1) throw new Error("Ambiguous pull request association");
  const pr = matches[0];
  prNumber = positive(pr.number);
  if (env.GITHUB_EVENT_NAME === "pull_request_target")
    await locatePull(
      github,
      repo,
      repositoryId,
      prNumber,
      headRepositoryId!,
      headRef!,
      sha!,
      baseBranch,
      closed,
    );

  if (env.GITHUB_EVENT_NAME === "pull_request_target" && !closed) {
    const runs = await github.pages<any>(
      `${githubApi}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha!)}&event=pull_request`,
      "workflow_runs",
    );
    const candidates = runs.filter(
      (run) =>
        run.repository?.id === repositoryId &&
        run.workflow_id === workflowId &&
        run.event === "pull_request" &&
        run.head_repository?.id === headRepositoryId &&
        run.head_branch === headRef &&
        run.head_sha === sha,
    );
    candidates.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
    if (candidates.length)
      source = await sourceRun(
        github,
        repo,
        workflowId,
        candidates[0],
        repositoryId,
        headRepositoryId!,
      );
  }

  let runId = 0;
  let runNumber = 0;
  let attempt = 0;
  let status: Status;
  let deploy = false;
  let artifactId = 0;
  if (closed) status = "Pull request closed";
  else if (!source) status = "Waiting for build";
  else {
    runId = positive(source.id);
    runNumber = positive(source.run_number);
    attempt = positive(source.run_attempt);
    if (env.GITHUB_EVENT_NAME === "workflow_run" && event.action === "in_progress")
      status = "Building";
    else if (source.status !== "completed") status = "Building";
    else if (source.conclusion !== "success") status = statusFromConclusion(source.conclusion);
    else if (env.GITHUB_EVENT_NAME === "pull_request_target") status = "Waiting for preview";
    else {
      status = "Deploying";
      const artifacts = await github.pages<any>(
        `${githubApi}/repos/${repo}/actions/runs/${runId}/artifacts`,
        "artifacts",
      );
      const valid = artifacts.filter(
        (item) =>
          item.name === artifactName(runId, attempt) &&
          !item.expired &&
          item.workflow_run?.id === runId &&
          item.workflow_run?.repository_id === repositoryId &&
          item.workflow_run?.head_repository_id === headRepositoryId &&
          item.workflow_run?.head_branch === headRef &&
          item.workflow_run?.head_sha === sha,
      );
      if (staleArtifactsAreSkips && valid.length === 0)
        throw new SkipEvent("Source artifact expired or changed before publication");
      if (valid.length !== 1 || !Number.isSafeInteger(valid[0].id) || valid[0].id < 1)
        throw new Error("Expected exactly one unexpired artifact for this source attempt");
      artifactId = positive(valid[0].id);
      deploy = true;
    }
  }
  return {
    candidate: {
      pr: prNumber,
      sha: sha!,
      head_repository_id: headRepositoryId!,
      head_ref: headRef!,
      base_branch: baseBranch,
      workflow_id: workflowId,
      run_id: runId,
      run_number: runNumber,
      attempt,
      status,
      deploy,
      artifact_id: artifactId,
      closed,
    },
    github,
    repo,
    repositoryId,
  };
}

async function output(env: Env, values: Record<string, string | number | boolean>): Promise<void> {
  const file = need(env, "GITHUB_OUTPUT");
  for (const [key, value] of Object.entries(values)) {
    const text = String(value);
    if (/[\r\n]/.test(text)) throw new Error("Workflow output contains a newline");
    await fs.appendFile(file, `${key}=${text}\n`);
  }
}

async function cloudflareProductionBranch(env: Env, fetcher: typeof fetch): Promise<string> {
  const account = need(env, "INPUT_ACCOUNT_ID");
  const project = need(env, "INPUT_PROJECT_NAME");
  if (!/^[A-Za-z0-9_-]+$/.test(account) || !projectPattern.test(project))
    throw new Error("Invalid Cloudflare account or project");
  const response = await fetcher(
    `${cloudflareApi}/accounts/${encodeURIComponent(account)}/pages/projects/${encodeURIComponent(project)}`,
    {
      headers: {
        Authorization: `Bearer ${need(env, "CLOUDFLARE_API_TOKEN")}`,
        Accept: "application/json",
      },
    },
  );
  if (!response.ok)
    throw new Error(`Cloudflare Pages production-branch check failed (${response.status})`);
  const projectInfo = (await response.json()) as any;
  const branch = projectInfo.result?.production_branch;
  if (projectInfo.success !== true || typeof branch !== "string" || !validBranch(branch))
    throw new Error("Cloudflare project production branch is missing or invalid");
  return branch;
}

export async function project(env: Env, fetcher: typeof fetch = fetch): Promise<string> {
  return cloudflareProductionBranch(env, fetcher);
}

export async function associate(env: Env, fetcher?: typeof fetch): Promise<Record<string, string>> {
  try {
    const { candidate } = await resolve(env, fetcher);
    return {
      publish: "true",
      ...Object.fromEntries(Object.entries(candidate).map(([key, value]) => [key, String(value)])),
      project: need(env, "INPUT_PROJECT_NAME"),
    };
  } catch (error) {
    if (error instanceof SkipEvent) return { publish: "false", skip: error.message };
    throw error;
  }
}

function validUrl(url: string, project: string, pr: number): boolean {
  try {
    const parsed = new URL(url);
    const prefix = `.${project}.pages.dev`;
    const host = parsed.hostname;
    const deployment = host.endsWith(prefix) ? host.slice(0, -prefix.length) : "";
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      /^[a-f0-9]{8,64}$/.test(deployment) &&
      deployment !== `pr-${pr}` &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function parseState(
  body: string,
  repoId: number,
  pr: number,
  workflowId: number,
  project: string,
): State {
  const start = body.indexOf(dataMarker);
  const end = start < 0 ? -1 : body.indexOf(" -->", start);
  if (start < 0 || end < 0) throw new Error("Preview bot comment has corrupt metadata");
  let value: any;
  try {
    value = JSON.parse(body.slice(start + dataMarker.length, end));
  } catch {
    throw new Error("Preview bot comment has corrupt metadata");
  }
  if (
    value?.version !== 1 ||
    value.repository_id !== repoId ||
    value.pr !== pr ||
    value.workflow_id !== workflowId ||
    !value.accepted ||
    !value.status ||
    !Number.isSafeInteger(value.accepted.run_number) ||
    value.accepted.run_number < 0 ||
    !Number.isSafeInteger(value.accepted.attempt) ||
    value.accepted.attempt < 0 ||
    !shaPattern.test(value.status.sha ?? "") ||
    !Number.isSafeInteger(value.status.run_id) ||
    value.status.run_id < 0 ||
    !Number.isSafeInteger(value.status.run_number) ||
    value.status.run_number < 0 ||
    !Number.isSafeInteger(value.status.attempt) ||
    value.status.attempt < 0
  )
    throw new Error("Preview bot comment metadata has invalid scope or fields");
  const statuses: Status[] = [
    "Waiting for build",
    "Waiting for preview",
    "Building",
    "Deploying",
    "Build failed",
    "Build cancelled",
    "Build skipped",
    "Deployment failed",
    "Deploy successful!",
    "Pull request closed",
  ];
  if (!statuses.includes(value.status.name))
    throw new Error("Preview bot comment has invalid status metadata");
  if (
    value.last_success !== null &&
    (!value.last_success ||
      !shaPattern.test(value.last_success.sha ?? "") ||
      !validUrl(value.last_success.url, project, pr) ||
      !Number.isSafeInteger(value.last_success.run_id) ||
      value.last_success.run_id < 1 ||
      !Number.isSafeInteger(value.last_success.run_number) ||
      value.last_success.run_number < 1 ||
      !Number.isSafeInteger(value.last_success.attempt) ||
      value.last_success.attempt < 1)
  )
    throw new Error("Preview bot comment has invalid last-success metadata");
  return value as State;
}

function statusText(status: Status): string {
  return {
    "Waiting for build": "⏳ Waiting for build",
    "Waiting for preview": "⏳ Waiting for preview",
    Building: "🔄 Building",
    Deploying: "🔄 Deploying",
    "Build failed": "❌ Build failed",
    "Build cancelled": "⚪ Build cancelled",
    "Build skipped": "⚪ Build skipped",
    "Deployment failed": "❌ Deployment failed",
    "Deploy successful!": "✅ Deploy successful!",
    "Pull request closed": "⚪ Pull request closed",
  }[status];
}

function commentBody(project: string, repo: string, state: State): string {
  const status = state.status.name;
  const sha = state.status.sha.toLowerCase();
  const cells = [
    `<tr><td>Latest commit:</td><td><a href="https://github.com/${repo}/commit/${sha}"><code>${sha.slice(0, 7)}</code></a></td></tr>`,
    `<tr><td>Status:</td><td>${statusText(status)}</td></tr>`,
  ];
  if (status === "Deploy successful!" && state.last_success?.sha === sha) {
    cells.push(
      `<tr><td>Preview URL:</td><td><a href="${state.last_success.url}">${state.last_success.url}</a></td></tr>`,
    );
    cells.push(
      `<tr><td>Branch Preview URL:</td><td><a href="https://pr-${state.pr}.${project}.pages.dev">https://pr-${state.pr}.${project}.pages.dev</a></td></tr>`,
    );
  } else if (state.last_success) {
    const runUrl = `https://github.com/${repo}/actions/runs/${state.last_success.run_id}/attempts/${state.last_success.attempt}`;
    cells.push(
      `<tr><td>Last successful preview:</td><td><a href="${state.last_success.url}">${state.last_success.url}</a> (<code>${state.last_success.sha.slice(0, 7)}</code>, <a href="${runUrl}">run #${state.last_success.run_number}</a>)</td></tr>`,
    );
  }
  if (state.status.run_id > 0)
    cells.push(
      `<tr><td>Logs:</td><td><a href="https://github.com/${repo}/actions/runs/${state.status.run_id}/attempts/${state.status.attempt}">View logs</a></td></tr>`,
    );
  return `## Deploying ${project} with Cloudflare Pages\n\n<table><tbody>${cells.join("")}</tbody></table>\n\n${marker}\n${dataMarker}${JSON.stringify(state)} -->`;
}

async function verifyCurrent(
  github: GitHub,
  repo: string,
  repositoryId: number,
  c: Candidate,
): Promise<any> {
  const pr = await github.request<any>(`${githubApi}/repos/${repo}/pulls/${c.pr}`);
  const expectedState = c.closed ? "closed" : "open";
  if (
    pr.number !== c.pr ||
    pr.base?.repo?.id !== repositoryId ||
    pr.base?.ref !== c.base_branch ||
    pr.head?.repo?.id !== c.head_repository_id ||
    pr.head?.ref !== c.head_ref ||
    pr.head?.sha !== c.sha ||
    pr.state !== expectedState
  )
    throw new SkipEvent("Pull request changed before preview state update");
  return pr;
}

async function storeState(
  github: GitHub,
  repo: string,
  repoId: number,
  workflowId: number,
  project: string,
  pr: number,
  state: State,
): Promise<void> {
  const comments = await github.pages<any>(`${githubApi}/repos/${repo}/issues/${pr}/comments`);
  const own = comments.filter(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      comment.user?.type === "Bot" &&
      String(comment.body).includes(marker),
  );
  const records = own.map((comment) => ({
    comment,
    state: parseState(String(comment.body), repoId, pr, workflowId, project),
  }));
  records.sort(
    (a, b) =>
      compare(b.state.accepted, a.state.accepted) ||
      positive(b.comment.id) - positive(a.comment.id),
  );
  const target = records[0]?.comment;
  const body = commentBody(project, repo, state);
  if (target)
    await github.request(`${githubApi}/repos/${repo}/issues/comments/${positive(target.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  else
    await github.request(`${githubApi}/repos/${repo}/issues/${pr}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
}

function stateFrom(c: Candidate, repoId: number, current?: State, success?: Successful): State {
  const incoming = { run_number: c.run_number, attempt: c.attempt };
  const accepted = current && compare(current.accepted, incoming) > 0 ? current.accepted : incoming;
  return {
    version: 1,
    repository_id: repoId,
    pr: c.pr,
    workflow_id: c.workflow_id,
    accepted,
    status: {
      name: c.status,
      sha: c.sha,
      run_id: c.run_id,
      run_number: c.run_number,
      attempt: c.attempt,
    },
    last_success: success ?? current?.last_success ?? null,
  };
}

async function latestState(
  github: GitHub,
  repo: string,
  repoId: number,
  workflowId: number,
  project: string,
  pr: number,
): Promise<State | undefined> {
  const comments = await github.pages<any>(`${githubApi}/repos/${repo}/issues/${pr}/comments`);
  const records = comments
    .filter(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        comment.user?.type === "Bot" &&
        String(comment.body).includes(marker),
    )
    .map((comment) => ({
      id: positive(comment.id),
      state: parseState(String(comment.body), repoId, pr, workflowId, project),
    }));
  records.sort((a, b) => compare(b.state.accepted, a.state.accepted) || b.id - a.id);
  return records[0]?.state;
}

function candidateFromEnv(env: Env): Candidate {
  const candidate: Candidate = {
    pr: positive(env.PR),
    sha: need(env, "PR_HEAD").toLowerCase(),
    head_repository_id: positive(env.HEAD_REPOSITORY_ID),
    head_ref: need(env, "HEAD_REF"),
    base_branch: need(env, "BASE_BRANCH"),
    workflow_id: positive(env.WORKFLOW_ID),
    run_id: positive(env.RUN_ID, true),
    run_number: positive(env.RUN_NUMBER, true),
    attempt: positive(env.ATTEMPT, true),
    status: need(env, "PREVIEW_STATUS") as Status,
    deploy: env.SHOULD_DEPLOY === "true",
    artifact_id: positive(env.ARTIFACT_ID, true),
    closed: env.PR_CLOSED === "true",
  };
  if (
    !shaPattern.test(candidate.sha) ||
    /[\r\n]/.test(candidate.head_ref) ||
    !projectPattern.test(need(env, "INPUT_PROJECT_NAME"))
  )
    throw new Error("Invalid preview candidate inputs");
  if (candidate.base_branch !== need(env, "PREVIEW_BRANCH"))
    throw new Error("Preview branch is missing or changed");
  return candidate;
}

export async function prepare(
  env: Env,
  fetcher?: typeof fetch,
): Promise<{ should_deploy: boolean }> {
  let context: Awaited<ReturnType<typeof resolve>>;
  try {
    context = await resolve(env, fetcher, true);
  } catch (error) {
    if (error instanceof SkipEvent) {
      console.log(`::notice::${error.message}; stale preview event skipped`);
      return { should_deploy: false };
    }
    throw error;
  }
  const { candidate: resolved, github, repo, repositoryId } = context;
  const candidate = candidateFromEnv(env);
  for (const key of ["base_branch", "workflow_id"] as const)
    if (resolved[key] !== candidate[key])
      throw new Error("Preview configuration changed between association and publication");
  for (const key of [
    "pr",
    "sha",
    "head_repository_id",
    "head_ref",
    "run_id",
    "run_number",
    "attempt",
    "artifact_id",
    "closed",
  ] as const)
    if (resolved[key] !== candidate[key]) {
      console.log(
        "::notice::Source or PR identity changed while queued; stale preview event skipped",
      );
      return { should_deploy: false };
    }
  if (resolved.status !== candidate.status || resolved.deploy !== candidate.deploy) {
    console.log("::notice::Source status changed while queued; stale preview event skipped");
    return { should_deploy: false };
  }
  const project = need(env, "INPUT_PROJECT_NAME");
  try {
    await verifyCurrent(github, repo, repositoryId, candidate);
  } catch (error) {
    if (error instanceof SkipEvent) {
      console.log(`::notice::${error.message}; stale preview event skipped`);
      return { should_deploy: false };
    }
    throw error;
  }
  const current = await latestState(
    github,
    repo,
    repositoryId,
    candidate.workflow_id,
    project,
    candidate.pr,
  );
  if (
    current &&
    candidate.run_id > 0 &&
    compare(current.accepted, { run_number: candidate.run_number, attempt: candidate.attempt }) > 0
  ) {
    console.log("::notice::A newer source run is already accepted; stale preview event skipped");
    return { should_deploy: false };
  }
  let stateCandidate = candidate;
  if (
    env.GITHUB_EVENT_NAME === "pull_request_target" &&
    candidate.status === "Waiting for preview"
  ) {
    const priorSuccess = current?.last_success;
    if (
      current?.status.name === "Deploy successful!" &&
      current.status.sha === candidate.sha &&
      current.status.run_id === candidate.run_id &&
      compare(current.accepted, {
        run_number: candidate.run_number,
        attempt: candidate.attempt,
      }) === 0 &&
      priorSuccess?.sha === candidate.sha &&
      priorSuccess.run_id === candidate.run_id &&
      priorSuccess.run_number === candidate.run_number &&
      priorSuccess.attempt === candidate.attempt
    )
      stateCandidate = { ...candidate, status: "Deploy successful!" };
  }
  if (candidate.deploy) {
    const source = await sourceRun(
      github,
      repo,
      candidate.workflow_id,
      {
        id: candidate.run_id,
        run_attempt: candidate.attempt,
        run_number: candidate.run_number,
        workflow_id: candidate.workflow_id,
        repository: { id: repositoryId },
        head_repository: { id: candidate.head_repository_id },
        head_branch: candidate.head_ref,
        head_sha: candidate.sha,
        event: "pull_request",
        path: workflowPath,
        name: workflowName,
      },
      repositoryId,
      candidate.head_repository_id,
    );
    if (source.status !== "completed" || source.conclusion !== "success")
      throw new Error("Source build is no longer successful");
  }
  const reservation = stateFrom(stateCandidate, repositoryId, current);
  await storeState(
    github,
    repo,
    repositoryId,
    candidate.workflow_id,
    project,
    candidate.pr,
    reservation,
  );
  if (candidate.deploy) {
    const zip = path.resolve(need(env, "ZIP_PATH"));
    const downloadDir = path.resolve(need(env, "DOWNLOAD_DIR"));
    const buildDir = path.resolve(need(env, "BUILD_DIR"));
    const wranglerDir = path.resolve(need(env, "WRANGLER_DIR"));
    for (const dir of [zip, downloadDir, buildDir, wranglerDir])
      await fs.rm(dir, { recursive: true, force: true });
    try {
      await fs.mkdir(downloadDir, { recursive: false });
      await fs.mkdir(wranglerDir, { recursive: false });
      await downloadArtifact(need(env, "GITHUB_TOKEN"), repo, candidate.artifact_id, zip, fetcher);
      await extractZip(zip, buildDir);
    } catch (error) {
      await storeState(
        github,
        repo,
        repositoryId,
        candidate.workflow_id,
        project,
        candidate.pr,
        stateFrom({ ...candidate, status: "Deployment failed" }, repositoryId, reservation),
      );
      throw error;
    }
  }
  return { should_deploy: candidate.deploy };
}

export async function downloadArtifact(
  token: string,
  repository: string,
  artifactId: number,
  outputPath: string,
  fetcher: typeof fetch = fetch,
  maxBytes = 256 * 1024 * 1024,
): Promise<void> {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)))
    throw new Error("Invalid repository");
  const endpoint = new URL(
    `/repos/${parts.map(encodeURIComponent).join("/")}/actions/artifacts/${positive(artifactId)}/zip`,
    githubApi,
  );
  const response = await fetcher(endpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "manual",
  });
  let payload = response;
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Artifact redirect is missing a location");
    const signed = new URL(location, endpoint);
    if (signed.protocol !== "https:") throw new Error("Artifact redirect must use HTTPS");
    payload = await fetcher(signed, { redirect: "error" });
  }
  if (!payload.ok || !payload.body) throw new Error(`Artifact download failed (${payload.status})`);
  let bytes = 0;
  let created = false;
  const destination = createWriteStream(outputPath, { flags: "wx" });
  destination.once("open", () => {
    created = true;
  });
  try {
    await pipeline(
      payload.body,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new Error("Artifact exceeds download size limit");
          yield chunk;
        }
      },
      destination,
    );
  } catch (error) {
    if (created) await fs.rm(outputPath, { force: true });
    throw error;
  }
}

export async function guard(env: Env, fetcher: typeof fetch = fetch): Promise<void> {
  const account = need(env, "INPUT_ACCOUNT_ID");
  const project = need(env, "INPUT_PROJECT_NAME");
  if (!/^[A-Za-z0-9_-]+$/.test(account) || !projectPattern.test(project))
    throw new Error("Invalid Cloudflare account or project");
  const c = candidateFromEnv(env);
  const branch = `pr-${c.pr}`;
  const { github, repo, repositoryId } = await eventData(env, fetcher);
  await verifyCurrent(github, repo, repositoryId, c);
  const source = await sourceRun(
    github,
    repo,
    c.workflow_id,
    {
      id: c.run_id,
      run_attempt: c.attempt,
      run_number: c.run_number,
      workflow_id: c.workflow_id,
      repository: { id: repositoryId },
      head_repository: { id: c.head_repository_id },
      head_branch: c.head_ref,
      head_sha: c.sha,
      event: "pull_request",
      path: workflowPath,
      name: workflowName,
    },
    repositoryId,
    c.head_repository_id,
  );
  if (source.status !== "completed" || source.conclusion !== "success")
    throw new Error("Source build is no longer successful");
  const reserved = await latestState(github, repo, repositoryId, c.workflow_id, project, c.pr);
  if (
    !reserved ||
    compare(reserved.accepted, { run_number: c.run_number, attempt: c.attempt }) !== 0 ||
    reserved.status.name !== "Deploying" ||
    reserved.status.sha !== c.sha ||
    reserved.status.run_id !== c.run_id ||
    reserved.status.attempt !== c.attempt
  )
    throw new Error("Deployment reservation is missing, stale, or invalid");
  const actual = await cloudflareProductionBranch(env, fetcher);
  if (actual !== c.base_branch || actual === branch)
    throw new Error("Cloudflare production branch changed or conflicts with preview");
}

export async function finish(env: Env, fetcher?: typeof fetch): Promise<string> {
  const { github, repo, repositoryId } = await eventData(env, fetcher);
  const c = candidateFromEnv(env);
  const project = need(env, "INPUT_PROJECT_NAME");
  const current = await latestState(github, repo, repositoryId, c.workflow_id, project, c.pr);
  if (!current || compare(current.accepted, { run_number: c.run_number, attempt: c.attempt }) > 0)
    return "";
  try {
    await verifyCurrent(github, repo, repositoryId, c);
  } catch {
    console.log(
      "::notice::Pull request changed during deployment; no preview success was recorded",
    );
    return "";
  }
  let rechecked: Candidate;
  try {
    rechecked = (await resolve(env, fetcher)).candidate;
  } catch (error) {
    if (error instanceof SkipEvent) {
      console.log(
        "::notice::Source or pull request changed during deployment; no preview success was recorded",
      );
      return "";
    }
    throw error;
  }
  if (
    rechecked.sha !== c.sha ||
    rechecked.run_id !== c.run_id ||
    rechecked.run_number !== c.run_number ||
    rechecked.attempt !== c.attempt ||
    !rechecked.deploy
  ) {
    console.log(
      "::notice::Source build changed during deployment; no preview success was recorded",
    );
    return "";
  }
  const status = env.DEPLOY_OUTCOME === "success" ? "Deploy successful!" : "Deployment failed";
  let success = current.last_success;
  let deploymentUrl = "";
  if (status === "Deploy successful!") {
    const url = need(env, "DEPLOYMENT_URL");
    if (!validUrl(url, project, c.pr))
      throw new Error("Cloudflare action returned an invalid unique deployment URL");
    deploymentUrl = url;
    success = { url, sha: c.sha, run_id: c.run_id, run_number: c.run_number, attempt: c.attempt };
  }
  const next = stateFrom({ ...c, status }, repositoryId, current, success);
  await storeState(github, repo, repositoryId, c.workflow_id, project, c.pr, next);
  return deploymentUrl;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "project")
    await output(process.env, { production_branch: await project(process.env) });
  else if (mode === "associate") await output(process.env, await associate(process.env));
  else if (mode === "prepare") await output(process.env, await prepare(process.env));
  else if (mode === "guard") await guard(process.env);
  else if (mode === "finish")
    await output(process.env, { "deployment-url": await finish(process.env) });
  else throw new Error("Expected mode project, associate, prepare, guard, or finish");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Preview workflow failed");
    process.exitCode = 1;
  }
}
