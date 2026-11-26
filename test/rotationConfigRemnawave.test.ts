import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { preservePasswordOnConfigUpdate } from "../src/routes/rotationRoutes.js";
import { getRotationConfig, updateRotationConfig } from "../src/scheduler.js";

test("rotation config stores and returns the Remnawave target username", () => {
  updateRotationConfig({ targetUsername: "pec-user", enabled: false });
  assert.equal(getRotationConfig().targetUsername, "pec-user");
});

test("preservePasswordOnConfigUpdate preserves existing rotAdminPass when submitted empty or undefined", () => {
  const currentConfig = {
    panelUrl: "https://remnawave.corp:3000",
    adminUser: "admin",
    adminPass: "stored-secret-password-123",
    rotAdminPass: "stored-secret-password-123",
  };

  // Case 1: Empty string rotAdminPass should preserve current password
  const res1 = preservePasswordOnConfigUpdate({ rotAdminPass: "" }, currentConfig);
  assert.equal(res1.adminPass, "stored-secret-password-123");
  assert.equal(res1.rotAdminPass, "stored-secret-password-123");

  // Case 2: Undefined rotAdminPass should preserve current password
  const res2 = preservePasswordOnConfigUpdate({ rotAdminPass: undefined }, currentConfig);
  assert.equal(res2.adminPass, "stored-secret-password-123");
  assert.equal(res2.rotAdminPass, "stored-secret-password-123");

  // Case 3: Empty string adminPass should also preserve current password
  const res3 = preservePasswordOnConfigUpdate({ adminPass: "" }, currentConfig);
  assert.equal(res3.adminPass, "stored-secret-password-123");

  // Case 4: Non-empty new password updates the password
  const res4 = preservePasswordOnConfigUpdate({ rotAdminPass: "brand-new-pass-456" }, currentConfig);
  assert.equal(res4.adminPass, "brand-new-pass-456");
  assert.equal(res4.rotAdminPass, "brand-new-pass-456");
});
