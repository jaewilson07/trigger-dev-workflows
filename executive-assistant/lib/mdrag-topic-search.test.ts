import assert from "node:assert/strict";
import { test } from "node:test";
import { selectUnseenResults } from "./mdrag-topic-search.js";
import type { TopicSearchResultItem } from "./mdrag-topic-search.js";

function item(url: string): TopicSearchResultItem {
  return { title: `Title for ${url}`, url, snippet: "snippet", source: "mdrag/searxng" };
}

test("selectUnseenResults returns the first `limit` unseen candidates in original order", () => {
  const candidates = ["a", "b", "c", "d", "e"].map(item);
  const seen = new Set<string>();
  const result = selectUnseenResults(candidates, seen, 3);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "b", "c"]
  );
});

test("selectUnseenResults skips seen candidates and keeps original order", () => {
  const candidates = ["a", "b", "c", "d", "e"].map(item);
  const seen = new Set(["b", "d"]);
  const result = selectUnseenResults(candidates, seen, 3);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "c", "e"]
  );
});

test("selectUnseenResults returns fewer than `limit` when unseen candidates run out", () => {
  const candidates = ["a", "b", "c"].map(item);
  const seen = new Set(["a", "b", "c"]);
  const result = selectUnseenResults(candidates, seen, 5);
  assert.deepEqual(result, []);
});

test("selectUnseenResults returns all candidates unfiltered when nothing is seen", () => {
  const candidates = ["a", "b", "c"].map(item);
  const seen = new Set<string>();
  const result = selectUnseenResults(candidates, seen, 10);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "b", "c"]
  );
});

test("selectUnseenResults stops as soon as `limit` unseen items are collected, ignoring later candidates", () => {
  const candidates = ["a", "b", "c", "d"].map(item);
  const seen = new Set<string>();
  const result = selectUnseenResults(candidates, seen, 2);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "b"]
  );
});
