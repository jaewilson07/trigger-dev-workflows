# datacrew.space site monitoring (Workers quota)

Two watchdog tasks, born from jaewilson07/datacrew-site#241 (2026-09-29: free Workers quota
exhausted, `fail_open` served a static Next.js 404 site-wide).

| Task | Schedule | What it does |
|---|---|---|
| `site-synthetic-check` | every 5 min | Asserts app-only signals: `/` is 200 with `Strict-Transport-Security`; `/api/sso/nope` is 404 with it; `/packages/dc-auth/` (redirects followed) lists `dc-auth-0.1.0`. Slack alert on the 2nd consecutive failing run, a reminder every 12th, one recovery message. |
| `workers-quota-alert` | hourly (:07) | Cloudflare GraphQL: today's `workersInvocationsAdaptive` requests for the account; alerts at 60k and 80k (once each per UTC day). Also any client IP over 5k requests in the last hour on the zone (`httpRequestsAdaptiveGroups`), with IP and user agent. |

Both alert to Slack (`DATACREW_SLACK_BOT_TOKEN`, channel `SITE_MONITOR_SLACK_CHANNEL_ID`, default #datacrew-ai).
State (failure count, alert flags) is carried in each task's previous COMPLETED run output.

## Secret to create

`CF_ANALYTICS_TOKEN` in Infisical (project 3fbb4296, `/datacrew`, prod). A Cloudflare API token with exactly:

- Account > Account Analytics > Read
- Zone > Analytics > Read, restricted to zone `datacrew.space`

The task also reads `CF_ACCOUNT_ID` and `CF_ZONE_ID` from Infisical `/infrastructure` (already present).
The existing CF token lacks Analytics:Read (error 10000) and is deliberately not reused. If
`CF_ANALYTICS_TOKEN` is missing the run fails with an error naming these scopes.

Assumption to verify on first run: Pages Functions invocations are counted in `workersInvocationsAdaptive`.
