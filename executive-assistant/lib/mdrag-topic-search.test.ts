import assert from "node:assert/strict";
import { test } from "node:test";
import { selectReadyResults } from "./mdrag-topic-search.js";
import type { TopicSearchResultItem } from "./mdrag-topic-search.js";

function item(url: string): TopicSearchResultItem {
  return { title: `Title for ${url}`, url, snippet: "snippet", source: "mdrag/searxng" };
}

function ready(url: string): [string, { documentUid: string; blurb: string }] {
  return [url, { documentUid: `uid-${url}`, blurb: `Why ${url} is interesting` }];
}

test("selectReadyResults returns the first `limit` ready candidates in original order", () => {
  const candidates = ["a", "b", "c", "d", "e"].map(item);
  const readyByUrl = new Map([ready("a"), ready("b"), ready("c"), ready("d"), ready("e")]);
  const result = selectReadyResults(candidates, readyByUrl, 3);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "b", "c"]
  );
});

test("selectReadyResults skips not-ready candidates and keeps original order", () => {
  const candidates = ["a", "b", "c", "d", "e"].map(item);
  const readyByUrl = new Map([ready("a"), ready("c"), ready("e")]);
  const result = selectReadyResults(candidates, readyByUrl, 3);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "c", "e"]
  );
});

test("selectReadyResults returns fewer than `limit` when ready candidates run out", () => {
  const candidates = ["a", "b", "c"].map(item);
  const readyByUrl = new Map<string, { documentUid: string; blurb: string }>();
  const result = selectReadyResults(candidates, readyByUrl, 5);
  assert.deepEqual(result, []);
});

test("selectReadyResults returns all candidates when every one is ready", () => {
  const candidates = ["a", "b", "c"].map(item);
  const readyByUrl = new Map([ready("a"), ready("b"), ready("c")]);
  const result = selectReadyResults(candidates, readyByUrl, 10);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "b", "c"]
  );
});

test("selectReadyResults stops as soon as `limit` ready items are collected, ignoring later candidates", () => {
  const candidates = ["a", "b", "c", "d"].map(item);
  const readyByUrl = new Map([ready("a"), ready("b"), ready("c"), ready("d")]);
  const result = selectReadyResults(candidates, readyByUrl, 2);
  assert.deepEqual(
    result.map((r) => r.url),
    ["a", "b"]
  );
});

test("selectReadyResults attaches documentUid and blurb from readyByUrl onto the selected item", () => {
  const candidates = [item("a")];
  const readyByUrl = new Map([ready("a")]);
  const result = selectReadyResults(candidates, readyByUrl, 5);
  assert.deepEqual(result, [
    {
      title: "Title for a",
      url: "a",
      snippet: "snippet",
      source: "mdrag/searxng",
      documentUid: "uid-a",
      blurb: "Why a is interesting",
    },
  ]);
});
