import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCondition, interpolate, resolvePath } from "./expression.js";

const scope = {
  input: { name: "Theo", count: 3, enabled: true },
  steps: { fetch: { output: { status: 200, items: [1, 2] } } },
};

test("resolvePath walks nested paths", () => {
  assert.equal(resolvePath("input.name", scope), "Theo");
  assert.equal(resolvePath("steps.fetch.output.status", scope), 200);
  assert.equal(resolvePath("steps.missing.output", scope), undefined);
});

test("a full reference preserves the resolved value's type", () => {
  assert.equal(interpolate("${input.count}", scope), 3);
  assert.deepEqual(interpolate("${steps.fetch.output.items}", scope), [1, 2]);
});

test("embedded references stringify into the surrounding text", () => {
  assert.equal(interpolate("Hi ${input.name} (${input.count})", scope), "Hi Theo (3)");
});

test("interpolation recurses into objects and arrays", () => {
  const out = interpolate({ a: "${input.name}", b: ["${input.count}"] }, scope);
  assert.deepEqual(out, { a: "Theo", b: [3] });
});

test("bare condition evaluates truthiness", () => {
  assert.equal(evaluateCondition("${input.enabled}", scope), true);
  assert.equal(evaluateCondition("${steps.fetch.output.items}", scope), true);
  assert.equal(evaluateCondition("${input.missing}", scope), false);
});

test("comparison conditions work across types", () => {
  assert.equal(evaluateCondition("${steps.fetch.output.status} == 200", scope), true);
  assert.equal(evaluateCondition("${input.count} > 2", scope), true);
  assert.equal(evaluateCondition("${input.name} != \"other\"", scope), true);
  assert.equal(evaluateCondition("${input.count} < 1", scope), false);
});

test("paths never resolve through object prototypes", () => {
  const scope = { input: { a: 1 }, steps: {} };
  assert.equal(resolvePath("input.__proto__", scope), undefined);
  assert.equal(resolvePath("input.constructor", scope), undefined);
  assert.equal(resolvePath("input.a.toString", scope), undefined);
  assert.equal(interpolate("${input.constructor.name}", scope), undefined);
  assert.equal(resolvePath("input.a", scope), 1);
});
