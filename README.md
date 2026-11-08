# Cova Outcomes

<!-- DRAFT: every line of this README waits for the owner's sign-off. -->

Reports each merged or closed pull request to [CoreValue](https://www.corevalue.dev) as the outcome of a unit of work, so its AI cost meets what the work became: merged, closed or reverted.

CoreValue then shows cost per merged pull request in **Reports › Work economics**, including the Claude Code and Codex calls your developers sync with `cova` when the kind counts coding agents.

## Set up

1. In CoreValue, declare a kind of work for pull requests, with success outcome `merged`. To count coding agents, set **Coding agents** to **Pull requests**.
2. Create an API key in CoreValue, on a team, with nothing beyond what sending outcomes needs. Add it to the repository's secrets as `COVA_API_KEY`.
3. Add this workflow as `.github/workflows/cova-outcomes.yml`:

```yaml
name: Cova Outcomes
on:
  pull_request:
    types: [closed]
permissions:
  pull-requests: read
jobs:
  outcome:
    runs-on: ubuntu-latest
    steps:
      - uses: krishnavk/cova-outcomes@v0.1.0
        with:
          api-key: ${{ secrets.COVA_API_KEY }}
          kind: feature-pr      # the kind of work declared in CoreValue
```

## What is sent

For each closed pull request, one request to CoreValue:

| Field | Value |
| --- | --- |
| `kind` | the `kind` input |
| `unit_id` | the repository name and number, such as `api#12`, in lower case and without the owner |
| `outcome` | `merged`, or `closed` when closed without merging, or `reverted` (below) |
| `at` | when it merged or closed |

Never sent: the diff, title, body, branch, author or reviewers. The repository name and number are pseudonymous, not anonymous: anyone with access to the repository can look the pull request up.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `api-key` | (required) | The CoreValue API key. |
| `kind` | (required) | The kind of work declared in CoreValue. |
| `api-url` | `https://api.corevalue.dev` | Change it only for a self-hosted CoreValue. |
| `include-bot-prs` | `false` | `true` also reports pull requests written by bots, such as Dependabot and Renovate. They are skipped by default so dependency bumps do not count as merged work. |
| `github-token` | the workflow's token | Reads pull requests to check a merged one was not reverted since (below). Needs `pull-requests: read`. |

## Reverts

When a merged pull request's description has the line GitHub's **Revert** button writes, `Reverts owner/repo#12`, the pull request it names is reported as `reverted`, at the revert's merge time. The line must be exactly that, for this repository.

- A reverted pull request moves to the month of the revert in Work economics.
- **Never merged over a revert.** Before reporting a pull request as merged, Cova Outcomes checks whether a later merged pull request reverted it, and reports `reverted` if so. This covers a re-run, and a run that waited in the queue while the revert merged. If it cannot check, it sends nothing and the step fails with the reason; re-run it to try again.
- **A revert of a revert** puts the change back, but the original pull request stays `reverted`. Count the pull request that re-lands the change as the work.
- **A revert of a pull request merged before you installed Cova Outcomes** creates a unit that exists only as `reverted`. It is not a success, and it carries any cost tagged with it.

## Worth knowing

- **One sender per kind.** Each report replaces what CoreValue holds for that pull request, including a people-cost estimate or quality score another sender set. Do not send those from elsewhere for a kind Cova Outcomes reports.
- **Same-named repositories.** `acme/api#12` and `other/api#12` are the same unit. Use a different kind for each, or keep repository names unique.
- **Forks.** GitHub does not pass secrets to `pull_request` runs from forks, so those report nothing; the step succeeds with a notice. Do not switch to `pull_request_target` to get around it: that runs with your secrets on code you have not reviewed.
- **Bots.** Pull requests written by bots, such as Dependabot, are skipped unless `include-bot-prs` is `true`.
- **CoreValue unreachable or busy.** Each report is retried twice. If CoreValue still does not answer, or asks to slow down, the step warns and succeeds; re-run the workflow later to send it. If CoreValue refuses a report (an unknown kind, a revoked key), the step fails with CoreValue's reason.

## License

Apache-2.0
