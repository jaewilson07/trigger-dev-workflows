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

type FakeIssue = {
  number: number;
  title: string;
  body: string;
  comments: string[];
  state: "open" | "closed";
};

/** A fake GitHubIssueClient with in-memory state, keyed by the repo it was built for. */
function makeFakeClientFactory() {
  const issuesByRepo = new Map<string, FakeIssue[]>();
  const calls: Array<{ repo: string; op: string }> = [];
  let nextNumber = 1;

  const factory = (_ghToken: string, repo: string): GitHubIssueClient => ({
    async findByFingerprint(fingerprint) {
      calls.push({ repo, op: "findByFingerprint" });
      const issues = issuesByRepo.get(repo) ?? [];
      const match = issues.find((i) => i.state === "open" && i.body.includes(`trigger-failure:${fingerprint}`));
      return match ? { number: match.number, html_url: `https://github.com/${repo}/issues/${match.number}` } : null;
    },
    async createIssue(title, body, _labels) {
      calls.push({ repo, op: "createIssue" });
      const arr = issuesByRepo.get(repo) ?? [];
      const number = nextNumber++;
      arr.push({ number, title, body, comments: [], state: "open" });
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
    async findOpenByTask(taskId) {
      calls.push({ repo, op: "findOpenByTask" });
      const issues = issuesByRepo.get(repo) ?? [];
      const byMarker = issues.filter((i) => i.state === "open" && i.body.includes(`trigger-failure-task:${taskId}`));
      if (byMarker.length > 0) {
        return byMarker.map((i) => ({ number: i.number, html_url: `https://github.com/${repo}/issues/${i.number}` }));
      }
      // Legacy fallback: filed before the task marker existed -- match the
      // (older) trigger-failure marker plus the title's task-id prefix.
      const legacy = issues.filter(
        (i) => i.state === "open" && i.body.includes("trigger-failure:") && i.title.startsWith(`${taskId}: `)
      );
      return legacy.map((i) => ({ number: i.number, html_url: `https://github.com/${repo}/issues/${i.number}` }));
    },
    async closeIssue(issueNumber) {
      calls.push({ repo, op: "closeIssue" });
      const arr = issuesByRepo.get(repo) ?? [];
      const issue = arr.find((i) => i.number === issueNumber);
      if (issue) issue.state = "closed";
    },
  });

  return { factory, issuesByRepo, calls };
}

/** Seed a pre-migration issue (no task marker, only the fingerprint marker +
 * the old title convention) directly into the fake store, bypassing
 * `createIssue` -- this is what #219-#228 (filed before this change) look
 * like today. */
function seedLegacyIssue(
  issuesByRepo: Map<string, FakeIssue[]>,
  repo: string,
  issue: { number: number; taskId: string; project: string; fingerprint: string }
): void {
  const arr = issuesByRepo.get(repo) ?? [];
  arr.push({
    number: issue.number,
    title: `${issue.taskId}: 1 consecutive failures (${issue.project})`,
    body: `some body\n\n<!-- trigger-failure:${issue.fingerprint} -->`,
    comments: [],
    state: "open",
  });
  issuesByRepo.set(repo, arr);
}

test("runFailureAlertSweep: creates one issue per task with >=2 consecutive failures", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
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
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey) => (projectKey === "executive-assistant" ? runs : []),
    makeClient: factory,
  });

  assert.equal(result.filed.length, 0);
});

test("runFailureAlertSweep: a task's very first run ever failing does NOT file on its own (one failure is never enough)", async () => {
  const { factory } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "grafana-docs-ingest", status: "COMPLETED_WITH_ERRORS", createdAt: "2026-09-26T10:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? runs : []),
    makeClient: factory,
  });

  assert.equal(result.filed.length, 0);
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
    fetchRunDetail: async () => ({}),
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
        findOpenByTask: async () => {
          throw new GitHubAccessError("blocked", 404);
        },
        closeIssue: async () => {
          throw new GitHubAccessError("blocked", 404);
        },
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
      async findOpenByTask() {
        return [];
      },
      async closeIssue() {},
    };
  };

  const runs: RawRun[] = [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
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
    fetchRunDetail: async () => ({}),
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
    fetchRunDetail: async () => ({}),
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
    fetchRunDetail: async () => ({}),
  });
  assert.equal(result.filed.length, 0);
  assert.match(result.errors[0]!, /Infisical unreachable/);
});

// ---------------------------------------------------------------------------
// Recovery: close-on-success (jaewilson07/trigger-dev-workflows#206 follow-up)
// ---------------------------------------------------------------------------

test("runFailureAlertSweep: when the newest run succeeds, any open issue the task filed gets a recovery comment and is closed", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const failingRuns = (): RawRun[] => [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T08:00:00Z" }),
  ];

  // Sweep 1: files the issue.
  const first = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? failingRuns() : []),
    makeClient: factory,
  });
  assert.equal(first.filed[0]!.action, "created");
  const issueNumber = first.filed[0]!.issueNumber;

  // Sweep 2: the task's newest run now succeeds -> recover.
  const recoveryRuns: RawRun[] = [
    run({
      taskIdentifier: "crew-rag-domo-scrape",
      status: "COMPLETED",
      createdAt: "2026-09-26T10:00:00Z",
      friendlyId: "run_recovered",
    }),
    ...failingRuns(),
  ];
  const second = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? recoveryRuns : []),
    makeClient: factory,
  });

  assert.equal(second.filed.length, 1);
  assert.equal(second.filed[0]!.action, "recovered");
  assert.equal(second.filed[0]!.issueNumber, issueNumber);

  const issue = issuesByRepo.get("hector-dcs/crew-rag-domo")!.find((i) => i.number === issueNumber)!;
  assert.equal(issue.state, "closed");
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0]!, /recovered: run run_recovered succeeded at 2026-09-26T10:00:00Z/);
});

test("runFailureAlertSweep: recovery is idempotent -- sweeping again after the issue is closed does not re-comment", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const failingRuns = (): RawRun[] => [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T08:00:00Z" }),
  ];
  const deps1 = {
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey: string) => (projectKey === "watchdog" ? failingRuns() : []),
    makeClient: factory,
  };
  const first = await runFailureAlertSweep(deps1);
  const issueNumber = first.filed[0]!.issueNumber;

  const recoveryRuns: RawRun[] = [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "COMPLETED", createdAt: "2026-09-26T10:00:00Z" }),
    ...failingRuns(),
  ];
  const deps2 = {
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey: string) => (projectKey === "watchdog" ? recoveryRuns : []),
    makeClient: factory,
  };

  const second = await runFailureAlertSweep(deps2);
  assert.equal(second.filed[0]!.action, "recovered");

  const third = await runFailureAlertSweep(deps2);
  assert.equal(third.filed.length, 0, "the issue is already closed -- findOpenByTask no longer sees it");

  const issue = issuesByRepo.get("hector-dcs/crew-rag-domo")!.find((i) => i.number === issueNumber)!;
  assert.equal(issue.comments.length, 1, "still only one recovery comment ever posted");
});

test("runFailureAlertSweep: recovery falls back to legacy matching (title prefix + trigger-failure marker) for an issue filed before the task marker existed", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  seedLegacyIssue(issuesByRepo, "jaewilson07/trigger-dev-workflows", {
    number: 226,
    taskId: "infra-deliver-gdoc",
    project: "watchdog",
    fingerprint: "516988b8dcfb09b1",
  });

  const recoveryRuns: RawRun[] = [
    run({
      taskIdentifier: "infra-deliver-gdoc",
      status: "COMPLETED",
      createdAt: "2026-09-27T09:00:00Z",
      friendlyId: "run_fixed",
    }),
    run({ taskIdentifier: "infra-deliver-gdoc", status: "CRASHED", createdAt: "2026-09-26T14:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? recoveryRuns : []),
    makeClient: factory,
  });

  assert.equal(result.filed.length, 1);
  assert.equal(result.filed[0]!.action, "recovered");
  assert.equal(result.filed[0]!.issueNumber, 226);
  const issue = issuesByRepo.get("jaewilson07/trigger-dev-workflows")!.find((i) => i.number === 226)!;
  assert.equal(issue.state, "closed");
});

test("runFailureAlertSweep: recovery never touches an open issue that has no trigger-failure marker at all", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  // An unrelated issue that happens to share a title prefix, but was never
  // filed by this watchdog (no trigger-failure marker anywhere in the body).
  issuesByRepo.set("jaewilson07/trigger-dev-workflows", [
    { number: 42, title: "infra-deliver-gdoc: rewrite the delivery pipeline", body: "unrelated human-filed issue", comments: [], state: "open" },
  ]);

  const recoveryRuns: RawRun[] = [
    run({ taskIdentifier: "infra-deliver-gdoc", status: "COMPLETED", createdAt: "2026-09-27T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRunDetail: async () => ({}),
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? recoveryRuns : []),
    makeClient: factory,
  });

  assert.equal(result.filed.length, 0);
  const issue = issuesByRepo.get("jaewilson07/trigger-dev-workflows")!.find((i) => i.number === 42)!;
  assert.equal(issue.state, "open", "untouched");
  assert.equal(issue.comments.length, 0);
});

// ---------------------------------------------------------------------------
// Real error detail (jaewilson07/trigger-dev-workflows#206 follow-up)
// ---------------------------------------------------------------------------

test("runFailureAlertSweep: a newly created issue uses the REAL error fetched from run detail, not the list endpoint's fallback", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({
      taskIdentifier: "crew-rag-domo-scrape",
      status: "CRASHED",
      createdAt: "2026-09-26T10:00:00Z",
      friendlyId: "run_newest",
    }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? runs : []),
    fetchRunDetail: async (_projectKey, runId) => {
      assert.equal(runId, "run_newest", "fetches detail for the newest failing run in the streak");
      return { error: { name: "HTTPError", message: "private package index never declared" } };
    },
    makeClient: factory,
  });

  assert.equal(result.filed.length, 1);
  const issue = issuesByRepo.get("hector-dcs/crew-rag-domo")![0]!;
  assert.ok(issue.body.includes("private package index never declared"));
  assert.ok(!issue.body.includes("run ended with status"));
});

test("runFailureAlertSweep: when fetching run detail fails, the issue keeps the fallback text but says retrieval failed", async () => {
  const { factory, issuesByRepo } = makeFakeClientFactory();
  const runs: RawRun[] = [
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T10:00:00Z" }),
    run({ taskIdentifier: "crew-rag-domo-scrape", status: "CRASHED", createdAt: "2026-09-26T09:00:00Z" }),
  ];

  const result = await runFailureAlertSweep({
    resolveGhToken: async () => "fake-token",
    fetchRuns: async (projectKey) => (projectKey === "watchdog" ? runs : []),
    fetchRunDetail: async () => {
      throw new Error("GET /api/v3/runs/run_newest failed with 500");
    },
    makeClient: factory,
  });

  assert.equal(result.filed.length, 1);
  const issue = issuesByRepo.get("hector-dcs/crew-rag-domo")![0]!;
  assert.ok(issue.body.includes("run ended with status"));
  assert.ok(issue.body.includes("error detail unavailable: GET /api/v3/runs/run_newest failed with 500"));
});
