"use strict";

const { optionalText, taskError } = require("./runtime.js");
const MAX_CANDIDATES = 8;

function catalog(rows) {
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.key !== "string" || !row.key.trim() ||
        typeof row.providerId !== "string" || !row.providerId.trim() ||
        typeof row.modelId !== "string" || !row.modelId.trim() ||
        row.key !== `${row.providerId}/${row.modelId}`) continue;
    unique.set(row.key, {
      key: row.key,
      providerId: row.providerId,
      providerName: String(row.providerName || row.providerId),
      modelId: row.modelId,
      label: String(row.label || row.modelId),
      ...(typeof row.alias === "string" && row.alias.trim() ? { alias: row.alias.trim() } : {}),
      availableForSubagents: row.availableForSubagents === true,
      isDefault: row.isDefault === true,
      supportsReasoning: row.supportsReasoning === true,
      thinkingLevels: Array.isArray(row.thinkingLevels) ? row.thinkingLevels.filter((level) => typeof level === "string") : [],
    });
  }
  return [...unique.values()];
}

function folded(value) {
  return String(value).normalize("NFKC").trim().toLowerCase();
}

function familyName(value) {
  return folded(value)
    .replace(/克劳德/g, "claude")
    .replace(/十四行诗/g, "sonnet")
    .replace(/奥普斯/g, "opus")
    .replace(/双子座/g, "gemini")
    .replace(/通义千问|千问/g, "qwen")
    .replace(/深度求索/g, "deepseek")
    .replace(/智谱/g, "glm");
}

function compact(value) {
  return familyName(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function names(model) {
  return [model.key, model.modelId, model.alias, model.label,
    `${model.providerName} ${model.modelId}`, `${model.providerName} ${model.alias || ""}`]
    .filter(Boolean);
}

function candidates(models) {
  return models.slice(0, MAX_CANDIDATES).map((model) => ({
    key: model.key,
    label: model.alias || model.label,
    availableForSubagents: model.availableForSubagents,
    isDefault: model.isDefault,
    supportsReasoning: model.supportsReasoning,
  }));
}

function uniqueMatch(matches, query) {
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const options = candidates(matches);
    throw taskError("MODEL_AMBIGUOUS",
      `Model request "${query}" matches several configured models. Use an exact key: ${options.map((row) => row.key).join(", ")}`,
      { candidates: options });
  }
  return undefined;
}

function capabilityQuery(value) {
  let query = familyName(value);
  let supportsReasoning;
  const without = /non[- ]reasoning|without (?:reasoning|thinking)|no (?:reasoning|thinking)|不(?:需要|用|需|要)?(?:思考|推理)|无(?:思考|推理)|非推理|关闭思考/g;
  const withReasoning = /(?:deep )?reasoning|thinking|深度思考|推理|思考/g;
  if (without.test(query)) {
    supportsReasoning = false;
    query = query.replace(without, " ");
  } else if (withReasoning.test(query)) {
    supportsReasoning = true;
    query = query.replace(withReasoning, " ");
  }
  if (supportsReasoning !== undefined) {
    query = query.replace(/\b(?:a|an|the|use|for|with|capable|model|models)\b|适合|用于|使用|模型|能够|可以|的/gu, " ").trim();
  }
  return { query, supportsReasoning };
}

function lexicalMatch(model, query) {
  const wanted = familyName(query);
  const tokens = wanted.match(/[\p{L}]+|[\p{N}]+/gu) || [];
  const numbers = wanted.match(/[\p{N}]+/gu) || [];
  return names(model).some((name) => {
    const normalized = familyName(name);
    const numeric = normalized.match(/[\p{N}]+/gu) || [];
    // Preserve version order: a request for 5.4 must not resolve to 4.5.
    if (numbers.length && !(`.${numeric.join(".")}.`).includes(`.${numbers.join(".")}.`)) return false;
    if (compact(normalized).includes(compact(wanted))) return true;
    const available = normalized.match(/[\p{L}]+|[\p{N}]+/gu) || [];
    return tokens.length > 0 && tokens.every((token) => available.includes(token));
  });
}

function selectModel(rows, input) {
  const models = catalog(rows);
  const query = optionalText(input, "model", 512);
  if (!models.length) throw taskError("MODEL_NOT_CONFIGURED", "No ready configured models are available");
  if (!query) {
    const eligible = models.filter((model) => model.availableForSubagents);
    const pool = eligible.length ? eligible : models.filter((model) => model.isDefault);
    if (!pool.length) {
      throw taskError("MODEL_NOT_CONFIGURED", "No model is enabled for AI delegation and no ready default model is configured");
    }
    return {
      model: pool.find((model) => model.isDefault) || pool[0],
      selection: eligible.length ? "delegation" : "default",
    };
  }

  if (!compact(query)) throw taskError("MODEL_NOT_FOUND", "Model request must contain a configured name or capability");
  const key = models.find((model) => model.key === query);
  if (key) return { model: key, selection: "explicit" };
  const exact = uniqueMatch(models.filter((model) => names(model).some((name) => folded(name) === folded(query))), query);
  if (exact) return { model: exact, selection: "explicit" };
  const normalized = uniqueMatch(models.filter((model) => names(model).some((name) => compact(name) === compact(query))), query);
  if (normalized) return { model: normalized, selection: "explicit" };

  const intent = capabilityQuery(query);
  const matches = models.filter((model) =>
    (intent.supportsReasoning === undefined || model.supportsReasoning === intent.supportsReasoning) &&
    (!intent.query || lexicalMatch(model, intent.query)));
  const selected = uniqueMatch(matches, query);
  if (selected) return { model: selected, selection: "explicit" };
  const options = candidates(models);
  throw taskError("MODEL_NOT_FOUND",
    `No configured model matches "${query}". Call models or use an exact key: ${options.map((row) => row.key).join(", ")}`,
    { candidates: options });
}

module.exports = { catalog, selectModel };
