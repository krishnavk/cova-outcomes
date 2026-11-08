/**
 * Reverts (cova-outcomes-action-spec.md, "Reverts"). GitHub's Revert button
 * writes a body line `Reverts owner/repo#n`. A line counts only when it is
 * exactly that, for this repository and one PR number: `Reverts acme/api#123`
 * is not #12, and `Reverts acme/api#12 and more` is nothing.
 */
import type { Io } from "./run";
import { input } from "./run";

const LINE = /^Reverts ([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/;
/** Pages of 100 closed PRs, most recently updated first, read before giving up. */
export const MAX_PAGES = 10;

interface Where {
  owner: string;
  repo: string;
}

/** The PR numbers in this repository that a body's exact `Reverts` lines name. */
export function revertTargets(body: string, where: Where): number[] {
  const found = new Set<number>();
  for (const raw of body.split("\n")) {
    const m = LINE.exec(raw.replace(/\r$/, "").trim());
    if (!m) continue;
    if (m[1]!.toLowerCase() !== where.owner.toLowerCase() || m[2]!.toLowerCase() !== where.repo.toLowerCase()) continue;
    found.add(Number(m[3]));
  }
  return [...found];
}

interface Listed {
  number: number;
  merged_at: string | null;
  updated_at: string;
  body: string | null;
}

/**
 * Before posting merged: whether a merged PR closed since this one reverts it, and when
 * it merged. Reads the pulls list (not search, which ignores `#` and `/` and
 * lags) by most recently updated, and stops at the first PR last updated
 * before this one merged: a later revert was updated when it merged.
 */
export async function revertedSince(
  io: Io,
  where: Where,
  n: number,
  mergedAt: string
): Promise<{ at: string | null } | { fail: string }> {
  const api = (io.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const since = Date.parse(mergedAt);
  let latest: string | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${api}/repos/${where.owner}/${where.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    let listed: Listed[];
    try {
      const res = await io.fetch(url, {
        headers: {
          Authorization: `Bearer ${input(io.env, "github-token")}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { fail: listingFailed(`GitHub answered ${res.status}`) };
      listed = (await res.json()) as Listed[];
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

const listingFailed = (why: string) =>
  `Before posting merged, Cova Outcomes checks whether this pull request was reverted, and could not (${why}). Nothing sent, so a revert is never undone; re-run the workflow to try again.`;
