/**
 * `(project, taskId)` -> the file that declares it, for `failureAlertReport.ts`'s
 * issue body ("the source file path of the task" — jaewilson07/trigger-dev-workflows#206).
 *
 * A STATIC, checked-in snapshot rather than a runtime filesystem scan: a
 * deployed Trigger.dev task runs from a bundled esbuild output, not a
 * browsable source tree, so "walk the directory and find task ids" (which
 * `failureRepoMap.test.ts` does, at TEST time only) is not available at
 * runtime. Generated once (2026-09-26) by scanning every `.ts` file under
 * each project for the same `id: "..."` convention that test uses; re-run
 * the same scan and diff when this drifts noticeably (a task file moves, or
 * enough new tasks land that the fallback below is hit often — check
 * `failureAlertReport.ts` logs for the "no indexed source path" warning).
 *
 * Deliberately NOT hard-covered by a test the way `failureRepoMap.ts` is:
 * this is a "nice to have" pointer for whoever triages the filed issue, not
 * a correctness-critical routing decision. A miss degrades to a clear
 * fallback string, not a wrong answer.
 */

function key(project: string, taskId: string): string {
  return `${project}:${taskId}`;
}

const TASK_SOURCE_PATHS: Record<string, string> = {
  // watchdog
  [key("watchdog", "crew-rag-domo-scrape")]: "watchdog/src/trigger/crewRagDomoScrape.ts",
  [key("watchdog", "domo-community-journal")]: "watchdog/src/trigger/domoCommunityJournal.ts",
  [key("watchdog", "domo-docs-report")]: "watchdog/src/trigger/domoDocsReport.ts",
  [key("watchdog", "infra-health-deliver")]: "watchdog/src/trigger/infra-health-deliver.ts",
  [key("watchdog", "infra-health-research")]: "watchdog/src/trigger/infra-health-research.ts",
  [key("watchdog", "infrastructure-health-report")]: "watchdog/src/trigger/infraHealthReport.ts",
  [key("watchdog", "ensure-reflection-schedule")]: "watchdog/src/trigger/reflectionScheduleEnsure.ts",
  [key("watchdog", "repo-monitor-report")]: "watchdog/src/trigger/repoMonitorReport.ts",
  [key("watchdog", "slack-community-journal")]: "watchdog/src/trigger/slackCommunityJournal.ts",
  [key("watchdog", "check-cli-drift")]: "watchdog/src/trigger/tasks/check-cli-drift.ts",
  [key("watchdog", "check-endpoint-health")]: "watchdog/src/trigger/tasks/check-endpoint-health.ts",
  [key("watchdog", "check-repo-config-drift")]: "watchdog/src/trigger/tasks/check-repo-config-drift.ts",
  [key("watchdog", "check-repo-releases")]: "watchdog/src/trigger/tasks/check-repo-releases.ts",
  [key("watchdog", "check-service-groups")]: "watchdog/src/trigger/tasks/check-service-groups.ts",
  [key("watchdog", "infra-deliver-gdoc")]: "watchdog/src/trigger/tasks/infra-deliver-gdoc.ts",
  [key("watchdog", "infra-deliver-notion")]: "watchdog/src/trigger/tasks/infra-deliver-notion.ts",
  [key("watchdog", "infra-deliver-slack")]: "watchdog/src/trigger/tasks/infra-deliver-slack.ts",
  [key("watchdog", "alertmanager-docs-ingest")]: "watchdog/src/trigger/vendor-docs/alertmanagerDocsIngest.ts",
  [key("watchdog", "alloy-docs-ingest")]: "watchdog/src/trigger/vendor-docs/alloyDocsIngest.ts",
  [key("watchdog", "claude-code-docs-ingest")]: "watchdog/src/trigger/vendor-docs/claudeCodeDocsIngest.ts",
  [key("watchdog", "comfyui-docs-ingest")]: "watchdog/src/trigger/vendor-docs/comfyuiDocsIngest.ts",
  [key("watchdog", "domo-docs-ingest")]: "watchdog/src/trigger/vendor-docs/domoDocsIngest.ts",
  [key("watchdog", "fastmcp-docs-ingest")]: "watchdog/src/trigger/vendor-docs/fastmcpDocsIngest.ts",
  [key("watchdog", "grafana-docs-ingest")]: "watchdog/src/trigger/vendor-docs/grafanaDocsIngest.ts",
  [key("watchdog", "langchain-oss-docs-ingest")]: "watchdog/src/trigger/vendor-docs/langchainOssDocsIngest.ts",
  [key("watchdog", "langfuse-docs-ingest")]: "watchdog/src/trigger/vendor-docs/langfuseDocsIngest.ts",
  [key("watchdog", "langsmith-docs-ingest")]: "watchdog/src/trigger/vendor-docs/langsmithDocsIngest.ts",
  [key("watchdog", "letta-docs-ingest")]: "watchdog/src/trigger/vendor-docs/lettaDocsIngest.ts",
  [key("watchdog", "loki-docs-ingest")]: "watchdog/src/trigger/vendor-docs/lokiDocsIngest.ts",
  [key("watchdog", "prometheus-docs-ingest")]: "watchdog/src/trigger/vendor-docs/prometheusDocsIngest.ts",
  [key("watchdog", "prometheus-server-docs-ingest")]:
    "watchdog/src/trigger/vendor-docs/prometheusServerDocsIngest.ts",
  [key("watchdog", "trigger-dev-docs-ingest")]: "watchdog/src/trigger/vendor-docs/triggerDevDocsIngest.ts",
  [key("watchdog", "trigger-dev-skills-ingest")]: "watchdog/src/trigger/vendor-docs/triggerDevSkillsIngest.ts",

  // executive-assistant
  [key("executive-assistant", "brief-deliver")]: "executive-assistant/brief-deliver.ts",
  [key("executive-assistant", "brief-research")]: "executive-assistant/brief-research.ts",
  [key("executive-assistant", "deep-researcher-deliver")]: "executive-assistant/deep-researcher-deliver.ts",
  [key("executive-assistant", "deep-researcher-demo")]: "executive-assistant/deep-researcher-demo.ts",
  [key("executive-assistant", "deep-researcher-full-run")]: "executive-assistant/deep-researcher-full-run.ts",
  [key("executive-assistant", "hello-observability")]: "executive-assistant/demo/hello-observability.ts",
  [key("executive-assistant", "enrich-greeting")]: "executive-assistant/demo/hello-observability.ts",
  [key("executive-assistant", "email-digest-deliver")]: "executive-assistant/email-digest-deliver.ts",
  [key("executive-assistant", "email-digest")]: "executive-assistant/email-digest.ts",
  [key("executive-assistant", "job-search")]: "executive-assistant/job-search.ts",
  [key("executive-assistant", "learn-resource-hunt")]: "executive-assistant/learn-resource-hunt.ts",
  [key("executive-assistant", "mermaid-pipeline")]: "executive-assistant/mermaid-pipeline.ts",
  [key("executive-assistant", "morning-brief")]: "executive-assistant/morning-brief.ts",
  [key("executive-assistant", "pattern-hunter-deliver")]: "executive-assistant/pattern-hunter-deliver.ts",
  [key("executive-assistant", "pattern-hunter-full-run")]: "executive-assistant/pattern-hunter-full-run.ts",
  [key("executive-assistant", "pattern-hunter-interview")]: "executive-assistant/pattern-hunter-interview.ts",
  [key("executive-assistant", "pattern-hunter-reflect")]: "executive-assistant/pattern-hunter-reflect.ts",
  [key("executive-assistant", "pattern-hunter-research")]: "executive-assistant/pattern-hunter-research.ts",
  [key("executive-assistant", "report-deliver")]: "executive-assistant/report-deliver.ts",
  [key("executive-assistant", "research-primitives-demo")]: "executive-assistant/research-primitives-demo.ts",
  [key("executive-assistant", "storm-deliver")]: "executive-assistant/storm-deliver.ts",
  [key("executive-assistant", "storm-research-full-run")]: "executive-assistant/storm-research-full-run.ts",
  [key("executive-assistant", "storm-research")]: "executive-assistant/storm-research.ts",
  [key("executive-assistant", "daily-standup")]: "executive-assistant/tasks/assistant/daily-standup.ts",
  [key("executive-assistant", "deliver-domo-canvas")]: "executive-assistant/tasks/assistant/deliver-domo-canvas.ts",
  [key("executive-assistant", "deliver-gdoc")]: "executive-assistant/tasks/assistant/deliver-gdoc.ts",
  [key("executive-assistant", "deliver-mdrag")]: "executive-assistant/tasks/assistant/deliver-mdrag.ts",
  [key("executive-assistant", "deliver-slack-ephemeral")]:
    "executive-assistant/tasks/assistant/deliver-slack-ephemeral.ts",
  [key("executive-assistant", "deliver-slack")]: "executive-assistant/tasks/assistant/deliver-slack.ts",
  [key("executive-assistant", "fetch-emails")]: "executive-assistant/tasks/assistant/fetch-emails.ts",
  [key("executive-assistant", "fetch-job-listings")]: "executive-assistant/tasks/assistant/fetch-job-listings.ts",
  [key("executive-assistant", "log-activity")]: "executive-assistant/tasks/assistant/log-activity.ts",
  [key("executive-assistant", "mermaid-classify-graph-type")]:
    "executive-assistant/tasks/assistant/mermaid-classify-graph-type.ts",
  [key("executive-assistant", "mermaid-distill-transcript")]:
    "executive-assistant/tasks/assistant/mermaid-distill-transcript.ts",
  [key("executive-assistant", "mermaid-generate-diagram")]:
    "executive-assistant/tasks/assistant/mermaid-generate-diagram.ts",
  [key("executive-assistant", "mermaid-validate-diagram")]:
    "executive-assistant/tasks/assistant/mermaid-validate-diagram.ts",
  [key("executive-assistant", "search-topics")]: "executive-assistant/tasks/assistant/search-topics.ts",
  [key("executive-assistant", "synthesize-brief")]: "executive-assistant/tasks/assistant/synthesize-brief.ts",
  [key("executive-assistant", "triage-emails")]: "executive-assistant/tasks/assistant/triage-emails.ts",
  [key("executive-assistant", "learn-hunt-resources")]: "executive-assistant/tasks/learn/hunt-resources.ts",
  [key("executive-assistant", "conduct-interview")]: "executive-assistant/tasks/research/conduct-interview.ts",
  [key("executive-assistant", "deep-research-level")]: "executive-assistant/tasks/research/deep-research-level.ts",
  [key("executive-assistant", "deep-research-query")]: "executive-assistant/tasks/research/deep-research-query.ts",
  [key("executive-assistant", "discover-perspectives")]:
    "executive-assistant/tasks/research/discover-perspectives.ts",
  [key("executive-assistant", "prepare-report")]: "executive-assistant/tasks/research/generate-briefing.ts",
  [key("executive-assistant", "map-contradictions")]: "executive-assistant/tasks/research/map-contradictions.ts",
  [key("executive-assistant", "mdrag-critique")]: "executive-assistant/tasks/research/mdrag-critique.ts",
  [key("executive-assistant", "mdrag-extract-results")]:
    "executive-assistant/tasks/research/mdrag-extract-results.ts",
  [key("executive-assistant", "mdrag-plan-research")]: "executive-assistant/tasks/research/mdrag-plan-research.ts",
  [key("executive-assistant", "mdrag-search-providers")]:
    "executive-assistant/tasks/research/mdrag-search-providers.ts",
  [key("executive-assistant", "mdrag-synthesize")]: "executive-assistant/tasks/research/mdrag-synthesize.ts",
  [key("executive-assistant", "output-google-doc")]: "executive-assistant/tasks/research/output-google-doc.ts",
  [key("executive-assistant", "output-mdrag-ingest-sources")]:
    "executive-assistant/tasks/research/output-mdrag-ingest-sources.ts",
  [key("executive-assistant", "output-mdrag-ingest")]: "executive-assistant/tasks/research/output-mdrag-ingest.ts",
  [key("executive-assistant", "output-notion")]: "executive-assistant/tasks/research/output-notion.ts",
  [key("executive-assistant", "output-slack-briefing")]:
    "executive-assistant/tasks/research/output-slack-briefing.ts",
  [key("executive-assistant", "output-slack-md")]: "executive-assistant/tasks/research/output-slack-md.ts",
  [key("executive-assistant", "pattern-hunter-brief")]: "executive-assistant/tasks/research/pattern-hunter-brief.ts",
  [key("executive-assistant", "pattern-hunter-context-snapshot")]:
    "executive-assistant/tasks/research/pattern-hunter-context-snapshot.ts",
  [key("executive-assistant", "pattern-hunter-hypotheses")]:
    "executive-assistant/tasks/research/pattern-hunter-hypotheses.ts",
  [key("executive-assistant", "pattern-hunter-pain-points")]:
    "executive-assistant/tasks/research/pattern-hunter-pain-points.ts",
  [key("executive-assistant", "pattern-hunter-publish-gdoc")]:
    "executive-assistant/tasks/research/pattern-hunter-publish-gdoc.ts",
  [key("executive-assistant", "pattern-hunter-red-team")]:
    "executive-assistant/tasks/research/pattern-hunter-red-team.ts",
  [key("executive-assistant", "report-slack")]: "executive-assistant/tasks/research/report-slack.ts",
  [key("executive-assistant", "synthesize-report")]: "executive-assistant/tasks/research/synthesize-report.ts",
  [key("executive-assistant", "verify-sources")]: "executive-assistant/tasks/research/verify-sources.ts",
  [key("executive-assistant", "deliver-notion")]: "executive-assistant/tasks/shared/deliver-notion.ts",
  [key("executive-assistant", "post-slack")]: "executive-assistant/tasks/shared/post-slack.ts",
  [key("executive-assistant", "report-gdoc")]: "executive-assistant/tasks/shared/report-gdoc.ts",
  [key("executive-assistant", "report-mdrag")]: "executive-assistant/tasks/shared/report-mdrag.ts",

  // indb-blues
  [key("indb-blues", "deliver-notion")]: "indb-blues/src/trigger/tasks/deliver-notion.ts",
  [key("indb-blues", "blues-drop-deliver")]: "indb-blues/src/trigger/bluesDropDeliver.ts",
  [key("indb-blues", "blues-drop-full-run")]: "indb-blues/src/trigger/bluesDropFullRun.ts",
  [key("indb-blues", "blues-drop-research")]: "indb-blues/src/trigger/bluesDropResearch.ts",
  [key("indb-blues", "indb-blues-hello")]: "indb-blues/src/trigger/indbBluesHello.ts",
  [key("indb-blues", "deliver-discord")]: "indb-blues/src/trigger/tasks/deliver-discord.ts",
  [key("indb-blues", "deliver-web")]: "indb-blues/src/trigger/tasks/deliver-web.ts",
};

/** Best-effort file path for `(project, taskId)`. `null` when not indexed. */
export function getTaskSourcePath(project: string, taskId: string): string | null {
  return TASK_SOURCE_PATHS[key(project, taskId)] ?? null;
}
