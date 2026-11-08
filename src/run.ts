/**
 * Cova Outcomes: on a closed pull request, post its outcome to CoreValue's
 * `POST /v1/outcomes` (cova-outcomes-action-spec.md).
 *
 * Sent per post: the kind, `repo#n` (lower case, owner dropped, the form
 * CoreValue joins coding-agent calls on), `merged`, `closed` or `reverted`,
 * and its time. Never the diff, title, body, branch, author or reviewers.
 *
 * Core unreachable never blocks a merge: a 5xx or network error is retried
 * twice, then the step warns and succeeds. Core refusing a post (4xx) fails
 * the step with Core's reason, because the set-up is wrong.
 */
import { revertTargets, revertedSince } from "./revert";

export interface Io {
  env: Record<string, string | undefined>;
  readFile(path: string): string;
  appendFile(path: string, text: string): void;
  log(line: string): void;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export type Outcome = "merged" | "closed" | "reverted";

export interface Post {
  kind: string;
  unit_id: string;
  outcome: Outcome;
  at: string;
}

interface PullRequest {
  number: number;
  merged?: boolean;
  merged_at?: string | null;
  closed_at?: string | null;
  body?: string | null;
  user?: { type?: string } | null;
}

const TITLE = "Cova Outcomes";
const RETRIES = 2;
const TIMEOUT_MS = 5_000;
const TEMPORARY = new Set([408, 429]);

/** A workflow command's message, encoded so text from Core cannot split it or start another command. */
export const escapeData = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const notice = (io: Io, message: string) => io.log(`::notice title=${TITLE}::${escapeData(message)}`);
export const warning = (io: Io, message: string) => io.log(`::warning title=${TITLE}::${escapeData(message)}`);
const error = (io: Io, message: string) => io.log(`::error title=${TITLE}::${escapeData(message)}`);

export function input(env: Io["env"], name: string): string {
  return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

/** The repository's owner and name from `GITHUB_REPOSITORY` (`owner/repo`). */
function repository(env: Io["env"]): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = (env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo || rest.length > 0) return null;
  return { owner, repo };
}

/** The unit id CoreValue joins on: `repo#n`, lower case, owner dropped. */
export const unitId = (repo: string, n: number) => `${repo.toLowerCase()}#${n}`;

/**
 * What to post for one run. Returns the posts, nothing (with the reason
 * already logged), or a failure reason.
 */
export async function plan(io: Io): Promise<{ posts: Post[] } | { fail: string }> {
  const { env } = io;
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    notice(io, `Runs on pull_request events only; this is ${env.GITHUB_EVENT_NAME || "unknown"}. Nothing sent.`);
    return { posts: [] };
  }
  const event = JSON.parse(io.readFile(env.GITHUB_EVENT_PATH ?? "")) as { action?: string; pull_request?: PullRequest };
  const pr = event.pull_request;
  if (event.action !== "closed" || !pr) {
    notice(io, `Reports closed pull requests only; this event is "${event.action ?? "unknown"}". Nothing sent.`);
    return { posts: [] };
  }
  if (input(env, "api-key") === "") {
    notice(io, "No API key: GitHub passes no secrets to runs from forks. Nothing sent.");
    return { posts: [] };
  }
  const kind = input(env, "kind");
  if (kind === "") return { fail: "The kind input is empty: name the kind of work declared in CoreValue." };
  if (pr.user?.type === "Bot" && input(env, "include-bot-prs").toLowerCase() !== "true") {
    notice(io, `#${pr.number} was written by a bot; set include-bot-prs: true to report it. Nothing sent.`);
    return { posts: [] };
  }
  const where = repository(env);
  if (!where) return { fail: `GITHUB_REPOSITORY "${env.GITHUB_REPOSITORY ?? ""}" is not owner/repo.` };

  if (!pr.merged || !pr.merged_at) {
    if (!pr.closed_at) return { fail: `#${pr.number} is closed but has no closed_at.` };
    return { posts: [{ kind, unit_id: unitId(where.repo, pr.number), outcome: "closed", at: pr.closed_at }] };
  }

  const posts: Post[] = [];
  let own: Post = { kind, unit_id: unitId(where.repo, pr.number), outcome: "merged", at: pr.merged_at };
  // Never post merged over a revert: a re-run, or a run that queued while
  // its revert merged and reported first (owner, 2026-11-08: every run).
  const reverted = await revertedSince(io, where, pr.number, pr.merged_at);
  if ("fail" in reverted) return reverted;
  if (reverted.at) own = { ...own, outcome: "reverted", at: reverted.at };
  posts.push(own);
  for (const n of revertTargets(pr.body ?? "", where)) {
    posts.push({ kind, unit_id: unitId(where.repo, n), outcome: "reverted", at: pr.merged_at });
  }
  return { posts };
}

type Sent = { sent: true } | { sent: false; refused?: string };

/** One post, retried on a 5xx or network error. */
export async function send(io: Io, post: Post): Promise<Sent> {
  const url = `${input(io.env, "api-url").replace(/\/+$/, "") || "https://api.corevalue.dev"}/v1/outcomes`;
  let last = "";
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await io.sleep(1_000 * attempt);
    try {
      const res = await io.fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${input(io.env, "api-key")}`, "Content-Type": "application/json" },
        body: JSON.stringify(post),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return { sent: true };
      // 408 and 429 are temporary, like a 5xx: retried, then a warning.
      if (res.status < 500 && !TEMPORARY.has(res.status)) return { sent: false, refused: `${res.status}: ${await reason(res)}` };
      last = `${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  warning(io, `CoreValue did not take ${post.unit_id} ${post.outcome} after ${RETRIES + 1} tries (${last}). Nothing else is affected; re-run the workflow to send it.`);
  return { sent: false };
}

async function reason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown };
    const said = body.error ?? body.message;
    if (typeof said === "string" && said !== "") return said;
  } catch {
    // Not JSON: use the text.
  }
  return text.slice(0, 300) || res.statusText || "no reason given";
}

/** The run. Returns whether the step fails. */
export async function run(io: Io): Promise<boolean> {
  const planned = await plan(io);
  if ("fail" in planned) {
    error(io, planned.fail);
    return true;
  }
  const lines: string[] = [];
  let failed = false;
  for (const post of planned.posts) {
    const result = await send(io, post);
    if (result.sent) {
      io.log(`cova-outcomes: sent ${post.unit_id} ${post.outcome} at ${post.at}`);
      lines.push(`- \`${post.unit_id}\` ${post.outcome}: sent`);
    } else if (result.refused) {
      error(io, `CoreValue refused ${post.unit_id} ${post.outcome} (${result.refused}).`);
      lines.push(`- \`${post.unit_id}\` ${post.outcome}: refused (${result.refused})`);
      failed = true;
    } else {
      lines.push(`- \`${post.unit_id}\` ${post.outcome}: not sent, CoreValue unreachable`);
    }
  }
  if (lines.length > 0) io.appendFile(io.env.GITHUB_STEP_SUMMARY ?? "", `### ${TITLE}\n\n${lines.join("\n")}\n`);
  return failed;
}

/** The entry point: a crash is logged and fails the step, so a broken set-up is seen. */
export async function main(io: Io): Promise<boolean> {
  try {
    return await run(io);
  } catch (e) {
    error(io, `Stopped by an internal error, nothing sent: ${e instanceof Error ? e.message : String(e)}`);
    return true;
  }
}
