import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { generateGpoConfig } from "../src/packager.js";

test("GPO deployment architecture: pure Windows .REG policies without GPP XML", () => {
  const extId = "abcdefghijklmnopabcdefghijklmnop";
  const serverUrl = "https://pec.corp.local:3000";
  const token = "corp-shared-token-12345";

  const gpo = generateGpoConfig(extId, serverUrl, token);

  // Pure .REG format headers
  assert.ok(gpo.regContentUser.startsWith("Windows Registry Editor Version 5.00"));
  assert.ok(gpo.regContentMachine.startsWith("Windows Registry Editor Version 5.00"));

  // Ensure no GPP XML or legacy script properties exist in GpoConfig
  assert.equal((gpo as any).registryXml, undefined);
  assert.equal((gpo as any).deployScript, undefined);
  assert.equal((gpo as any).verifyScript, undefined);
});
