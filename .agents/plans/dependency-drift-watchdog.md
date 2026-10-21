# PRD: Dependency drift watchdog — float by default, pin only for bespoke patches, DM on change

> **Tracking issue:** https://github.com/jaewilson07/trigger-dev-workflows/issues/103

## Problem Statement

I have no way to know when a dependency I rely on has moved, and no consistent policy about which
ones should be held back. Right now the answer to "are we out of date?" requires someone to SSH into
two hosts, exec into containers, read `requirements.txt`, Dockerfiles, and compose `image:` lines,
and hand-compare each against PyPI and GitHub. That was done once, manually, on 2026-08-19. It will
not happen again on its own.

What that manual pass found is the shape of the problem:

**Pinned things rot.** `pyannote.audio==3.3.2` is a major version behind (4.0.7). `huggingface_hub`
is stuck at 0.25.2 against a current 1.28.0 — two majors — for one reason nobody re-examines.
`whisperlivekit` is pinned to 0.2.20.post1 from March against 0.2.25.

**Unpinned things drift silently.** `crawl4ai` is declared as bare `"crawl4ai"` with no constraint at
all, as is `docling`. They happen to be exactly current — *by accident*, because every image rebuild
grabs whatever is newest. Nothing would tell us if a rebuild moved them.

**Ceiling pins become permanent by default.** `pydantic-ai>=0.4,<0.5` is two major versions behind
(2.32.0). `livekit-agents>=1.5,<1.6` is now blocking us from upstream's Turn Detector v1.0, which
overlaps custom end-of-utterance code we maintain by hand. Both holds were presumably deliberate.
Nothing ever re-asks whether they are still justified, so "temporary" becomes forever.

**Floating image tags are invisible.** `livekit-server:latest`, `letta/letta:latest`,
`twingate/*:latest`, `mdrag-api:latest`, and `open-webui:main` all float. For these, "is there a new
version" is meaningless — the tag always resolves to latest. The real risk is that the image changes
underneath us with no changelog and no gate.

And the cost is not hypothetical. On 2026-08-19, Open WebUI's voice was broken in both directions —
dead base URL for TTS *and* STT, plus a TTS model pinned to a backend that had been retired by
ADR-030 and was returning 503. Every health check was green throughout. Nobody noticed because
nothing was watching the relationship between what we declare and what actually exists.

## Solution

**Policy first: float by default. Pin only where we carry a bespoke patch or reach into an upstream
internal API — and when we do, write down why and what would let us stop.**

A pin is a liability with a carrying cost, not a safety measure. Most of our stack has no reason to
be held back. The exceptions are specific and enumerable — an audit on 2026-08-19 found exactly five
across all of infra, and three of them are self-liftable:

| pinned | reason it must be pinned | lift condition |
|---|---|---|
| CosyVoice image + `transformers` | `patches/server.py` is mounted **over** upstream's FastAPI server; vLLM forces `transformers==4.57.1`, which breaks CosyVoice3 generation | permanent while the patch exists |
| `whisperlivekit==0.2.20.post1` | we import `AudioProcessor`, iterate its results generator, and read `line.validated` — undocumented internals | **fix the coupling** (read `lines` as final and `buffer_transcription` as partial), then float |
| `pyannote.audio==3.3.2` + `huggingface_hub==0.25.2` | `diarizer.py::_patch_hf_auth_kwarg` monkeypatches `hf_hub_download` because pyannote 3.3.2 passes the removed `use_auth_token` | **upgrade to pyannote 4.x**, delete the shim, unpin hf_hub |
| `livekit-agents>=1.5,<1.6` | `cboti/livekit/vision.py` uses `RoomEvent`, removed in 1.6 | **migrate vision.py**, then float and evaluate upstream's Turn Detector v1.0 |
| fish-speech-s2 image | `patches/model_manager.py` mounted over upstream | rollback-only backend; retire instead of maintaining |

Everything else — comfyui, livekit-server, open-webui, twingate, postgres, redis/valkey, neo4j, and
the entire mdrag dependency set — floats and gets **watched** rather than held.

**Then the watchdog.** Extend the existing `infrastructure-health-report` research → deliver seam in
the `watchdog` project rather than building a parallel pipeline. Roughly 80% of the machinery already
exists:

- `latestFromSource` already resolves `github:`, `npm:`, and `pypi:`
- `check-cli-drift` already does compare → `CheckResult` → report
- `infra-deliver-slack` already posts with env→Infisical token resolution
- `repoMonitorReport` already caches last-seen state in Trigger.dev task metadata and posts **only on
  change**
- the `delivered | skipped | failed` vocabulary is already shared across three projects

What is new is a **dependency manifest** — the declared inventory of what we depend on, where it is
pinned, which regime it is in, and, critically, **how to upgrade it**. The upgrade recipe lives in
the manifest next to the version, not in a separate document, so the two cannot drift apart. The DM
deep-links each row to its own recipe anchor, so an agent lands on "to update livekit, do this"
rather than being handed a page to scan.

## User Stories

### The DM

1. As Jae, I want a Slack DM when a dependency I rely on has moved, so that I learn about it without going looking.
2. As Jae, I want the DM only when something actually changed, so that a daily digest does not train me to ignore it.
3. As Jae, I want each row to say what moved, from what, to what, so that I can judge urgency at a glance.
4. As Jae, I want each row to link to that component's upgrade recipe, so that I can hand the work to an agent with one link.
5. As Jae, I want to reply to direct an agent to upgrade, so that the notification is the start of the work rather than a separate chore.
6. As Jae, I want the DM to distinguish "new version available" from "something moved underneath us", so that I can tell an opportunity from an incident.
7. As Jae, I want silence to be meaningful, so that no message genuinely means nothing changed.

### Pin governance

8. As an operator, I want every pin to carry a written reason, so that no version is held back for a forgotten cause.
9. As an operator, I want every pin to carry a lift condition, so that a temporary hold has a defined exit.
10. As an operator, I want ceiling pins to report how long they have been held, so that a four-month-old "temporary" hold is visible as such.
11. As an operator, I want a pin with no bespoke patch or internal coupling to be flagged as unjustified, so that the default really is float.
12. As an agent, I want to know whether a component is patched before I upgrade it, so that I do not silently discard a patch mounted over upstream.

### Coverage across regimes

13. As an operator, I want hard-pinned dependencies compared declared-vs-upstream, so that I see rot.
14. As an operator, I want floor-pinned dependencies compared **installed-vs-upstream**, because the declared constraint says nothing about what is actually running.
15. As an operator, I want floating image tags compared **running-digest-vs-upstream-digest**, because a tag comparison is meaningless for them.
16. As an operator, I want mdrag's dependencies covered alongside infra's, so that there is one place to look.
17. As an operator, I want paired components (e.g. a database server and its driver) tracked as a pair, so that a compatible pairing is not broken by an unrelated rebuild.

### Operability

18. As an operator, I want an unreachable registry to cost one `unknown` row rather than failing the run, matching how `check-cli-drift` already behaves.
19. As an operator, I want the first run to seed state silently rather than reporting everything as newly changed.
20. As an operator, I want last-seen state to live in task metadata rather than hardcoded in git, so that the seed does not rot in source.
21. As an operator, I want a missing Slack token to produce `skipped` with a reason, not a failure, per the existing delivery vocabulary.

## Implementation Decisions

### The manifest is the deliverable

A single declared inventory, one row per tracked component:

- **identity** and **version source** (`pypi:`, `npm:`, `github:`, and a new `docker:` kind)
- **where it is pinned** — which file, so a human or agent can find it
- **regime** — `patched` (pin required), `floating` (watch only), or `held` (ceiling pin)
- **reason** and **lift condition** — required whenever regime is not `floating`
- **heldSince** — a date, so the DM can report the age of a hold
- **recipe anchor** — the per-component upgrade instructions
- **pairs with** — optional, for server/driver couplings

A row whose regime is `patched` or `held` but which carries no reason is itself a finding.

### New code, kept small

- A `docker:` source kind in `latestFromSource`, resolving image tags and digests.
- A `check-dependency-drift` task, mirroring `check-cli-drift`'s structure and error posture, that
  reads the manifest and dispatches per regime — declared-vs-upstream, installed-vs-upstream, or
  digest-vs-digest.
- Reading "installed" for floor-pinned Python deps requires asking the running container, not the
  repo. This reuses the existing host-command seam.
- A DM mode for the Slack delivery adapter. Slack's `chat.postMessage` accepts a user ID as
  `channel`, so this is a payload change plus an `im:write` scope check, not a new adapter.

### Composition

Folded into the existing `infra-health-research` → `infra-health-deliver` flow rather than given its
own schedule. Only the DM is change-triggered; the full inventory still appears in the existing
report for the record. This deliberately avoids adding a second daily notification.

### Explicitly rejected

A separate scheduled job posting a daily dependency digest. A message that arrives whether or not
anything happened is a message that gets filtered.

## Testing Decisions

Good tests here assert **external behaviour against fake registry responses** — no live network. Prior
art is the watchdog's existing task tests and the `delivered | skipped | failed` outcome vocabulary.

- **Regime dispatch** is the priority suite: a `floating` row compares installed rather than declared;
  a `patched` row compares declared; an image row compares digests. Feeding a floor-pinned row a
  declared constraint that matches everything must not report "current".
- **Change detection**: first run seeds silently; an unchanged second run produces no DM; a moved
  version produces exactly one row.
- **Failure posture**: an unreachable registry yields one `unknown` row and the rest of the run
  completes — mirroring `check-cli-drift`'s existing catch-per-target behaviour.
- **Delivery**: missing token yields `skipped` with a reason, not a throw.
- **Manifest validation**: a `patched` or `held` row without a reason and lift condition fails.
- Not tested: the accuracy of upstream registries themselves.

## Out of Scope

- Performing upgrades. This reports and links to a recipe; a human or a directed agent does the work.
- Automated PR-raising for version bumps. Possible later; it needs the recipes to exist and be trusted first.
- Vulnerability/CVE scanning. A different question with different tooling.
- The five pin-lift migrations themselves (pyannote 4.x, whisperlivekit coupling, `RoomEvent`,
  fish-speech retirement). Each is its own change; this PRD only records the reason and lift condition.
- Non-infra, non-mdrag repos.

## Further Notes

**Deploy constraint.** Trigger.dev tasks deploy from bonker only, and the live stack sits behind
Cloudflare with two known traps (`/engine/*` must be bypassed, and CF strips `Content-Length` on
body-less POSTs). Environment variables live in the dashboard, not `syncEnvVars`.

**Cross-links.** The `whisperlivekit` coupling and the `livekit-agents<1.6` hold are both tracked in
more detail on simpleDiscordBot#659 (voice capability layer), which is where the `line.validated` bug
was root-caused and where upstream's Turn Detector v1.0 overlap is discussed. This PRD owns the
*policy and monitoring*; that one owns the *voice-specific fixes*.

**Evidence base.** Every version figure above came from a live audit on 2026-08-19 — reading pins from
source, exec'ing into running containers on both hosts for installed versions, and querying PyPI and
the GitHub releases API for upstream. The bespoke-patch inventory came from grepping compose files for
mounts over upstream paths and source for internal-API access.
