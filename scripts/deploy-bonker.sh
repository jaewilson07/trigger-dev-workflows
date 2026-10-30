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
# Builds from ~/deploy/trigger-dev-workflows, a worktree kept at origin/main,
# never from the shared ~/GitHub/trigger-dev-workflows checkout.
#
# External projects (scripts/external-projects.conf, e.g. rss-feed-factory) have
# their code in another repo and their config in a third. They build from
# deploy-only worktrees of both under ~/deploy, then run the exact same
# preflight / deploy / image-landed / registry-push path below. They are not
# part of `all`.
#
# Usage (on bonker, or from any host with `ssh bonker`; it forwards itself):
#   bash scripts/deploy-bonker.sh watchdog
#   bash scripts/deploy-bonker.sh watchdog executive-assistant
#   bash scripts/deploy-bonker.sh all
#   bash scripts/deploy-bonker.sh rss-feed-factory
#
# Secrets: TRIGGER_ACCESS_TOKEN is used if already exported. Otherwise the
# script fetches TRIGGER_PAT from Infisical (project 3fbb4296-…, path /trigger)
# with the machine-identity bootstrap in ~/GitHub/.env. The token is never
# printed. Do not add `set -x` to this file.

set -euo pipefail

ALL_PROJECTS="executive-assistant watchdog indb-blues"
# SRC_REPO is bonker's shared day-to-day checkout. Other sessions keep feature
# branches and uncommitted work there, so it is only ever FETCHED, never
# checked out, pulled or built. Deploys build from DEPLOY_DIR: a dedicated
# worktree detached at origin/main that nothing else touches. On 2026-09-26 a
# deploy failed because SRC_REPO sat on another session's branch; before
# that, any deploy would have shipped whatever branch happened to be there.
SRC_REPO="$HOME/GitHub/trigger-dev-workflows"
DEPLOY_DIR="$HOME/deploy/trigger-dev-workflows"
REPO_DIR="$DEPLOY_DIR"
EXTERNAL_CONF="$REPO_DIR/scripts/external-projects.conf"

# Off bonker: forward over ssh. Deploying from here would strand the image
# (reason 2 above), so there is no local fallback. The forwarded command runs
# origin/main's copy of this script via `git show`, not the file in SRC_REPO's
# working tree, which may be on any branch.
if [ "$(hostname -s)" != "bonker" ]; then
  echo "── Not on bonker; forwarding over ssh"
  exec ssh bonker "git -C ~/GitHub/trigger-dev-workflows fetch -q origin main && git -C ~/GitHub/trigger-dev-workflows show origin/main:scripts/deploy-bonker.sh | bash -s -- $*"
fi

# Sync DEPLOY_DIR to origin/main, then re-exec its copy of this script. bash
# reads a script as it runs, so rewriting the running file mid-run would
# execute a mix of old and new versions.
if [ -z "${DEPLOY_BONKER_PULLED:-}" ]; then
  echo "── Syncing $DEPLOY_DIR to origin/main"
  git -C "$SRC_REPO" fetch -q origin main
  if [ -e "$DEPLOY_DIR/.git" ]; then
    # -f: this worktree is deploy-only; anything changed in it is debris.
    git -C "$DEPLOY_DIR" checkout -q -f --detach origin/main
    git -C "$DEPLOY_DIR" clean -q -fd
  else
    mkdir -p "$(dirname "$DEPLOY_DIR")"
    git -C "$SRC_REPO" worktree add -q --detach "$DEPLOY_DIR" origin/main
  fi
  echo "  at $(git -C "$DEPLOY_DIR" log --oneline -1 | cut -c1-60)"

  # Install dependencies only when the lockfile changed since the last deploy.
  LOCK_HASH=$(sha256sum "$DEPLOY_DIR/package-lock.json" | cut -d' ' -f1)
  STAMP="$DEPLOY_DIR/node_modules/.deploy-lock-sha256"
  if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
    echo "── npm ci (package-lock.json changed)"
    # </dev/null: when forwarded from another host this script arrives on
    # stdin (`bash -s`), and a child that reads stdin would eat the rest of it.
    ( cd "$DEPLOY_DIR" && npm ci --no-audit --no-fund </dev/null )
    echo "$LOCK_HASH" > "$STAMP"
  fi

  DEPLOY_BONKER_PULLED=1 exec bash "$DEPLOY_DIR/scripts/deploy-bonker.sh" "$@"
fi

if [ "$#" -eq 0 ]; then set -- executive-assistant; fi
# shellcheck disable=SC2086  # intentional word-split of the project list
if [ "$1" = "all" ]; then set -- $ALL_PROJECTS; fi

# External project registry: print the whitespace-separated entry for $1, if any.
external_entry() {
  [ -f "$EXTERNAL_CONF" ] || return 0
  awk -v n="$1" '$1 !~ /^#/ && $1 == n { print; exit }' "$EXTERNAL_CONF"
}
external_names() {
  [ -f "$EXTERNAL_CONF" ] || return 0
  awk '$1 !~ /^#/ && NF { printf "%s ", $1 }' "$EXTERNAL_CONF"
}

# Validate every name before deploying any.
for P in "$@"; do
  case " $ALL_PROJECTS " in
    *" $P "*) continue ;;
  esac
  if [ -z "$(external_entry "$P")" ]; then
    echo "✖ Unknown project '$P'. One of: $ALL_PROJECTS $(external_names)all"; exit 1
  fi
done

# More than one project: deploy each in its own process, so each gets its own
# image verification and the first failure stops the rest.
if [ "$#" -gt 1 ]; then
  for P in "$@"; do bash "$REPO_DIR/scripts/deploy-bonker.sh" "$P"; echo; done
  exit 0
fi

PROJECT="$1"
PROJECT_DIR="$REPO_DIR/$PROJECT"
EXTERNAL=""

case "$PROJECT" in
  executive-assistant) REF="proj_noaaludkbpoorzosejyn" ;;
  watchdog)            REF="proj_wxqgcxxcutibtcgxlzky" ;;
  indb-blues)          REF="proj_vbdokvsqejsehxoztzmm" ;;
  # storm-research (proj_wirdhbubjmhwu4r) retired 2026-08-12 — folded into
  # executive-assistant. STORM tasks deploy as part of that project now.
  *)
    EXTERNAL=1
    read -r _ REF CODE_URL CODE_REF CFG_URL CFG_SUBDIR <<< "$(external_entry "$PROJECT")"
    ;;
esac

# An empty ref otherwise dies much later as `No route matches
# "/api/v1/projects//prod"`.
if [ -z "${REF:-}" ]; then
  echo "✖ No Trigger.dev project ref for '${PROJECT}'."
  exit 1
fi
if [ -n "$EXTERNAL" ] && { [ -z "${CODE_URL:-}" ] || [ -z "${CODE_REF:-}" ] \
     || [ -z "${CFG_URL:-}" ] || [ -z "${CFG_SUBDIR:-}" ]; }; then
  echo "✖ ${EXTERNAL_CONF}: '${PROJECT}' needs name ref code-url code-ref config-url config-subdir."
  exit 1
fi

export TRIGGER_API_URL="${TRIGGER_API_URL:-https://triggers.datacrew.space}"
export TRIGGER_PROJECT_REF="$REF"

echo "Deploying ${PROJECT} (${REF}) to ${TRIGGER_API_URL}"
echo

# Build a deploy-only worktree of $2 (url) at origin/$3 into $1, and print
# nothing. Source is bonker's existing ~/GitHub/<repo> checkout when there is
# one (its origin already has working credentials; it is only FETCHED, never
# checked out), else a bare clone kept under ~/deploy/.sources.
sync_external_worktree() {
  local dir="$1" url="$2" ref="$3" name src
  name=$(basename "$url" .git)
  if [ -e "$HOME/GitHub/$name/.git" ]; then
    src="$HOME/GitHub/$name"
  else
    src="$HOME/deploy/.sources/$name.git"
    if [ ! -d "$src" ]; then
      mkdir -p "$(dirname "$src")"
      git clone -q --bare "$url" "$src"
      git -C "$src" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
    fi
  fi
  git -C "$src" fetch -q origin "+refs/heads/${ref}:refs/remotes/origin/${ref}"
  if [ -e "$dir/.git" ]; then
    git -C "$dir" checkout -q -f --detach "origin/${ref}"
    git -C "$dir" clean -q -fd
  else
    mkdir -p "$(dirname "$dir")"
    git -C "$src" worktree add -q --detach "$dir" "origin/${ref}"
  fi
}

if [ -n "$EXTERNAL" ]; then
  PROJECT_DIR="$HOME/deploy/$PROJECT"
  CFG_DIR="$HOME/deploy/$(basename "$CFG_URL" .git)"
  echo "── Syncing external project worktrees"
  sync_external_worktree "$PROJECT_DIR" "$CODE_URL" "$CODE_REF"
  sync_external_worktree "$CFG_DIR" "$CFG_URL" main
  echo "  code   $(git -C "$PROJECT_DIR" log --oneline -1 | cut -c1-60)"
  echo "  config $(git -C "$CFG_DIR" log --oneline -1 | cut -c1-60)"

  if [ ! -f "$CFG_DIR/$CFG_SUBDIR/feeds.yaml" ]; then
    echo "✖ $CFG_DIR/$CFG_SUBDIR/feeds.yaml not found"
    exit 1
  fi
  cp "$CFG_DIR/$CFG_SUBDIR/feeds.yaml" "$PROJECT_DIR/feeds.yaml"

  EXT_LOCK_HASH=$(sha256sum "$PROJECT_DIR/package-lock.json" | cut -d' ' -f1)
  EXT_STAMP="$PROJECT_DIR/node_modules/.deploy-lock-sha256"
  if [ "$(cat "$EXT_STAMP" 2>/dev/null || true)" != "$EXT_LOCK_HASH" ]; then
    echo "── npm ci (package-lock.json changed)"
    ( cd "$PROJECT_DIR" && npm ci --no-audit --no-fund </dev/null )
    echo "$EXT_LOCK_HASH" > "$EXT_STAMP"
  fi

  # A bad registry must abort before any build; set -e stops the script here.
  echo "── Validating the Feed Registry"
  ( cd "$PROJECT_DIR" && npm run validate:registry </dev/null )
fi

if [ -z "${TRIGGER_ACCESS_TOKEN:-}" ]; then
  echo "── Fetching TRIGGER_PAT from Infisical"
  INFISICAL_DOMAIN="https://infisical.datacrew.space"
  set -a; . "$HOME/GitHub/.env"; set +a
  INFISICAL_TOKEN=$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" --client-secret="$INFISICAL_CLIENT_SECRET" \
    --domain="$INFISICAL_DOMAIN" --silent --plain)
  TRIGGER_ACCESS_TOKEN=$(infisical secrets get TRIGGER_PAT --token="$INFISICAL_TOKEN" \
    --domain="$INFISICAL_DOMAIN" --projectId=3fbb4296-d4e6-4c17-83ee-b852a57a5e50 \
    --env=prod --path=/trigger --plain)
  unset INFISICAL_TOKEN INFISICAL_CLIENT_SECRET
  if [ -z "$TRIGGER_ACCESS_TOKEN" ]; then
    echo "✖ Infisical returned an empty TRIGGER_PAT"
    exit 1
  fi
  export TRIGGER_ACCESS_TOKEN
fi

cd "$REPO_DIR"

# Refuses on any host but bonker. Belt-and-braces given this script is meant to
# be run *on* bonker — but it is a plain bash file and nothing stops someone
# running it elsewhere. Always this repo's preflight, even for external
# projects (their repos have none); never SKIP_DEPLOY_PREFLIGHT.
echo "── Preflight"
npm run preflight

echo "── Deploying"
# Pinned to the project's own @trigger.dev/sdk. A bare `trigger.dev` binary is
# not a devDependency (fails from a clean checkout), and @latest aborts the
# moment the CLI outpaces the SDK.
SDK_VERSION=$(node -p "require('${PROJECT_DIR}/package.json').dependencies['@trigger.dev/sdk'].replace(/^[\^~]/,'')")
echo "  CLI pinned to ${SDK_VERSION} (matching the project's SDK)"
# The build runs each project's syncEnvVars() extension, which reads secrets
# from Infisical and needs the machine identity in the environment. Load it
# for this subshell only. Without it, every deploy from 2026-09-25 (#197,
# which unset the secret above) synced nothing, and a newly allowlisted
# JAEWILSON07_GH_PAT never reached executive-assistant.
( set -a; . "$HOME/GitHub/.env"; set +a
  cd "$PROJECT_DIR" && npx --yes "trigger.dev@${SDK_VERSION}" deploy )

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

# ── Registry backstop ────────────────────────────────────────────────────────
# The supervisor pulls from the local registry (localhost:5000), not the
# daemon's local image store. `trigger deploy` imports into the daemon only —
# it does NOT push to the registry (verified 2026-09-20: registry catalog was
# empty after the 20260920.1 exec-assistant deploy). A local-only image is one
# `docker image prune -af` away from the Sep 14 incident that took
# morning-brief/job-search down for 6 days. Push so the registry always holds
# a pullable copy of the current version.
SHORTCODE=$(docker exec trigger-postgres-1 psql -U postgres -d main -tAc \
  "select wd.\"shortCode\" from \"WorkerDeployment\" wd
     join \"Project\" p on p.id = wd.\"projectId\"
    where p.\"externalRef\" = '${REF}'
    order by wd.\"createdAt\" desc limit 1;" 2>/dev/null | tr -d '[:space:]' || true)

if [ -z "$SHORTCODE" ]; then
  echo "  ⚠ Could not read deployment shortCode — skipping registry push."
  echo "    Push manually: docker push localhost:5000/trigger/${REF}:${VERSION}.production.<shortcode>"
else
  TAG="${VERSION}.production.${SHORTCODE}"
  echo "── Pushing localhost:5000/trigger/${REF}:${TAG} to the registry"
  if [ -n "${DOCKER_REGISTRY_PASSWORD:-}" ]; then
    docker login localhost:5000 -u "${DOCKER_REGISTRY_USERNAME:-registry-user}" \
      --password-stdin <<< "$DOCKER_REGISTRY_PASSWORD" >/dev/null 2>&1 || true
  fi
  if docker push "localhost:5000/trigger/${REF}:${TAG}" >/dev/null 2>&1; then
    echo "  ✔ registry now holds ${TAG}"
  else
    echo "  ⚠ Registry push failed. The image exists locally, so runs will work"
    echo "    until the daemon loses it — but re-push or the prune guard is the"
    echo "    only thing standing between this deploy and the Sep 14 failure mode."
    echo "    Source credentials: apps/trigger-dev/.env (DOCKER_REGISTRY_*)"
  fi
fi

echo
echo "✔ ${PROJECT} deployed. Watch a run reach attemptCount 1 before trusting it:"
echo "    https://triggers.datacrew.space/projects/v3/${REF}"
