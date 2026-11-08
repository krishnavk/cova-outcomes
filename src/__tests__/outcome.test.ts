/**
 * Cova Outcomes against a mock CoreValue and a mock GitHub
 * (cova-outcomes-action-spec.md, section 8). Criterion numbers are the spec's.
 */
import { describe, expect, it } from "vitest";
import { main, type Io } from "../run";
import { MAX_PAGES, revertTargets } from "../revert";

const MERGED_AT = "2026-11-02T10:00:00Z";
const CLOSED_AT = "2026-11-02T10:00:00Z";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Setup {
  event?: object;
  eventName?: string;
  inputs?: Record<string, string>;
  env?: Record<string, string>;
  /** CoreValue's answers, in order; the last repeats. */
  core?: Array<{ status: number; body?: unknown } | "network">;
  /** GitHub's pulls list pages; a number is a status code. */
  pulls?: Array<object[] | number>;
}

function harness(s: Setup) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const summary: string[] = [];
  const sleeps: number[] = [];
  const core = s.core ?? [{ status: 201, body: { data: {} } }];
  let coreAt = 0;
  const inputs = { "api-key": "sk-cova-test", kind: "feature-pr", "api-url": "https://core.test", "github-token": "ghs_test", ...s.inputs };
  const io: Io = {
    env: {
      GITHUB_EVENT_NAME: s.eventName ?? "pull_request",
      GITHUB_EVENT_PATH: "/event.json",
      GITHUB_REPOSITORY: "acme/API",
      GITHUB_API_URL: "https://gh.test",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: "/summary.md",
      ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])),
      ...s.env,
    },
    readFile: () => JSON.stringify(s.event ?? closed({ merged: true })),
    appendFile: (_p, text) => summary.push(text),
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
      calls.push({ url, method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("https://gh.test/")) {
        const page = Number(new URL(url).searchParams.get("page"));
        const answer = s.pulls?.[page - 1] ?? [];
        if (typeof answer === "number") return new Response("", { status: answer });
        return Response.json(answer);
      }
      const answer = core[Math.min(coreAt++, core.length - 1)]!;
      if (answer === "network") throw new TypeError("fetch failed");
      return Response.json(answer.body ?? {}, { status: answer.status });
    }) as typeof fetch,
  };
  return { io, calls, logs, summary, sleeps, posts: () => calls.filter((c) => c.method === "POST").map((c) => c.body) };
}

function closed(pr: { merged: boolean; number?: number; body?: string; userType?: string }) {
  return {
    action: "closed",
    pull_request: {
      number: pr.number ?? 12,
      merged: pr.merged,
      merged_at: pr.merged ? MERGED_AT : null,
      closed_at: CLOSED_AT,
      body: pr.body ?? "Adds the thing.",
      user: { type: pr.userType ?? "User" },
      title: "never sent",
      head: { ref: "never-sent" },
    },
  };
}

const listed = (number: number, body: string, mergedAt: string | null, updatedAt: string) => ({
  number,
  body,
  merged_at: mergedAt,
  updated_at: updatedAt,
});

describe("a closed pull request", () => {
  it("1: merged PR #12 in acme/API posts api#12 merged at its merge time, and nothing else", async () => {
    const h = harness({});
    expect(await main(h.io)).toBe(false);
    expect(h.posts()).toEqual([{ kind: "feature-pr", unit_id: "api#12", outcome: "merged", at: MERGED_AT }]);
    const post = h.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://core.test/v1/outcomes");
    expect(post.headers.Authorization).toBe("Bearer sk-cova-test");
    expect(h.summary.join("")).toContain("`api#12` merged: sent");
  });

  it("2: closed without merging posts closed at its close time", async () => {
    const h = harness({ event: closed({ merged: false }) });
    await main(h.io);
    expect(h.posts()).toEqual([{ kind: "feature-pr", unit_id: "api#12", outcome: "closed", at: CLOSED_AT }]);
  });

  it("a trailing slash on api-url is dropped", async () => {
    const h = harness({ inputs: { "api-url": "https://core.test/" } });
    await main(h.io);
    expect(h.calls[0]!.url).toBe("https://core.test/v1/outcomes");
  });
});

describe("reverts", () => {
  it("3: a merged revert posts merged for itself and reverted for the PR it names, at its merge time", async () => {
    const h = harness({ event: closed({ merged: true, number: 20, body: "Reverts acme/api#12\r\n\r\nBroke checkout." }) });
    await main(h.io);
    expect(h.posts()).toEqual([
      { kind: "feature-pr", unit_id: "api#20", outcome: "merged", at: MERGED_AT },
      { kind: "feature-pr", unit_id: "api#12", outcome: "reverted", at: MERGED_AT },
    ]);
  });

  it("4: a re-run of a PR reverted since posts reverted, not merged", async () => {
    const h = harness({
      env: { GITHUB_RUN_ATTEMPT: "2" },
      pulls: [[
        listed(20, "Reverts acme/API#12", "2026-11-03T09:00:00Z", "2026-11-03T09:00:01Z"),
        listed(12, "Adds the thing.", MERGED_AT, MERGED_AT),
        listed(9, "older", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"),
      ]],
    });
    expect(await main(h.io)).toBe(false);
    expect(h.posts()).toEqual([{ kind: "feature-pr", unit_id: "api#12", outcome: "reverted", at: "2026-11-03T09:00:00Z" }]);
    const list = h.calls.find((c) => c.method === "GET")!;
    expect(list.url).toBe("https://gh.test/repos/acme/API/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=1");
    expect(list.headers.Authorization).toBe("Bearer ghs_test");
  });

  it("a re-run with no revert posts merged; a first run never reads GitHub", async () => {
    const rerun = harness({ env: { GITHUB_RUN_ATTEMPT: "3" }, pulls: [[listed(12, "Adds the thing.", MERGED_AT, MERGED_AT)]] });
    await main(rerun.io);
    expect(rerun.posts()).toEqual([{ kind: "feature-pr", unit_id: "api#12", outcome: "merged", at: MERGED_AT }]);
    const first = harness({});
    await main(first.io);
    expect(first.calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("11: a re-run whose listing fails posts nothing and fails the step with the reason", async () => {
    const h = harness({ env: { GITHUB_RUN_ATTEMPT: "2" }, pulls: [500] });
    expect(await main(h.io)).toBe(true);
    expect(h.posts()).toEqual([]);
    expect(h.logs.join("\n")).toMatch(/::error title=Cova Outcomes::A re-run checks whether.*GitHub answered 500/);
  });

  it("a re-run that would read more than the page cap posts nothing and fails", async () => {
    const page = Array.from({ length: 100 }, (_, i) => listed(1000 + i, "", "2026-11-05T00:00:00Z", "2026-11-05T00:00:00Z"));
    const h = harness({ env: { GITHUB_RUN_ATTEMPT: "2" }, pulls: Array.from({ length: MAX_PAGES + 1 }, () => page) });
    expect(await main(h.io)).toBe(true);
    expect(h.posts()).toEqual([]);
  });

  it("paging stops at the first PR updated before this one merged, even inside a full page", async () => {
    const fresh = Array.from({ length: 50 }, (_, i) => listed(2000 + i, "", "2026-11-05T00:00:00Z", "2026-11-05T00:00:00Z"));
    const stale = Array.from({ length: 50 }, (_, i) => listed(100 + i, "Reverts acme/api#12", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"));
    const h = harness({ env: { GITHUB_RUN_ATTEMPT: "2" }, pulls: [[...fresh, ...stale], [listed(7, "Reverts acme/api#12", MERGED_AT, "2026-11-09T00:00:00Z")]] });
    await main(h.io);
    expect(h.calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(h.posts()).toEqual([{ kind: "feature-pr", unit_id: "api#12", outcome: "merged", at: MERGED_AT }]);
  });

  it("a near miss in the re-run listing does not revert PR #12", async () => {
    const h = harness({
      env: { GITHUB_RUN_ATTEMPT: "2" },
      pulls: [[listed(20, "Reverts acme/api#123", "2026-11-03T09:00:00Z", "2026-11-03T09:00:01Z"), listed(21, "Reverts other/api#12", "2026-11-03T09:00:00Z", "2026-11-03T09:00:01Z")]],
    });
    await main(h.io);
    expect(h.posts()).toEqual([{ kind: "feature-pr", unit_id: "api#12", outcome: "merged", at: MERGED_AT }]);
  });

  it("11: near misses name nothing; the exact line matches in any case", () => {
    const where = { owner: "acme", repo: "api" };
    expect(revertTargets("Reverts acme/api#123", where)).toEqual([123]); // #123, never #12
    expect(revertTargets("Reverts other/api#12", where)).toEqual([]);
    expect(revertTargets("Reverts acme/api#12 and more", where)).toEqual([]);
    expect(revertTargets("This Reverts acme/api#12", where)).toEqual([]);
    expect(revertTargets("Reverts #12", where)).toEqual([]);
    expect(revertTargets("  Reverts ACME/Api#12  \r", where)).toEqual([12]);
    expect(revertTargets("Reverts acme/api#12\nReverts acme/api#12\nReverts acme/api#14", where)).toEqual([12, 14]);
  });
});

describe("what sends nothing", () => {
  it("5: no API key (a fork or Dependabot run) exits 0 with a notice", async () => {
    const h = harness({ inputs: { "api-key": "" } });
    expect(await main(h.io)).toBe(false);
    expect(h.calls).toEqual([]);
    expect(h.logs.join("\n")).toContain("::notice title=Cova Outcomes::No API key");
  });

  it("10: a bot's PR is skipped unless include-bot-prs is true", async () => {
    const bot = harness({ event: closed({ merged: true, userType: "Bot" }) });
    expect(await main(bot.io)).toBe(false);
    expect(bot.calls).toEqual([]);
    const included = harness({ event: closed({ merged: true, userType: "Bot" }), inputs: { "include-bot-prs": "true" } });
    await main(included.io);
    expect(included.posts()).toHaveLength(1);
  });

  it("another event, or a PR not closed, sends nothing", async () => {
    const push = harness({ eventName: "push" });
    expect(await main(push.io)).toBe(false);
    expect(push.calls).toEqual([]);
    const opened = harness({ event: { action: "opened", pull_request: { number: 12 } } });
    expect(await main(opened.io)).toBe(false);
    expect(opened.calls).toEqual([]);
  });

  it("an empty kind fails the step", async () => {
    const h = harness({ inputs: { kind: "" } });
    expect(await main(h.io)).toBe(true);
    expect(h.calls).toEqual([]);
  });
});

describe("6: CoreValue's answers", () => {
  it("a 5xx is retried twice, then the step warns and succeeds", async () => {
    const h = harness({ core: [{ status: 503 }] });
    expect(await main(h.io)).toBe(false);
    expect(h.posts()).toHaveLength(3);
    expect(h.sleeps).toEqual([1000, 2000]);
    expect(h.logs.join("\n")).toMatch(/::warning title=Cova Outcomes::CoreValue did not take api#12 merged after 3 tries \(503\)/);
  });

  it("a network error is retried; a later success sends it", async () => {
    const h = harness({ core: ["network", { status: 201 }] });
    expect(await main(h.io)).toBe(false);
    expect(h.posts()).toHaveLength(2);
    expect(h.summary.join("")).toContain("sent");
  });

  it("a 429 or 408 is temporary: retried, then a warning, and the step succeeds", async () => {
    for (const status of [429, 408]) {
      const h = harness({ core: [{ status }] });
      expect(await main(h.io)).toBe(false);
      expect(h.posts()).toHaveLength(3);
    }
  });

  it("Core's reason cannot split the annotation or start another workflow command", async () => {
    const h = harness({ core: [{ status: 400, body: { error: "bad\n::add-mask::x 100%" } }] });
    expect(await main(h.io)).toBe(true);
    const line = h.logs.find((l) => l.startsWith("::error"))!;
    expect(line).toContain("bad%0A::add-mask::x 100%25");
    expect(line).not.toContain("\n");
  });

  it("a 4xx fails the step with Core's reason and is not retried", async () => {
    const h = harness({ core: [{ status: 404, body: { error: 'No work unit kind "feature-pr".' } }] });
    expect(await main(h.io)).toBe(true);
    expect(h.posts()).toHaveLength(1);
    expect(h.logs.join("\n")).toContain('CoreValue refused api#12 merged (404: No work unit kind "feature-pr".)');
  });
});
