// GitHub. The Learning Skill's approval mechanism.
//
// DECIDED: propose then approve, no automatic edits. On this stack approval is a pull
// request. Alex approves by merging, Netlify redeploys on merge, and nothing changes
// until then. That gives approval, history and rollback for free: revert the PR and the
// old behavior is back.
//
// The token is scoped to this one repo with contents and pull request write. Nothing wider.

import { httpJson } from "../lib/http.js";

const API = "https://api.github.com";

function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "turnpups-mos",
  };
}

async function gh(pathname, { token, method = "GET", body, logger, fetchImpl, config }) {
  const http = config?.system?.http ?? {};
  const { body: result } = await httpJson(`${API}${pathname}`, {
    method,
    headers: headers(token),
    body,
    logger,
    label: `github ${method} ${pathname}`,
    fetchImpl,
    timeoutMs: http.timeoutMs ?? 30000,
    maxAttempts: http.maxAttempts ?? 5,
    backoffMsSchedule: http.backoffMsSchedule ?? [1000, 2000, 4000, 8000],
  });
  return result;
}

/**
 * Opens a pull request containing one file change.
 *
 * Deliberately one file per PR. A proposal Alex can read in ten seconds gets merged. A
 * proposal that rewrites four files does not.
 */
export async function openProposalPr({
  repo,
  baseBranch = "main",
  filePath,
  newContent,
  title,
  body,
  branchName,
  token,
  logger,
  fetchImpl,
  config,
}) {
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  if (!repo) throw new Error("GITHUB_REPO is not set");

  const base = await gh(`/repos/${repo}/git/ref/heads/${baseBranch}`, { token, logger, fetchImpl, config });
  const baseSha = base.object.sha;

  const branch = branchName ?? `mos/learning-${Date.now()}`;
  await gh(`/repos/${repo}/git/refs`, {
    token,
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
    logger,
    fetchImpl,
    config,
  });

  // The file's current sha is required to update it rather than create it.
  let existingSha = null;
  try {
    const existing = await gh(`/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${baseBranch}`, {
      token,
      logger,
      fetchImpl,
      config,
    });
    existingSha = existing.sha;
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  await gh(`/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`, {
    token,
    method: "PUT",
    body: {
      message: title,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    },
    logger,
    fetchImpl,
    config,
  });

  const pr = await gh(`/repos/${repo}/pulls`, {
    token,
    method: "POST",
    body: { title, head: branch, base: baseBranch, body },
    logger,
    fetchImpl,
    config,
  });

  logger?.info("github.pr_opened", { repo, branch, filePath, number: pr.number, url: pr.html_url });
  return { number: pr.number, url: pr.html_url, branch, filePath };
}

export async function readFileFromRepo({ repo, filePath, ref = "main", token, logger, fetchImpl, config }) {
  const result = await gh(`/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${ref}`, {
    token,
    logger,
    fetchImpl,
    config,
  });
  return Buffer.from(result.content, "base64").toString("utf8");
}
