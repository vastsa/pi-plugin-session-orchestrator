import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "./session-orchestrator.harness.mjs";

/**
 * Host contract for plugin skills (ADR 0039, PI-Desktop docs §6.2): a skill is
 * one Markdown file declared in `contributes.skills`, a plugin may teach 32 of
 * them, a file may be 128 KiB, and only `name` + `description` reach the model
 * up front — the description is capped at 240 characters and is the entire
 * triggering surface, so it must read as a "when to use" sentence.
 */
const MAX_SKILLS = 32;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_DESCRIPTION_CHARS = 240;
const MAX_NAME_CHARS = 60;

const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
const declared = manifest.contributes.skills;

function frontmatter(raw) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { fields: {}, body: raw.trim() };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (value) fields[key] = value;
  }
  return { fields, body: raw.slice(match[0].length).trim() };
}

function skillId(path) {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Resolve a declared path inside the plugin, refusing traversal like the host does. */
function locate(path) {
  assert.match(path, /^\.?\/?[\w.-]+(\/[\w.-]+)*\.md$/, `contributes.skills path is not plugin-local: ${path}`);
  assert.equal(path.includes(".."), false, `contributes.skills path escapes the plugin: ${path}`);
  return join(pluginRoot, path);
}

test("the skill catalog stays inside the host's declared limits", () => {
  assert.ok(Array.isArray(declared) && declared.length > 0, "contributes.skills must declare at least one skill");
  assert.ok(declared.length <= MAX_SKILLS, `at most ${MAX_SKILLS} skills per plugin`);
  const ids = declared.map(skillId);
  assert.equal(new Set(ids).size, ids.length, `skill ids must be unique: ${ids.join(", ")}`);
});

test("every declared skill is a bounded document with a triggering description", () => {
  for (const path of declared) {
    const file = locate(path);
    const size = statSync(file).size;
    assert.ok(size > 0 && size <= MAX_SKILL_BYTES, `${path} is ${size} bytes; the host allows ${MAX_SKILL_BYTES}`);
    const { fields, body } = frontmatter(readFileSync(file, "utf8"));
    assert.ok(fields.name, `${path} needs a name in its front matter`);
    assert.ok(fields.name.length <= MAX_NAME_CHARS, `${path} name is ${fields.name.length} chars, cap is ${MAX_NAME_CHARS}`);
    assert.ok(fields.description, `${path} needs a description; it is the only triggering surface`);
    assert.ok(
      fields.description.length <= MAX_DESCRIPTION_CHARS,
      `${path} description is ${fields.description.length} chars, cap is ${MAX_DESCRIPTION_CHARS}`,
    );
    // The description carries "when to use". A body starting with a bare noun
    // phrase does not tell the model when it applies.
    assert.match(fields.description, /^Use (when|inside|in|after|before)\b/, `${path} description must start with when to use it`);
    assert.ok(body.split(/\r?\n/).length >= 10, `${path} body is too thin to guide a session`);
    assert.match(body, /^## /m, `${path} body needs at least one section heading`);
    assert.equal(/\b(?:TODO|TBD|FIXME)\b/.test(body), false, `${path} still carries a placeholder`);
  }
});

test("no skill file is shipped without being declared", () => {
  const onDisk = readdirSync(join(pluginRoot, "skills"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => skillId(`skills/${name}`))
    .sort();
  const catalogued = declared.map(skillId).sort();
  assert.deepEqual(onDisk, catalogued, "a file in skills/ is invisible to the model unless the manifest declares it");
});

test("a skill may only reference another skill that this plugin really ships", () => {
  const shipped = new Set(declared.map((path) => `pi.session-orchestrator/${skillId(path)}`));
  const external = /`(pi\.[\w.-]+\/[\w.-]+)`/g;
  for (const path of declared) {
    const body = readFileSync(locate(path), "utf8");
    for (const [, id] of body.matchAll(external)) {
      if (id.startsWith("pi.session-orchestrator/")) {
        assert.ok(shipped.has(id), `${path} points at ${id}, which the manifest does not declare`);
      }
    }
  }
});
