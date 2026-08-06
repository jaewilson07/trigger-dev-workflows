/**
 * Notion delivery primitive: markdown in, a database row out.
 *
 * The Notion sibling of `lib/google-docs.ts` — same contract (`upsert…`,
 * returns `{ created }` so the caller can say whether it made or overwrote
 * something), same posture (this module throws; deciding that an unconfigured
 * destination is `skipped` rather than an error belongs to the destination
 * task, not to the transport).
 *
 * ## Why raw `fetch` and not `@notionhq/client`
 *
 * Four endpoints are used here — retrieve a database, query it, create a page,
 * append/delete blocks. The official SDK is a dependency on every deploy of
 * every project that delivers to Notion, for a thin wrapper over `fetch` plus
 * types this file already declares. `googleapis` is in this project precisely
 * because Drive's API is genuinely hard to speak by hand; Notion's is not.
 *
 * ## Why the markdown converter is reimplemented here
 *
 * `cboti`'s `integrations/notion/markdown_converter.py` is the reference and
 * this is a deliberate port of its decisions, not a fresh design — but it is
 * Python, and Trigger.dev tasks are TypeScript in a separate deploy artifact.
 * The behaviours carried over are the ones that are Notion API constraints
 * rather than taste:
 *
 *   - a single rich-text item may not exceed 2000 characters (`chunk`);
 *   - a create/append request may not carry more than 100 blocks;
 *   - one request may not nest children more than two levels deep;
 *   - `code.language` is validated against a closed enum — anything else is a
 *     400, so unknown fence infos fall back to `plain text`;
 *   - Notion has three heading levels, so `####`+ clamp to `heading_3`.
 *
 * What is deliberately NOT carried over is the Python version's mistune
 * dependency: this is a line-based parser covering the subset our renderers
 * actually emit (`lib/render-report.ts`, `lib/format-brief.ts`,
 * `watchdog/src/lib/infra-health.ts`'s `buildMarkdown`) — headings, paragraphs,
 * bullet/numbered/task lists with nesting, fenced code, blockquotes, GFM
 * tables, horizontal rules, and inline bold/italic/strike/code/links. Anything
 * it does not recognise survives as paragraph text rather than being dropped,
 * which is the one property that matters for a delivery path: a report that
 * arrives slightly under-formatted beats a report that does not arrive.
 */

const NOTION_API = "https://api.notion.com/v1";

/**
 * Pinned, not floating. Notion's `2025-09-03` version replaced `parent:
 * { database_id }` with data sources and would silently change the shape of
 * every call below; the version header is the only thing keeping this file
 * honest about which API it was written against.
 */
const NOTION_VERSION = "2022-06-28";

/** Notion rejects any single rich-text item longer than this. */
const MAX_RICH_TEXT_LENGTH = 2000;

/** Notion accepts at most this many blocks per create/append request. */
const MAX_BLOCKS_PER_REQUEST = 100;

/** Notion accepts at most this much child nesting in a single request. */
const MAX_NESTING_DEPTH = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotionAnnotations = {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
};

export type NotionRichText = {
  type: "text";
  text: { content: string; link: { url: string } | null };
  annotations: NotionAnnotations;
};

export type NotionBlock = {
  object: "block";
  type: string;
  [payload: string]: unknown;
};

type InlineStyle = {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
  link: string | null;
};

const DEFAULT_STYLE: InlineStyle = {
  bold: false,
  italic: false,
  strikethrough: false,
  code: false,
  link: null,
};

// ---------------------------------------------------------------------------
// Code languages
// ---------------------------------------------------------------------------

/**
 * Notion validates `code.language` against a closed enum — anything else is a
 * 400 on the whole request, which would turn "the fence said ```jsonc" into a
 * failed delivery. Unlisted languages fall back to `plain text`.
 */
const CODE_LANGUAGES = new Set([
  "abap", "arduino", "assembly", "bash", "basic", "c", "c#", "c++", "clojure",
  "coffeescript", "coq", "css", "dart", "diff", "docker", "elixir", "elm",
  "erlang", "f#", "flow", "fortran", "gherkin", "glsl", "go", "graphql",
  "groovy", "haskell", "html", "java", "javascript", "json", "julia", "kotlin",
  "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown",
  "markup", "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal",
  "perl", "php", "plain text", "powershell", "prolog", "protobuf", "python",
  "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell",
  "solidity", "sql", "swift", "toml", "typescript", "vb.net", "verilog",
  "vhdl", "visual basic", "webassembly", "xml", "yaml",
]);

/** Common fence-info spellings that aren't the Notion enum value. */
const LANGUAGE_ALIASES: Record<string, string> = {
  cpp: "c++", cs: "c#", csharp: "c#", dockerfile: "docker", fsharp: "f#",
  golang: "go", htm: "html", js: "javascript", jsonc: "json", jsx: "javascript",
  kt: "kotlin", md: "markdown", objc: "objective-c", plaintext: "plain text",
  py: "python", rb: "ruby", rs: "rust", sh: "shell", text: "plain text",
  ts: "typescript", tsx: "typescript", txt: "plain text", vb: "visual basic",
  yml: "yaml", zsh: "shell",
};

export function normalizeLanguage(info: string | undefined): string {
  const first = (info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first) return "plain text";
  const mapped = LANGUAGE_ALIASES[first] ?? first;
  return CODE_LANGUAGES.has(mapped) ? mapped : "plain text";
}

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

function chunk(text: string, size = MAX_RICH_TEXT_LENGTH): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function annotationsOf(style: InlineStyle): NotionAnnotations {
  return {
    bold: style.bold,
    italic: style.italic,
    strikethrough: style.strikethrough,
    underline: false,
    code: style.code,
    color: "default",
  };
}

/** Build a `rich_text` array for one styled string, split to Notion's cap. */
export function richText(content: string, style: InlineStyle = DEFAULT_STYLE): NotionRichText[] {
  if (!content) return [];
  return chunk(content).map((piece) => ({
    type: "text" as const,
    text: { content: piece, link: style.link ? { url: style.link } : null },
    annotations: annotationsOf(style),
  }));
}

/**
 * Merge adjacent runs sharing annotations and link.
 *
 * Notion caps a block at 100 rich-text items, and character-by-character
 * emission from the inline scanner blows past that on a heavily formatted
 * paragraph long before it hits any content limit.
 */
function mergeRuns(items: NotionRichText[]): NotionRichText[] {
  const merged: NotionRichText[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      JSON.stringify(prev.annotations) === JSON.stringify(item.annotations) &&
      JSON.stringify(prev.text.link) === JSON.stringify(item.text.link) &&
      prev.text.content.length + item.text.content.length <= MAX_RICH_TEXT_LENGTH
    ) {
      prev.text.content += item.text.content;
    } else {
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Inline markdown → `rich_text`.
 *
 * Leftmost-match alternation rather than a tokenizer: `exec` finds the earliest
 * position any delimiter opens, so ordering within the pattern only decides
 * ties at the SAME position. That is what makes `**` win over `*` (both open at
 * the same index, `**` is listed first) and `![alt](url)` win over the `[…](…)`
 * inside it (the `!` is one character earlier, so it is not even a tie).
 */
function parseInline(text: string, style: InlineStyle = DEFAULT_STYLE): NotionRichText[] {
  const out: NotionRichText[] = [];
  let rest = text;

  // Order matters only for same-position ties — see the docstring.
  const pattern =
    /(?:!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(?:\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(?:`([^`]+)`)|(?:\*\*([\s\S]+?)\*\*)|(?:__([\s\S]+?)__)|(?:~~([\s\S]+?)~~)|(?:\*([^*\n]+?)\*)|(?:_([^_\n]+?)_)|(?:<(https?:\/\/[^>\s]+)>)/;

  while (rest) {
    const match = pattern.exec(rest);
    if (!match) {
      out.push(...richText(rest, style));
      break;
    }

    if (match.index > 0) out.push(...richText(rest.slice(0, match.index), style));

    const [
      ,
      imageAlt,
      ,
      linkText,
      linkUrl,
      codeSpan,
      strongStar,
      strongUnderscore,
      strike,
      emphasisStar,
      emphasisUnderscore,
      autolink,
    ] = match;

    if (imageAlt !== undefined) {
      // Notion has no inline image inside a paragraph. Keep the alt text so the
      // sentence still reads — the same degradation cboti's converter makes.
      out.push(...richText(imageAlt, style));
    } else if (linkText !== undefined) {
      out.push(...parseInline(linkText, { ...style, link: linkUrl ?? null }));
    } else if (codeSpan !== undefined) {
      out.push(...richText(codeSpan, { ...style, code: true }));
    } else if (strongStar !== undefined) {
      out.push(...parseInline(strongStar, { ...style, bold: true }));
    } else if (strongUnderscore !== undefined) {
      out.push(...parseInline(strongUnderscore, { ...style, bold: true }));
    } else if (strike !== undefined) {
      out.push(...parseInline(strike, { ...style, strikethrough: true }));
    } else if (emphasisStar !== undefined) {
      out.push(...parseInline(emphasisStar, { ...style, italic: true }));
    } else if (emphasisUnderscore !== undefined) {
      out.push(...parseInline(emphasisUnderscore, { ...style, italic: true }));
    } else if (autolink !== undefined) {
      out.push(...richText(autolink, { ...style, link: autolink }));
    }

    rest = rest.slice(match.index + match[0].length);
  }

  return mergeRuns(out);
}

// ---------------------------------------------------------------------------
// Block builders
// ---------------------------------------------------------------------------

function block(type: string, payload: Record<string, unknown>): NotionBlock {
  return { object: "block", type, [type]: payload };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const RE_FENCE = /^\s*(`{3,}|~{3,})\s*(.*)$/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

type ListEntry = {
  indent: number;
  ordered: boolean;
  checked: boolean | null;
  text: string;
  children: ListEntry[];
};

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function tableBlock(rows: string[][], hasHeader: boolean): NotionBlock {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
  // Notion requires every row to carry exactly `table_width` cells.
  const children = rows.map((row) =>
    block("table_row", {
      cells: Array.from({ length: width }, (_, i) => parseInline(row[i] ?? "")),
    })
  );
  return block("table", {
    table_width: width,
    has_column_header: hasHeader,
    has_row_header: false,
    children,
  });
}

function listEntryToBlock(entry: ListEntry): NotionBlock {
  const type =
    entry.checked !== null ? "to_do" : entry.ordered ? "numbered_list_item" : "bulleted_list_item";

  const payload: Record<string, unknown> = { rich_text: parseInline(entry.text) };
  if (entry.checked !== null) payload.checked = entry.checked;
  if (entry.children.length > 0) {
    payload.children = entry.children.map(listEntryToBlock);
  }
  return block(type, payload);
}

/** Build a nesting tree from flat, indent-tagged list entries. */
function nestListEntries(flat: ListEntry[]): ListEntry[] {
  const roots: ListEntry[] = [];
  const stack: ListEntry[] = [];

  for (const entry of flat) {
    while (stack.length > 0 && entry.indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  }

  return roots;
}

/**
 * Notion accepts at most `MAX_NESTING_DEPTH` levels of children in a single
 * request. Deeper items are hoisted to the deepest allowed level rather than
 * dropped — a four-deep outline arrives flat-at-the-bottom instead of 400ing.
 */
function limitNesting(blocks: NotionBlock[], depth = 0): NotionBlock[] {
  const out: NotionBlock[] = [];
  for (const b of blocks) {
    const payload = b[b.type] as Record<string, unknown> | undefined;
    const children = payload?.children as NotionBlock[] | undefined;
    if (!children || children.length === 0) {
      out.push(b);
      continue;
    }
    if (depth + 1 < MAX_NESTING_DEPTH) {
      out.push({ ...b, [b.type]: { ...payload, children: limitNesting(children, depth + 1) } });
    } else {
      const { children: _dropped, ...rest } = payload!;
      out.push({ ...b, [b.type]: rest });
      out.push(...limitNesting(children, depth));
    }
  }
  return out;
}

/**
 * Markdown → Notion blocks.
 *
 * Pure: no network, no auth. See this module's docstring for the covered
 * subset and the constraints that shaped it.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: NotionBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // ── Fenced code ────────────────────────────────────────────
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const info = fence[2] ?? "";
      const closer = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume the closing fence (or fall off the end on an unclosed one)
      blocks.push(
        block("code", { rich_text: richText(body.join("\n")), language: normalizeLanguage(info) })
      );
      continue;
    }

    // ── Horizontal rule ────────────────────────────────────────
    // Checked before lists: `RE_LIST` needs whitespace after the marker, so
    // `---` cannot match it, but `* * *` would.
    if (RE_RULE.test(line) || /^\s*(?:[-*_]\s+){2,}[-*_]\s*$/.test(line)) {
      blocks.push(block("divider", {}));
      i++;
      continue;
    }

    // ── Heading ────────────────────────────────────────────────
    const heading = RE_HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3);
      blocks.push(block(`heading_${level}`, { rich_text: parseInline(heading[2]!.trim()) }));
      i++;
      continue;
    }

    // ── GFM table ──────────────────────────────────────────────
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_DELIMITER.test(lines[i + 1]!)) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2; // header + delimiter
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      blocks.push(tableBlock(rows, true));
      continue;
    }

    // ── Blockquote ─────────────────────────────────────────────
    const quote = RE_QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1]!];
      i++;
      while (i < lines.length) {
        const next = RE_QUOTE.exec(lines[i]!);
        if (!next) break;
        body.push(next[1]!);
        i++;
      }
      blocks.push(block("quote", { rich_text: parseInline(body.join("\n").trim()) }));
      continue;
    }

    // ── Lists ──────────────────────────────────────────────────
    if (RE_LIST.test(line)) {
      const flat: ListEntry[] = [];
      while (i < lines.length) {
        const item = RE_LIST.exec(lines[i]!);
        if (item) {
          const marker = item[2]!;
          let text = item[3]!;
          let checked: boolean | null = null;
          const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
          if (task) {
            checked = task[1]!.toLowerCase() === "x";
            text = task[2]!;
          }
          flat.push({
            indent: item[1]!.length,
            ordered: /\d/.test(marker),
            checked,
            text,
            children: [],
          });
          i++;
          continue;
        }
        // A blank line inside a list is a loose-list separator; a blank line
        // followed by anything that is not a list item ends the list.
        if (!lines[i]!.trim() && i + 1 < lines.length && RE_LIST.test(lines[i + 1]!)) {
          i++;
          continue;
        }
        break;
      }
      blocks.push(...nestListEntries(flat).map(listEntryToBlock));
      continue;
    }

    // ── Paragraph ──────────────────────────────────────────────
    const paragraph: string[] = [line.trim()];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (
        !next.trim() ||
        RE_FENCE.test(next) ||
        RE_HEADING.test(next) ||
        RE_RULE.test(next) ||
        RE_QUOTE.test(next) ||
        RE_LIST.test(next)
      ) {
        break;
      }
      paragraph.push(next.trim());
      i++;
    }
    const rich = parseInline(paragraph.join("\n"));
    if (rich.length > 0) blocks.push(block("paragraph", { rich_text: rich }));
  }

  return limitNesting(blocks);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Accept a raw id, a dashed id, or a pasted Notion URL.
 *
 * `NOTION_DATABASE_ID` is copied out of a browser far more often than it is
 * copied out of an API response, and a URL-shaped value otherwise fails as an
 * opaque `object_not_found` rather than as "that isn't an id".
 */
export function extractNotionId(value: string): string {
  const hex = value.replace(/-/g, "").match(/[0-9a-fA-F]{32}/g);
  if (!hex || hex.length === 0) return value.trim();
  const id = hex[hex.length - 1]!;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * The auth token, from the payload or the environment.
 *
 * TWO NAMES, DELIBERATELY. `NOTION_TOKEN` is what this repo's `.env.example`
 * documents and what a fresh checkout will set. `NOTION_API_KEY` is what the
 * secret is ALREADY called in the org's Infisical (verified 2026-08-05: one
 * `ntn_` internal-integration secret under that name, owned by the bot named
 * "Triggers.dev"). Reading both means the destination works against the
 * existing secret store without renaming a secret other things may read, and
 * against a plain local `.env` without knowing that history.
 */
export function notionTokenFromEnv(): string {
  return process.env.NOTION_TOKEN || process.env.NOTION_API_KEY || "";
}

async function notionFetch<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  if (!response.ok) {
    // Notion's error body carries `code` and `message`, and both matter: `code`
    // separates "the integration was never shared with this database"
    // (object_not_found) from "the token is wrong" (unauthorized), which look
    // identical from the status alone.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      detail = `${parsed.code ?? response.status}: ${parsed.message ?? text}`;
    } catch {
      // Non-JSON body (a proxy error page) — the raw text is the best detail.
    }
    throw new Error(`Notion ${method} ${path} failed (${response.status}) — ${detail}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

type NotionDatabase = {
  properties: Record<string, { type: string }>;
};

type NotionPageResponse = {
  id: string;
  url: string;
};

type NotionQueryResponse = {
  results: Array<{ id: string; url: string }>;
  next_cursor: string | null;
  has_more: boolean;
};

type NotionChildrenResponse = {
  results: Array<{ id: string }>;
  next_cursor: string | null;
  has_more: boolean;
};

/**
 * A database's title property is named by whoever made the database — "Name",
 * "Title", "Report", anything. Only its TYPE is fixed, so the name is resolved
 * from the schema rather than assumed; assuming `"Name"` is the single most
 * common way a Notion integration 400s on somebody else's workspace.
 */
async function titlePropertyName(token: string, databaseId: string): Promise<string> {
  const database = await notionFetch<NotionDatabase>(token, "GET", `/databases/${databaseId}`);
  for (const [name, property] of Object.entries(database.properties ?? {})) {
    if (property?.type === "title") return name;
  }
  throw new Error(`Notion database ${databaseId} has no title property`);
}

/** Exact-then-case-insensitive title lookup, matching cboti's `find_page_by_title`. */
async function findPageByTitle(
  token: string,
  databaseId: string,
  property: string,
  title: string
): Promise<{ id: string; url: string } | null> {
  const exact = await notionFetch<NotionQueryResponse>(
    token,
    "POST",
    `/databases/${databaseId}/query`,
    { filter: { property, title: { equals: title } }, page_size: 1 }
  );
  if (exact.results.length > 0) return exact.results[0]!;

  // Notion's `equals` is case-sensitive. Re-check loosely so a title differing
  // only in casing updates the existing row instead of creating a duplicate.
  const loose = await notionFetch<NotionQueryResponse & { results: Array<Record<string, any>> }>(
    token,
    "POST",
    `/databases/${databaseId}/query`,
    { filter: { property, title: { contains: title } }, page_size: 25 }
  );
  const wanted = title.trim().toLowerCase();
  for (const page of loose.results) {
    const parts = page.properties?.[property]?.title as Array<{ plain_text?: string }> | undefined;
    const text = (parts ?? []).map((p) => p.plain_text ?? "").join("");
    if (text.trim().toLowerCase() === wanted) return { id: page.id, url: page.url };
  }
  return null;
}

/** Notion has no bulk delete, so clearing a page is one request per block. */
async function clearPage(token: string, pageId: string): Promise<number> {
  let cursor: string | null = null;
  const ids: string[] = [];
  do {
    const query: string = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const page: NotionChildrenResponse = await notionFetch<NotionChildrenResponse>(
      token,
      "GET",
      `/blocks/${pageId}/children${query}`
    );
    ids.push(...page.results.map((b) => b.id));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);

  for (const id of ids) {
    await notionFetch(token, "DELETE", `/blocks/${id}`);
  }
  return ids.length;
}

async function appendBlocks(token: string, pageId: string, blocks: NotionBlock[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    await notionFetch(token, "PATCH", `/blocks/${pageId}/children`, {
      children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST),
    });
  }
}

export type NotionUpsertResult = {
  pageId: string;
  url: string;
  /** `true` when a new row was created, `false` when an existing one was rewritten. */
  created: boolean;
  blockCount: number;
};

/**
 * What `tasks/deliver-notion.ts` reports back.
 *
 * Declared here, next to the transport, because ONE task serves BOTH delivery
 * seams in this project (`lib/brief-delivery.ts` and `lib/report-delivery.ts`)
 * — see that task's docstring for why Notion did not need the split that
 * `deliver-gdoc` / `report-gdoc` did. Both seams carry a structurally identical
 * `notion` member in their own union so their narrowing helpers keep working;
 * this is the shape they must match.
 */
export type NotionDeliveryOutcome =
  | {
      destination: "notion";
      status: "delivered";
      url: string;
      pageId: string;
      created: boolean;
    }
  | { destination: "notion"; status: "skipped"; reason: string };

export function notionSkipped(reason: string): NotionDeliveryOutcome {
  return { destination: "notion", status: "skipped", reason };
}

/**
 * Create or overwrite a database row keyed on its title — the direct analogue
 * of `upsertMarkdownDoc` in `lib/google-docs.ts`.
 *
 * `mode: "replace"` (the default) clears the page's existing blocks first, so
 * re-delivering the same title twice leaves one page with one copy of the
 * content rather than a page that has grown a second copy. `mode: "append"`
 * exists for the rolling-log shape, where each delivery adds to what is there.
 *
 * Throws on any API failure. Whether a missing token or database is `skipped`
 * or `failed` is the destination task's call, not this module's.
 */
export async function upsertNotionPage(options: {
  token: string;
  databaseId: string;
  title: string;
  markdown: string;
  mode?: "replace" | "append";
  /** Extra database properties, merged with the title. Types must match the schema. */
  properties?: Record<string, unknown>;
}): Promise<NotionUpsertResult> {
  const { token, title, markdown } = options;
  const databaseId = extractNotionId(options.databaseId);
  const mode = options.mode ?? "replace";

  const blocks = markdownToBlocks(markdown);
  const property = await titlePropertyName(token, databaseId);
  const existing = await findPageByTitle(token, databaseId, property, title);

  const properties = {
    [property]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
    ...(options.properties ?? {}),
  };

  if (!existing) {
    // The first 100 blocks ride along with the create; the rest are appended.
    // One request is the common case — a report is rarely 100+ blocks — and
    // splitting keeps a long one from 400ing on the block cap.
    const page = await notionFetch<NotionPageResponse>(token, "POST", "/pages", {
      parent: { database_id: databaseId },
      properties,
      children: blocks.slice(0, MAX_BLOCKS_PER_REQUEST),
    });
    await appendBlocks(token, page.id, blocks.slice(MAX_BLOCKS_PER_REQUEST));
    return { pageId: page.id, url: page.url, created: true, blockCount: blocks.length };
  }

  if (mode === "replace") await clearPage(token, existing.id);
  await notionFetch(token, "PATCH", `/pages/${existing.id}`, { properties });
  await appendBlocks(token, existing.id, blocks);

  return { pageId: existing.id, url: existing.url, created: false, blockCount: blocks.length };
}
