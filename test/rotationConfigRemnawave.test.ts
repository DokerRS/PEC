import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { getRotationConfig, updateRotationConfig } from "../src/scheduler.js";

test("rotation config stores and returns the Remnawave target username", () => {
  updateRotationConfig({ targetUsername: "pec-user", enabled: false });
  assert.equal(getRotationConfig().targetUsername, "pec-user");
});
