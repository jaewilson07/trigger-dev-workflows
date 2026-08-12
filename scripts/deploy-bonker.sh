#!/usr/bin/env bash
# Deploy Trigger.dev tasks to the self-hosted instance on bonker.
#
# Manually triggered, matching the house pattern (cf. mdrag's
# scripts/deploy-bonker.sh). Run it after a PR to jaewilson07/trigger-dev-workflows
# lands on main.
#
# WHY NOT CI. Two independent reasons, either sufficient:
#
#   1. bonker is LAN-only with no public IP a GitHub-hosted runner can reach —
#      the same reason mdrag's deploy is a script rather than a workflow, and
#      there is no self-hosted runner on bonker or cubby.
#
#   2. The Trigger.dev CLI builds the image and imports it into whichever
#      docker daemon it is talking to, pushing to DEPLOY_REGISTRY_HOST — which
#      is `localhost:5000`, bound to bonker's loopback. An image built anywhere
#      else is stranded: the deploy still reports success, the webapp records
#      the new version as current, and every subsequent run sits QUEUED at
#      attemptCount 0 forever without ever FAILING, so no failure alert fires.
#
#      That is not hypothetical — a deploy from cubby on 2026-08-06 took the
#      daily brief down for ~24h before anyone noticed. See ADR-046.
#
# Usage (from anywhere with SSH access):
#   ssh bonker 'bash ~/GitHub/trigger-dev-workflows/scripts/deploy-bonker.sh executive-assistant'
#
# Or, already on bonker:
#   bash ~/GitHub/trigger-dev-workflows/scripts/deploy-bonker.sh watchdog
#
# Secrets: Infisical project 3fbb4296-…, path /trigger (TRIGGER_PAT).
# Export TRIGGER_ACCESS_TOKEN before running, or the CLI will prompt.

set -euo pipefail

PROJECT="${1:-executive-assistant}"
REPO_DIR="$HOME/GitHub/trigger-dev-workflows"

case "$PROJECT" in
  executive-assistant) REF="proj_noaaludkbpoorzosejyn" ;;
  watchdog)            REF="proj_wxqgcxxcutibtcgxlzky" ;;
  # storm-research (proj_wirdhbubjmhwu4r) retired 2026-08-12 — folded into
  # executive-assistant. STORM tasks deploy as part of that project now.
  *) echo "✖ Unknown project '$PROJECT'. One of: executive-assistant, watchdog"; exit 1 ;;
esac

export TRIGGER_API_URL="${TRIGGER_API_URL:-https://triggers.datacrew.space}"
export TRIGGER_PROJECT_REF="$REF"

echo "Deploying ${PROJECT} (${REF}) to ${TRIGGER_API_URL}"
echo

if [ -z "${TRIGGER_ACCESS_TOKEN:-}" ]; then
  echo "✖ TRIGGER_ACCESS_TOKEN is not set. Fetch TRIGGER_PAT from Infisical /trigger:"
  echo "    export TRIGGER_ACCESS_TOKEN=\$(…)"
  exit 1
fi

cd "$REPO_DIR"
echo "── Updating repo"
git pull --ff-only origin main
echo "  at $(git log --oneline -1 | cut -c1-60)"

# Refuses on any host but bonker. Belt-and-braces given this script is meant to
# be run *on* bonker — but it is a plain bash file and nothing stops someone
# running it elsewhere.
echo "── Preflight"
npm run preflight

echo "── Deploying"
# Pinned to the project's own @trigger.dev/sdk. A bare `trigger.dev` binary is
# not a devDependency (fails from a clean checkout), and @latest aborts the
# moment the CLI outpaces the SDK.
SDK_VERSION=$(node -p "require('./${PROJECT}/package.json').dependencies['@trigger.dev/sdk'].replace(/^[\^~]/,'')")
echo "  CLI pinned to ${SDK_VERSION} (matching the project's SDK)"
( cd "$PROJECT" && npx --yes "trigger.dev@${SDK_VERSION}" deploy )

# ── The step that would have caught the 2026-08-06 outage ────────────────────
# `trigger deploy` confirms it built and registered. It never confirms the
# worker can obtain the image. Check the artifact actually exists here.
echo "── Verifying the image reached this host's daemon"

# Assert the image for the version the WEBAPP will hand the supervisor — not
# merely that some image for this project exists.
#
# The previous check was `docker images | grep -q "trigger/${REF}"` plus an
# informational "newest tag". Any stale image from an earlier deploy satisfied
# that, so a deploy whose image was stranded still passed. That is exactly what
# happened on 2026-08-07/08: watchdog versions 20260807.1, 20260808.1 and
# 20260808.2 were marked current with no image on this daemon, and three
# scheduled runs died with SYSTEM_FAILURE / TASK_RUN_DEQUEUED_MAX_RETRIES.
#
# The version comes from WorkerDeployment rather than by parsing CLI output:
# that row is what the engine actually resolves when it locks a run to a
# version, so it is the invariant worth asserting. ADR-046 §4.
VERSION=$(docker exec trigger-postgres-1 psql -U postgres -d main -tAc \
  "select wd.version from \"WorkerDeployment\" wd
     join \"Project\" p on p.id = wd.\"projectId\"
    where p.\"externalRef\" = '${REF}'
    order by wd.\"createdAt\" desc limit 1;" 2>/dev/null | tr -d '[:space:]' || true)

if [ -z "$VERSION" ]; then
  echo "  ✖ Could not read the current version from the database."
  echo "    Verify by hand before trusting this deploy:"
  echo "      docker images --format '{{.Tag}}' localhost:5000/trigger/${REF}"
  exit 1
fi

if docker images --format '{{.Tag}}' "localhost:5000/trigger/${REF}" \
     | grep -q "^${VERSION}\."; then
  echo "  ✔ image for ${VERSION} present on this host"
else
  echo "  ✖ Deploy reported success but NO image for ${VERSION} exists on this host."
  echo "    The webapp will hand this version to the supervisor and it cannot pull it."
  echo "    Every run locked to it dies at attemptNumber=null — either queued"
  echo "    forever, or SYSTEM_FAILURE/TASK_RUN_DEQUEUED_MAX_RETRIES after ~1h."
  echo "    Cause is almost always a deploy that ran somewhere other than bonker."
  exit 1
fi

echo
echo "✔ ${PROJECT} deployed. Watch a run reach attemptCount 1 before trusting it:"
echo "    https://triggers.datacrew.space/projects/v3/${REF}"
