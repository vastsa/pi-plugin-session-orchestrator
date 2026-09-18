import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { model, pluginRoot } from "./session-orchestrator.harness.mjs";

const require = createRequire(import.meta.url);
const { catalog, selectModel } = require(join(pluginRoot, "models.js"));
const fails = (code) => (error) => error.code === code;

test("automatic selection only uses explicitly enabled delegation bindings before the default", () => {
  const rows = [model("default/general", { isDefault: true }), model("allowed/sonnet", { availableForSubagents: true })];
  assert.equal(selectModel(rows).model.key, "allowed/sonnet");
  assert.equal(selectModel(rows).selection, "delegation");
  assert.equal(selectModel([rows[0]]).selection, "default");
  assert.equal(selectModel([rows[0]]).model.key, "default/general");
  assert.throws(() => selectModel([model("plain/model")]), fails("MODEL_NOT_CONFIGURED"));
  assert.throws(() => selectModel([]), fails("MODEL_NOT_CONFIGURED"));
});

test("an eligible default wins without vendor ranking or parent-model inheritance", () => {
  const rows = [model("first/model", { availableForSubagents: true }),
    model("default/model", { availableForSubagents: true, isDefault: true })];
  assert.equal(selectModel(rows).model.key, "default/model");
  rows[1].isDefault = false;
  assert.equal(selectModel(rows).model.key, "first/model");
});

test("exact keys and personal aliases resolve real models even outside the automatic pool", () => {
  const rows = [model("one/claude-sonnet-4-6", { alias: "Careful reviewer" }), model("two/gpt-5.4", { availableForSubagents: true })];
  assert.equal(selectModel(rows, "one/claude-sonnet-4-6").model.key, rows[0].key);
  assert.equal(selectModel(rows, "careful REVIEWER").model.key, rows[0].key);
  assert.equal(selectModel(rows, "Claude Sonnet 4.6").model.key, rows[0].key);
  assert.equal(selectModel(rows, "ＧＰＴ ５．４").model.key, rows[1].key);
});

test("family aliases match configured names and preserve numeric model version order", () => {
  const rows = [model("anthropic/claude-sonnet-4-6", { providerName: "Anthropic" }),
    model("anthropic/claude-opus-4-6"), model("openai/gpt-4.5"), model("openai/gpt-5.4")];
  assert.equal(selectModel(rows, "十四行诗 4.6").model.key, rows[0].key);
  assert.equal(selectModel(rows, "克劳德 奥普斯").model.key, rows[1].key);
  assert.equal(selectModel(rows, "Anthropic Sonnet").model.key, rows[0].key);
  assert.equal(selectModel(rows, "GPT 5.4").model.key, rows[3].key);
  assert.throws(() => selectModel([rows[2]], "GPT 5.4"), fails("MODEL_NOT_FOUND"));
});

test("English and Chinese reasoning intent use host capability metadata", () => {
  const rows = [model("one/reasoner", { supportsReasoning: true }), model("two/plain")];
  assert.equal(selectModel(rows, "reasoning model").model.key, rows[0].key);
  assert.equal(selectModel(rows, "适合推理的模型").model.key, rows[0].key);
  assert.equal(selectModel(rows, "without thinking").model.key, rows[1].key);
  assert.equal(selectModel(rows, "不需要推理的模型").model.key, rows[1].key);
  assert.throws(() => selectModel([rows[1]], "reasoning model"), fails("MODEL_NOT_FOUND"));
});

test("ambiguous aliases, families and same-model providers require an exact key", () => {
  const rows = [model("one/claude-sonnet-4-6", { alias: "Review", supportsReasoning: true }),
    model("two/claude-sonnet-4-6", { alias: "Review", supportsReasoning: true })];
  for (const query of ["Review", "sonnet", "claude-sonnet-4-6", "推理模型"]) {
    assert.throws(() => selectModel(rows, query), (error) => {
      assert.equal(error.code, "MODEL_AMBIGUOUS");
      assert.deepEqual(error.details.candidates.map((entry) => entry.key), rows.map((entry) => entry.key));
      return true;
    });
  }
  assert.equal(selectModel(rows, rows[1].key).model.key, rows[1].key);
});

test("unsupported quality or cost requests do not fabricate capability or silently choose a default", () => {
  const rows = [model("one/general", { isDefault: true })];
  for (const query of ["best cheapest model", "fastest", "missing-provider/missing-model", "***"]) {
    assert.throws(() => selectModel(rows, query), fails("MODEL_NOT_FOUND"));
  }
});

test("candidate errors are bounded and malformed flags are never opt-in", () => {
  const rows = Array.from({ length: 12 }, (_, index) => model(`provider-${index}/shared`, { alias: "review" }));
  assert.throws(() => selectModel(rows, "review"), (error) => error.details.candidates.length === 8);
  const result = catalog([null, {}, model("one/model", { availableForSubagents: "true", isDefault: 1 }), model("one/model")]);
  assert.equal(result.length, 1);
  assert.equal(result[0].availableForSubagents, false);
  assert.equal(result[0].isDefault, false);
});
