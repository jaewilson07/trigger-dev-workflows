import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNotionId, markdownToBlocks, normalizeLanguage, richText } from "./notion.js";

/**
 * The markdown → Notion block converter is the one part of the Notion path
 * that is worth unit-testing: it is pure, it is the part most likely to drift
 * from what our renderers actually emit, and its failure mode in production is
 * a 400 from Notion on a whole delivery rather than a visibly wrong page.
 *
 * The cases below are drawn from what `lib/render-report.ts`,
 * `lib/format-brief.ts` and `watchdog/src/lib/infra-health.ts`'s
 * `buildMarkdown` produce — headings, cited bullets, tables, fenced code —
 * plus the four Notion API limits `lib/notion.ts` exists to respect.
 */

type Block = ReturnType<typeof markdownToBlocks>[number];

function payload(block: Block): any {
  return (block as any)[block.type];
}

function plain(block: Block): string {
  const rich = payload(block).rich_text as Array<{ text: { content: string } }>;
  return rich.map((r) => r.text.content).join("");
}

test("headings clamp to Notion's three levels", () => {
  const blocks = markdownToBlocks("# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading_1", "heading_2", "heading_3", "heading_3", "heading_3"]
  );
  assert.equal(plain(blocks[3]!), "Four");
});

test("paragraphs join their wrapped lines", () => {
  const blocks = markdownToBlocks("A sentence that\nwraps across lines.\n\nA second one.");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "paragraph"]
  );
  assert.equal(plain(blocks[0]!), "A sentence that\nwraps across lines.");
});

test("inline styles become annotations, not literal asterisks", () => {
  const [block] = markdownToBlocks("**bold** and *italic* and `code` and ~~gone~~");
  const rich = payload(block!).rich_text as Array<{
    text: { content: string };
    annotations: Record<string, unknown>;
  }>;
  const styled = Object.fromEntries(rich.map((r) => [r.text.content, r.annotations]));
  assert.equal(styled["bold"]!.bold, true);
  assert.equal(styled["italic"]!.italic, true);
  assert.equal(styled["code"]!.code, true);
  assert.equal(styled["gone"]!.strikethrough, true);
  // The delimiters themselves must not survive into the content.
  assert.equal(plain(block!), "bold and italic and code and gone");
});

test("links carry their url, and `**` wins over `*` at the same position", () => {
  const [block] = markdownToBlocks("See [the doc](https://example.com/a) for **more**.");
  const rich = payload(block!).rich_text as Array<{
    text: { content: string; link: { url: string } | null };
  }>;
  const link = rich.find((r) => r.text.link !== null);
  assert.equal(link?.text.content, "the doc");
  assert.equal(link?.text.link?.url, "https://example.com/a");
  assert.equal(plain(block!), "See the doc for more.");
});

test("bullet, numbered and task lists map to their own block types", () => {
  const blocks = markdownToBlocks("- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo");
  assert.deepEqual(
    blocks.map((b) => b.type),
    [
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "numbered_list_item",
      "to_do",
      "to_do",
    ]
  );
  assert.equal(payload(blocks[4]!).checked, true);
  assert.equal(payload(blocks[5]!).checked, false);
});

test("indented list items nest as children", () => {
  const blocks = markdownToBlocks("- parent\n  - child\n- sibling");
  assert.equal(blocks.length, 2);
  assert.equal(plain(blocks[0]!), "parent");
  const children = payload(blocks[0]!).children as Block[];
  assert.equal(children.length, 1);
  assert.equal(plain(children[0]!), "child");
});

test("nesting deeper than Notion allows is hoisted, not dropped", () => {
  // Four levels deep. Notion accepts two levels of children per request, so the
  // deepest items must reappear at the deepest allowed level rather than 400.
  const blocks = markdownToBlocks("- a\n  - b\n    - c\n      - d");
  const flatten = (bs: Block[]): string[] =>
    bs.flatMap((b) => [plain(b), ...flatten((payload(b).children as Block[]) ?? [])]);
  assert.deepEqual(flatten(blocks).sort(), ["a", "b", "c", "d"]);
});

test("fenced code keeps its body and normalizes the language", () => {
  const [block] = markdownToBlocks("```ts\nconst x = 1;\nconst y = 2;\n```");
  assert.equal(block!.type, "code");
  assert.equal(payload(block!).language, "typescript");
  assert.equal(plain(block!), "const x = 1;\nconst y = 2;");
});

test("an unknown fence language falls back to plain text rather than 400ing", () => {
  assert.equal(normalizeLanguage("hylang"), "plain text");
  assert.equal(normalizeLanguage(""), "plain text");
  assert.equal(normalizeLanguage(undefined), "plain text");
  assert.equal(normalizeLanguage("JSONC"), "json");
  assert.equal(normalizeLanguage("bash showLineNumbers"), "bash");
});

test("markdown inside a code fence is not parsed as markdown", () => {
  const [block] = markdownToBlocks("```\n# not a heading\n- not a list\n```");
  assert.equal(block!.type, "code");
  assert.equal(plain(block!), "# not a heading\n- not a list");
});

test("GFM tables become a table block with padded rows", () => {
  const [block] = markdownToBlocks(
    "| Service | Status |\n| --- | --- |\n| caddy | ok |\n| letta |"
  );
  assert.equal(block!.type, "table");
  const table = payload(block!);
  assert.equal(table.table_width, 2);
  assert.equal(table.has_column_header, true);
  assert.equal(table.children.length, 3);
  // Notion requires every row to carry exactly `table_width` cells.
  for (const row of table.children) {
    assert.equal(row.table_row.cells.length, 2);
  }
});

test("horizontal rules become dividers and do not read as list items", () => {
  const blocks = markdownToBlocks("before\n\n---\n\nafter");
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["paragraph", "divider", "paragraph"]
  );
});

test("blockquotes collapse consecutive lines into one quote", () => {
  const blocks = markdownToBlocks("> first\n> second\n\nafter");
  assert.equal(blocks[0]!.type, "quote");
  assert.equal(plain(blocks[0]!), "first\nsecond");
  assert.equal(blocks[1]!.type, "paragraph");
});

test("rich text splits at Notion's 2000-character cap", () => {
  const parts = richText("x".repeat(4500));
  assert.deepEqual(
    parts.map((p) => p.text.content.length),
    [2000, 2000, 500]
  );
});

test("a long paragraph stays one block but several rich-text items", () => {
  const [block] = markdownToBlocks("y".repeat(3000));
  assert.equal(block!.type, "paragraph");
  assert.equal(payload(block!).rich_text.length, 2);
});

test("empty and whitespace-only markdown produces no blocks", () => {
  assert.deepEqual(markdownToBlocks(""), []);
  assert.deepEqual(markdownToBlocks("\n\n   \n"), []);
});

test("extractNotionId accepts a raw id, a dashed id, or a pasted URL", () => {
  const dashed = "1f2e3d4c-5b6a-7980-9182-736455443322";
  const raw = dashed.replace(/-/g, "");
  assert.equal(extractNotionId(raw), dashed);
  assert.equal(extractNotionId(dashed), dashed);
  assert.equal(extractNotionId(`https://www.notion.so/workspace/${raw}?v=abc`), dashed);
  // Nothing id-shaped: hand it back untouched so the API's own error is the
  // one the operator sees, rather than a mangled value.
  assert.equal(extractNotionId("not-an-id"), "not-an-id");
});
