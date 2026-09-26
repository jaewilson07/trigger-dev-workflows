import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubAccessError,
  runFailureAlertSweep,
  type FiledResult,
  type GitHubIssueClient,
} from "./failureAlertReporter.js";
import type { RawRun } from "./failureAlertCore.js";
import { MONITORED_PROJECTS } from "./failureRepoMap.js";

function run(overrides: Partial<RawRun> & { taskIdentifier: string; status: string; createdAt: string }): RawRun {
  return {
    id: overrides.id ?? `run_${Math.random().toString(36).slice(2)}`,
    friendlyId: overrides.friendlyId ?? null,
    version: overrides.version ?? "v1",
    error: overrides.error,
    ...overrides,
  };
}

/** A fake GitHubIssueClient with in-memory state, keyed by the repo it was built for. */
function makeFakeClientFactory() {
  const issuesByRepo = new Map<string, Array<{ number: number; body: string; comments: string[] }>>();
  const calls: Array<{ repo: string; op: string }> = [];
  let nextNumber = 1;

  const factory = (_ghToken: string, repo: string): GitHubIssueClient => ({
    async findByFingerprint(fingerprint) {
      calls.push({ repo, op: "findByFingerprint" });
      const issues = issuesByRepo.get(repo) ?? [];
      const match = issues.find((i) => i.body.includes(`trigger-failure:${fingerprint}`));
      return match ? { number: match.number, html_url: `https://github.com/${repo}/issues/${match.number}` } : null;
    },
    async createIssue(_title, body, _labels) {
      calls.push({ repo, op: "createIssue" });
      const arr = issuesByRepo.get(repo) ?? [];
      const number = nextNumber++;
      arr.push({ number, body, comments: [] });
      issuesByRepo.set(repo, arr);
      return { number, html_url: `https://github.com/${repo}/issues/${number}` };
    },
    async commentOnIssue(issueNumber, body) {
      calls.push({ repo, op: "commentOnIssue" });
      const arr = issuesByRepo.get(repo) ?? [];
      const issue = arr.find((i) => i.number === issueNumber);
      issue?.comments.push(body);
    },
    async getLastCommentAt(issueNumber) {
      const arr = issuesByRepo.get(repo) ?? [];
      const issue = arr.find((i) => i.number === issueNumber);
      if (!issue || issue.comments.length === 0) return null;
      return new Date(); // "just now" -> throttled, unless a test wants otherwise
    },
  });

  return { factory, issuesByRepo, calls };
}

test("runFailureAlertSweep: creates one issue per task with >=2 consecutive failures", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? runs : []),
    makeClient: factory,
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.filed.length, 1);
  const filed = result.filed[0] as FiledResult;
  assert.equal(filed.action, "created");
  assert.equal(filed.repo, "hector-dcs/crew-rag-domo");
  assert.ok(issuesByRepo.get("hector-dcs/crew-rag-domo")?.length === 1);
});

test("runFailureAlertSweep: a single failure with a prior success on the SAME version is a one-off flake, does not file", async () => {
  const { factory } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "job-search", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z", version: "v1" }),
    run({ taskIdentifier: "job-search", status: "COMPLETED", createdAt: "2026-09-26T09:00:00Z", version: "v1" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => (projectKey === "executive-assistant" ? runs : []),
    makeClient: factory,
  });

  assert.equal(result.filed.length, 0);
});

test("runFailureAlertSweep: a task's very first run ever failing files immediately (never succeeded on its current version)", async () => {
  const { factory } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "grafana-docs-ingest", status: "COMPLETED_WITH_ERRORS", createdAt: "2026-09-26T10:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? runs : []),
    makeClient: factory,
  });

  assert.equal(result.filed.length, 1);
  assert.equal(result.filed[0]!.action, "created");
});

test("runFailureAlertSweep: an existing open issue for the same fingerprint gets a comment (once), then throttles further comments within 24h", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const errorPayload = { name: "HTTPError", message: "private package index never declared" };
  const makeRuns = (): RawRun[] => [
    run({
      taskIdentifier: "crew-rag-domo-scrape",
      status: "CRASHED",
      createdAt: "2026-09-26T10:00:00Z",
      error: errorPayload,
    }),
    run({
      taskIdentifier: "crew-rag-domo-scrape",
      status: "CRASHED",
      createdAt: "2026-09-26T09:00:00Z",
      error: errorPayload,
    }),
  ];

  const deps = {
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey: string) => (projectKey === "watchdog" ? makeRuns() : []),
    makeClient: factory,
  };

  // Sweep 1: no open issue yet -> creates one.
  const first = await runFailureAlertSweep(deps);
  assert.equal(first.filed[0]!.action, "created");

  // Sweep 2 (e.g. 30 min later): the issue is open with the same
  // fingerprint and has NO comment yet -> posts the first comment.
  const second = await runFailureAlertSweep(deps);
  assert.equal(second.filed[0]!.action, "commented", "first comment on the existing issue is not throttled");

  // Sweep 3: a comment now exists (posted "just now" per the fake client)
  // -> throttled, at most one comment per issue per 24h.
  const third = await runFailureAlertSweep(deps);
  assert.equal(third.filed[0]!.action, "throttled", "a second comment within 24h is throttled");

  assert.equal(issuesByRepo.get("hector-dcs/crew-rag-domo")?.length, 1, "no duplicate issue created");
});

test("runFailureAlertSweep: falls back to the default repo when the owning repo 403s/404s", async () => {
  const calls: string[] = [];
  const fallbackFactory = (_ghToken: string, repo: string): GitHubIssueClient => {
    calls.push(repo);
    if (repo === "hector-dcs/crew-rag-domo") {
      return {
        findByFingerprint: async () => {
          throw new GitHubAccessError("blocked", 404);
        },
        createIssue: async () => {
          throw new GitHubAccessError("blocked", 404);
        },
        commentOnIssue: async () => {
          throw new GitHubAccessError("blocked", 404);
        },
        getLastCommentAt: async () => null,
      };
    }
    return {
      async findByFingerprint() {
        return null;
      },
      async createIssue(_title, body) {
        assert.ok(body.includes("hector-dcs/crew-rag-domo"), "fallback body must name the intended repo");
        return { number: 999, html_url: "https://github.com/jaewilson07/trigger-dev-workflows/issues/999" };
      },
      async commentOnIssue() {},
      async getLastCommentAt() {
        return null;
      },
    };
  };

  const runs: RawRun[] = [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? runs : []),
    makeClient: fallbackFactory,
  });

  assert.equal(result.filed.length, 1);
  assert.equal(result.filed[0]!.repo, "jaewilson07/trigger-dev-workflows");
  assert.equal(result.filed[0]!.issueNumber, 999);
});

test("runFailureAlertSweep: one project's fetch failure doesn't stop the others", async () => {
  const { factory } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "daily-standup", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z" }),
    run({ taskIdentifier: "daily-standup", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => {
      if (projectKey === "watchdog") throw new Error("boom");
      if (projectKey === "executive-assistant") return runs;
      return [];
    },
    makeClient: factory,
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /watchdog: failed to fetch runs/);
  assert.equal(result.filed.length, 1);
  assert.equal(result.filed[0]!.taskId, "daily-standup");
});

test("runFailureAlertSweep: covers all three monitored projects by default", async () => {
  const seen: string[] = [];
  await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => {
      seen.push(projectKey);
      return [];
    },
    makeClient: makeFakeClientFactory().factory,
  });
  assert.deepEqual(
    seen.sort(),
    MONITORED_PROJECTS.map((p) => p.key).sort()
  );
});

test("runFailureAlertSweep: a GH token resolution failure is reported, not thrown", async () => {
  const result = await runFailureAlertSweep({
    resolveGhToken: async () => {
      throw new Error("Infisical unreachable");
    },
    fetchRuns: async () => [],
  });
  assert.equal(result.filed.length, 0);
  assert.match(result.errors[0]!, /Infisical unreachable/);
});
