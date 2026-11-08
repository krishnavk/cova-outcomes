"use strict";

// src/main.ts
var import_node_fs = require("node:fs");

// src/revert.ts
var LINE = /^Reverts ([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
var MAX_PAGES = 10;
function revertTargets(body, where) {
  const found = /* @__PURE__ */ new Set();
  for (const raw of body.split("\n")) {
    const m = LINE.exec(raw.replace(/\r$/, "").trim());
    if (!m) continue;
    if (m[1].toLowerCase() !== where.owner.toLowerCase() || m[2].toLowerCase() !== where.repo.toLowerCase()) continue;
    found.add(Number(m[3]));
  }
  return [...found];
}
async function revertedSince(io2, where, n, mergedAt) {
  const api = (io2.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const since = Date.parse(mergedAt);
  let latest = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${api}/repos/${where.owner}/${where.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    let listed;
    try {
      const res = await io2.fetch(url, {
        headers: {
          Authorization: `Bearer ${input(io2.env, "github-token")}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: AbortSignal.timeout(1e4)
      });
      if (!res.ok) return { fail: listingFailed(`GitHub answered ${res.status}`) };
      listed = await res.json();
    } catch (e) {
      return { fail: listingFailed(e instanceof Error ? e.message : String(e)) };
    }
    for (const pr of listed) {
      if (Date.parse(pr.updated_at) < since) return { at: latest };
      if (pr.merged_at && pr.number !== n && revertTargets(pr.body ?? "", where).includes(n)) {
        if (latest === null || Date.parse(pr.merged_at) > Date.parse(latest)) latest = pr.merged_at;
      }
    }
    if (listed.length < 100) return { at: latest };
  }
  return { fail: listingFailed(`more than ${MAX_PAGES * 100} closed pull requests were updated since it merged`) };
}
var listingFailed = (why) => `A re-run checks whether this pull request was reverted before posting merged, and could not (${why}). Nothing sent, so a revert is never undone.`;

// src/run.ts
var TITLE = "Cova Outcomes";
var RETRIES = 2;
var TIMEOUT_MS = 5e3;
var TEMPORARY = /* @__PURE__ */ new Set([408, 429]);
var escapeData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
var notice = (io2, message) => io2.log(`::notice title=${TITLE}::${escapeData(message)}`);
var warning = (io2, message) => io2.log(`::warning title=${TITLE}::${escapeData(message)}`);
var error = (io2, message) => io2.log(`::error title=${TITLE}::${escapeData(message)}`);
function input(env, name) {
  return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}
function repository(env) {
  const [owner, repo, ...rest] = (env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}
var unitId = (repo, n) => `${repo.toLowerCase()}#${n}`;
async function plan(io2) {
  const { env } = io2;
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    notice(io2, `Runs on pull_request events only; this is ${env.GITHUB_EVENT_NAME || "unknown"}. Nothing sent.`);
    return { posts: [] };
  }
  const event = JSON.parse(io2.readFile(env.GITHUB_EVENT_PATH ?? ""));
  const pr = event.pull_request;
  if (event.action !== "closed" || !pr) {
    notice(io2, `Reports closed pull requests only; this event is "${event.action ?? "unknown"}". Nothing sent.`);
    return { posts: [] };
  }
  if (input(env, "api-key") === "") {
    notice(io2, "No API key: GitHub passes no secrets to runs from forks. Nothing sent.");
    return { posts: [] };
  }
  const kind = input(env, "kind");
  if (kind === "") return { fail: "The kind input is empty: name the kind of work declared in CoreValue." };
  if (pr.user?.type === "Bot" && input(env, "include-bot-prs").toLowerCase() !== "true") {
    notice(io2, `#${pr.number} was written by a bot; set include-bot-prs: true to report it. Nothing sent.`);
    return { posts: [] };
  }
  const where = repository(env);
  if (!where) return { fail: `GITHUB_REPOSITORY "${env.GITHUB_REPOSITORY ?? ""}" is not owner/repo.` };
  if (!pr.merged || !pr.merged_at) {
    if (!pr.closed_at) return { fail: `#${pr.number} is closed but has no closed_at.` };
    return { posts: [{ kind, unit_id: unitId(where.repo, pr.number), outcome: "closed", at: pr.closed_at }] };
  }
  const posts = [];
  let own = { kind, unit_id: unitId(where.repo, pr.number), outcome: "merged", at: pr.merged_at };
  if (Number(env.GITHUB_RUN_ATTEMPT ?? "1") > 1) {
    const reverted = await revertedSince(io2, where, pr.number, pr.merged_at);
    if ("fail" in reverted) return reverted;
    if (reverted.at) own = { ...own, outcome: "reverted", at: reverted.at };
  }
  posts.push(own);
  for (const n of revertTargets(pr.body ?? "", where)) {
    posts.push({ kind, unit_id: unitId(where.repo, n), outcome: "reverted", at: pr.merged_at });
  }
  return { posts };
}
async function send(io2, post) {
  const url = `${input(io2.env, "api-url").replace(/\/+$/, "") || "https://api.corevalue.dev"}/v1/outcomes`;
  let last = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await io2.sleep(1e3 * attempt);
    try {
      const res = await io2.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${input(io2.env, "api-key")}`, "Content-Type": "application/json" },
        body: JSON.stringify(post),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (res.ok) return { sent: true };
      if (res.status < 500 && !TEMPORARY.has(res.status)) return { sent: false, refused: `${res.status}: ${await reason(res)}` };
      last = `${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  warning(io2, `CoreValue did not take ${post.unit_id} ${post.outcome} after ${RETRIES + 1} tries (${last}). Nothing else is affected; re-run the workflow to send it.`);
  return { sent: false };
}
async function reason(res) {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    const said = body.error ?? body.message;
    if (typeof said === "string" && said !== "") return said;
  } catch {
  }
  return text.slice(0, 300) || res.statusText || "no reason given";
}
async function run(io2) {
  const planned = await plan(io2);
  if ("fail" in planned) {
    error(io2, planned.fail);
    return true;
  }
  const lines = [];
  let failed = false;
  for (const post of planned.posts) {
    const result = await send(io2, post);
    if (result.sent) {
      io2.log(`cova-outcomes: sent ${post.unit_id} ${post.outcome} at ${post.at}`);
      lines.push(`- \`${post.unit_id}\` ${post.outcome}: sent`);
    } else if (result.refused) {
      error(io2, `CoreValue refused ${post.unit_id} ${post.outcome} (${result.refused}).`);
      lines.push(`- \`${post.unit_id}\` ${post.outcome}: refused (${result.refused})`);
      failed = true;
    } else {
      lines.push(`- \`${post.unit_id}\` ${post.outcome}: not sent, CoreValue unreachable`);
    }
  }
  if (lines.length > 0) io2.appendFile(io2.env.GITHUB_STEP_SUMMARY ?? "", `### ${TITLE}

${lines.join("\n")}
`);
  return failed;
}
async function main(io2) {
  try {
    return await run(io2);
  } catch (e) {
    error(io2, `Stopped by an internal error, nothing sent: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}

// src/main.ts
var io = {
  env: process.env,
  readFile: (path) => (0, import_node_fs.readFileSync)(path, "utf8"),
  appendFile: (path, text) => {
    if (path) (0, import_node_fs.appendFileSync)(path, text);
  },
  log: (line) => console.log(line),
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};
main(io).then((failed) => {
  process.exitCode = failed ? 1 : 0;
});
