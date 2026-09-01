import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig, validateConfig } from "../config.js";
import { ConfigurationError } from "../errors.js";

test("default configuration is valid", () => {
  const config = validateConfig(defaultConfig());
  assert.equal(config.version, 1);
  assert.equal(config.team.master.provider, "ollama");
});

test("configuration rejects agents referencing missing providers", () => {
  const config = defaultConfig();
  config.team.master.provider = "missing";
  assert.throws(() => validateConfig(config), ConfigurationError);
});

test("configuration rejects duplicate agent names", () => {
  const config = defaultConfig();
  config.team.workers.push({
    name: config.team.master.name,
    description: "duplicate",
    provider: "ollama",
    model: "test",
  });
  assert.throws(() => validateConfig(config), /duplicated/);
});
