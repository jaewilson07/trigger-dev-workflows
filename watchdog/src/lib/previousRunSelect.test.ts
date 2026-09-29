import assert from "node:assert/strict";
import { test } from "node:test";
import { PreviousRunMismatchError, selectPreviousRunId } from "./previousRunSelect.js";

test("empty list means no previous run", () => {
  assert.equal(selectPreviousRunId({ data: [] }, "t"), null);
  assert.equal(selectPreviousRunId({}, "t"), null);
});

test("a matching COMPLETED run is selected", () => {
  assert.equal(selectPreviousRunId({ data: [{ id: "run_1", taskIdentifier: "t", status: "COMPLETED" }] }, "t"), "run_1");
});

test("another task's run (filter ignored) throws a named error", () => {
  assert.throws(
    () => selectPreviousRunId({ data: [{ id: "run_2", taskIdentifier: "other", status: "COMPLETED" }] }, "t"),
    PreviousRunMismatchError,
  );
});

test("a non-COMPLETED run (status filter ignored) throws", () => {
  assert.throws(
    () => selectPreviousRunId({ data: [{ id: "run_3", taskIdentifier: "t", status: "FAILED" }] }, "t"),
    PreviousRunMismatchError,
  );
});
