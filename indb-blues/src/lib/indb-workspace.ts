import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneRepo } from "@datacrew/trigger-shared";

/**
 * Sets up a throwaway `indb_discordbot` + `cboti` checkout for a single task
 * run — the same `git-uv` clone-then-`uv run` pattern watchdog's
 * `crew-rag-domo-scrape` already uses live in production.
 *
 * `cboti` is cloned as a SIBLING under `libraries/`, not nested inside
 * `indb_discordbot/`, because `indb_discordbot/pyproject.toml` declares it
 * as a required dependency resolved via
 * `[tool.uv.sources] cboti = { path = "../libraries/cboti" }` — `uv sync`
 * fails outright without it at exactly that relative path. This mirrors
 * `.github/workflows/drop-of-the-week.yml`'s own two `actions/checkout`
 * steps (`indb_discordbot/` and `libraries/cboti/`, both directly under the
 * workspace root) for the same reason its own comment gives: checkout
 * blocks `..` path traversal, so the dependency has to be a real sibling
 * rather than reached by symlink or relative escape.
 */
export type IndbWorkspace = {
  scratchRoot: string;
  indbDir: string;
  cbotiDir: string;
  cleanup(): Promise<void>;
};

const INDB_REPO = "https://github.com/jaewilson07/indb_discordbot.git";
const CBOTI_REPO = "https://github.com/jaewilson07/cboti.git";

export async function setupIndbWorkspace(ghToken: string, tmpPrefix: string): Promise<IndbWorkspace> {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  const librariesDir = path.join(scratchRoot, "libraries");
  const indbDir = path.join(scratchRoot, "indb_discordbot");
  const cbotiDir = path.join(librariesDir, "cboti");

  await fs.mkdir(librariesDir, { recursive: true });
  await cloneRepo(INDB_REPO, indbDir, ghToken);
  await cloneRepo(CBOTI_REPO, cbotiDir, ghToken);

  return {
    scratchRoot,
    indbDir,
    cbotiDir,
    cleanup: () => fs.rm(scratchRoot, { recursive: true, force: true }),
  };
}

/** Path to `blues_drop_artist_mode.py`, relative to `indbDir` — the script
 * this whole project invokes rather than reimplements (see its own module
 * docstring for why it's not `generate-drop-of-the-week/scripts/post_to_discord.py`). */
export const BLUES_DROP_SCRIPT_REL_PATH =
  ".agents/runbooks/weekly-drop-flow/scripts/blues_drop_artist_mode.py";

export const DROP_MANIFEST_REL_PATH = ".agents/runbooks/weekly-drop-flow/drop_manifest.json";
