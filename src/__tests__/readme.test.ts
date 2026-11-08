/**
 * Criterion 9: the README's workflow asks for `pull-requests: read` and
 * nothing more, triggers on closed pull requests only, never on
 * pull_request_target, and uses the inputs action.yml declares.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const action = readFileSync(new URL("../../action.yml", import.meta.url), "utf8");
const workflow = /```yaml\n([\s\S]*?)```/.exec(readme)?.[1] ?? "";

/** The indented lines under a top-level key. */
function block(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `${key}:`);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith(" ")) break;
    if (line.trim() !== "") out.push(line.trim());
  }
  return out;
}

describe("the README's workflow", () => {
  it("asks for pull-requests: read and nothing more", () => {
    expect(block(workflow, "permissions")).toEqual(["pull-requests: read"]);
  });

  it("runs on closed pull requests, never pull_request_target", () => {
    expect(block(workflow, "on")).toEqual(["pull_request:", "types: [closed]"]);
    expect(workflow).not.toContain("pull_request_target");
  });

  it("passes only inputs action.yml declares, the key from a secret", () => {
    const declared = [...action.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]);
    const used = [...workflow.matchAll(/^ {10}([a-z-]+):/gm)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(declared).toContain(name);
    expect(workflow).toContain("api-key: ${{ secrets.COVA_API_KEY }}");
  });
});
