import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { generateGpoConfig } from "../src/packager.js";
import { renderGpoReadme } from "../src/templates/gpoTemplates.js";

/**
 * EXT-PREF-DEPLOY-1: the generated deploy .REG must restore the browser's
 * own per-extension update channel (Extensions\<id>\updateurl) for Edge and
 * Chrome, plus WOW6432Node mirrors — a deleted/missing branch breaks
 * auto-update even when all policies are valid.
 *
 * Incident: 1.0.19 -> 1.0.20 — policies valid, extension not updating,
 * because the Extensions\<id> branch was deleted and the deploy did not
 * recreate it.
 */

const extId = "abcdefghijklmnopabcdefghijklmnop";
const serverUrl = "https://pec.corp.local";
const token = "test-corp-token-123";

const edgeBranch = "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Edge\\Extensions\\" + extId + "]";
const chromeBranch = "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Google\\Chrome\\Extensions\\" + extId + "]";
const wowEdgeBranch = "[HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Edge\\Extensions\\" + extId + "]";
const wowChromeBranch = "[HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\Extensions\\" + extId + "]";

test("EXT-PREF-DEPLOY-1: .reg restores Extensions\\<id>\\updateurl for Edge/Chrome + WOW6432Node mirrors", () => {
  const gpo = generateGpoConfig(extId, serverUrl, token, { targetGroup: "VIP-Users" });

  assert.ok(gpo.regContentUser.includes(edgeBranch), "Edge Extensions branch must be present");
  assert.ok(gpo.regContentUser.includes(chromeBranch), "Chrome Extensions branch must be present");
  assert.ok(gpo.regContentUser.includes(wowEdgeBranch), "WOW6432Node Edge mirror must be present");
  assert.ok(gpo.regContentUser.includes(wowChromeBranch), "WOW6432Node Chrome mirror must be present");

  assert.equal(
    (gpo.regContentUser.match(/"updateurl"=/g) || []).length,
    20,
    "5 browsers (incl. Chromium fallback) x 4 updateurl values (Edge/Chrome + 2 WOW6432Node mirrors)"
  );
  assert.ok(
    gpo.regContentUser.includes('"updateurl"="' + serverUrl + '/updates/updates.xml"'),
    "updateurl must point at the server updates.xml"
  );
  assert.ok(!/[\\]u[0-9a-fA-F]{4}/.test(gpo.regContentUser), "no raw unicode escapes in .reg");
});

test("EXT-PREF-DEPLOY-1: verify and remove cheat-sheet for the update channel is embedded in renderGpoReadme", () => {
  const readme = renderGpoReadme(extId, serverUrl);

  assert.match(
    readme,
    /reg query "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Microsoft\\\\Edge\\\\Extensions\\\\<ID>"/,
    "verify must include the Edge Extensions reg query"
  );
  assert.match(
    readme,
    /reg query "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Google\\\\Chrome\\\\Extensions\\\\<ID>"/,
    "verify must include the Chrome Extensions reg query"
  );
  assert.match(readme, /updateurl/, "verify must reference updateurl");

  assert.match(
    readme,
    /reg delete "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Microsoft\\\\Edge\\\\Extensions\\\\<ID>" \/f/,
    "remove must include the Edge Extensions cleanup"
  );
  assert.match(
    readme,
    /reg delete "HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\Google\\\\Chrome\\\\Extensions\\\\<ID>" \/f/,
    "remove must include the Chrome Extensions cleanup"
  );
});
