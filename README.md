# Cloudflare Pages PR Previews

A composite action for static previews of **fork pull requests**. It downloads the successful PR build artifact, validates and extracts it without executing artifact code, then deploys it with Cloudflare Wrangler. It updates one bot-authored PR comment as the build and deployment progress.

The caller listens for fork `pull_request_target` lifecycle events and the named PR CI workflow's `workflow_run` events. It does not listen for `push`; keep push CI in a separate workflow. Same-repository PRs are skipped. `pull_request_target` validates PR metadata, updates the comment, and reads trusted Cloudflare project configuration; only a successful `workflow_run` completion can download an artifact or deploy.

The source workflow is intentionally fixed to `.github/workflows/pr.yml` with the display name `PR CI`. The artifact must be named `build-<run-id>-<attempt>` and contain a regular root `index.html`.

## Caller setup

Add a PR build workflow named `PR CI` at `.github/workflows/pr.yml`. Build a static site into a directory whose root contains `index.html`, then upload that directory as a GitHub Actions artifact. The upload action must be pinned to its reviewed full commit SHA, and its artifact name must include both run ID and attempt:

```yaml
name: PR CI
on:
  pull_request:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # Checkout and build the PR here. Do not expose deployment secrets to this workflow.
      - name: Upload static site
        uses: actions/upload-artifact@<reviewed-full-commit-SHA>
        with:
          name: build-${{ github.run_id }}-${{ github.run_attempt }}
          path: dist/
          if-no-files-found: error
```

Add a caller workflow (for example `.github/workflows/pages-preview.yml`) to handle the trusted PR lifecycle and source CI progress. Replace `<full-commit-SHA>` with the reviewed commit SHA for this repository; do not use a mutable tag or branch. Keep push CI in a separate workflow. The caller job is restricted to fork pull requests; the action also validates the source itself.

```yaml
name: Pages Preview
on:
  pull_request_target:
    types: [opened, reopened, synchronize, closed]
  workflow_run:
    workflows: [PR CI]
    types: [in_progress, completed]
permissions: {}
jobs:
  preview:
    permissions:
      actions: read
      contents: read
      pull-requests: write
    if: >-
      (github.event_name == 'workflow_run' &&
       github.event.workflow_run.event == 'pull_request' &&
       github.event.workflow_run.head_repository.id != github.repository_id) ||
      (github.event_name == 'pull_request_target' &&
       github.event.pull_request.head.repo != null &&
       github.event.pull_request.head.repo.id != github.repository_id)
    concurrency:
      group: pages-preview-${{ github.repository_id }}-${{ github.event.pull_request.head.repo.id || github.event.workflow_run.head_repository.id }}-${{ github.event.pull_request.head.ref || github.event.workflow_run.head_branch }}
      queue: max
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      - uses: ybw0014/cloudflare-pages-pr-preview@<full-commit-SHA>
        with:
          account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          project-name: your-pages-project
          api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

The fork's first workflow run may require a maintainer to approve it in GitHub Actions. Until a build starts, the PR comment reports **Waiting for build**; it does not imply that the contribution has been approved.

## Inputs and permissions

- `account-id` and `project-name` are required. The project name must be lowercase letters, digits, and single hyphens.
- The project lookup reads Cloudflare's configured production branch; only pull requests targeting that branch are previewed. GitHub's default branch is not used for selection.
- Pass `api-token` from `secrets.CLOUDFLARE_API_TOKEN` as shown; do not use `secrets: inherit`. The token is exposed only to the trusted project lookup and the official Wrangler deployment step/guard. Use an account-scoped token with only the Cloudflare Pages permissions needed to deploy and read project configuration. Cloudflare does not offer per-project token scope, so that permission applies to every Pages project in the account; use a dedicated account if that blast radius is unacceptable.
- The caller grants only `actions: read`, `contents: read`, and `pull-requests: write`. The action never checks out caller or PR source code; its own pinned action source is used to run the trusted scripts.
- The `api-token` input must be supplied from a GitHub secret as shown, not a literal. GitHub masks secret values; do not pass tokens from untrusted workflow data.
- Fork build artifacts are treated as untrusted data; their JavaScript, Wrangler configuration, and Functions are never executed.
- Caller concurrency serializes both event types by fork head repository ID and branch, so the `pull_request_target` and `workflow_run` events for the same head queue together. Different caller repositories are not mutually serialized; use a distinct Pages project per caller repository.
- Same-repository PRs are skipped; the caller's fork-only job condition prevents a deployment comment, but GitHub may still display the skipped action/job record.

Each caller repository must use its **own Cloudflare Pages project**. Preview branch names are `pr-<PR number>`, so sharing a project between repositories can make PR numbers collide.

## Limits and operational notes

- ZIP download: 256 MiB; at most 20,000 entries; each file at most 25 MiB; expanded archive at most 1 GiB. Unsafe paths, duplicate/conflicting paths, symlinks, special files, and a root `_worker.js` are rejected.
- There is no preview search index or cleanup. Closing a PR updates its comment but does not delete Cloudflare deployments.
- Cloudflare deployment and GitHub PR updates are not atomic. If the PR changes or closes while an upload is in progress, the completed deployment may exist but its URL is not recorded as the new successful preview. A maintainer deleting the bot comment removes its accepted-run watermark and weakens rollback protection; do not edit or delete the metadata marker.
- The action does not run arbitrary PR scripts in the privileged job and does not search for or recover deployments outside the source artifact.
- Node 26 is required to run the repository's TypeScript source directly. The caller's Actions runner uses the supported Node runtime for pinned GitHub Actions, which may differ.

## Development

Use Bun for dependency installation and project commands:

```sh
bun ci
bun run format:check
bun run lint -- --max-warnings 0
bun run typecheck
node --test test/*.test.ts
```
