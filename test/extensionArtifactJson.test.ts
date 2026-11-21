import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { MANAGED_SCHEMA_TEMPLATE } from "../src/templates/managedSchemaTemplate.js";
import { buildExtensionFiles, packageExtension } from "../src/packager.js";
import { getAppBuildConfig } from "../src/appPackager.js";
import { TEST_TMP_DIR } from "./helpers/setup.js";

/**
 * EXT-SCHEMA-ESCAPE-1: a single backslash inside a JSON string
 * ("DOMAIN\username") forms a "\u" unicode-escape prefix that makes the whole
 * manifest schema invalid — Edge rejects the package with "Invalid package",
 * blocking every fresh install/update of the extension. The artifact must
 * carry the VALID JSON escape "DOMAIN\\username" (two backslash characters).
 *
 * Guarantees enforced here:
 *  (1) every shipped/generated .json artifact parses strictly;
 *  (2) the packaged CRX zip contains parseable .json entries;
 *  (3) generated .xml artifacts carry no raw backslash escape sequences.
 */

function assertStrictJson(filePath: string, label: string): any {
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    assert.fail(`${label} must be strict-valid JSON: ${err?.message}`);
  }
}

test("ESCAPE-1 (RED anchor): extension/managed_schema.json parses strictly and carries a valid DOMAIN\\\\username escape", () => {
  const schemaPath = path.resolve("extension", "managed_schema.json");
  const schema = assertStrictJson(schemaPath, "extension/managed_schema.json (shipped artifact)");
  const description: string = schema.properties.domainUser.description;
  // In JS source this literal is two backslash characters — the VALID JSON escape.
  assert.ok(
    description.includes("DOMAIN\\\\username"),
    "domainUser description must carry the valid JSON escape DOMAIN\\\\username (two backslash chars)"
  );
  assert.ok(
    !description.includes("DOMAIN\\username") || description.includes("DOMAIN\\\\username"),
    "a single-backslash \\u sequence makes the JSON invalid"
  );

  // The template must produce the same content (sync contract)
  const fromTemplate = JSON.parse(MANAGED_SCHEMA_TEMPLATE);
  assert.equal(
    fromTemplate.properties.domainUser.description,
    description,
    "template render must equal the shipped artifact content"
  );
});

test("ESCAPE-1: generated build output .json artifacts parse strictly", async () => {
  const files = await buildExtensionFiles(getAppBuildConfig() as any);
  for (const [name, content] of Object.entries(files)) {
    if (name.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch (err: any) {
        assert.fail(`generated ${name} must be strict-valid JSON: ${err?.message}`);
      }
    }
  }
});

test("ESCAPE-1: .json entries inside the packaged CRX zip parse strictly", () => {
  const info = packageExtension("http://127.0.0.1:3000");
  const zip = new AdmZip(info.zipPath);
  const jsonEntries = zip.getEntries().filter((e) => e.entryName.endsWith(".json"));
  assert.ok(jsonEntries.length >= 2, `package must ship at least manifest+schema json entries, got ${jsonEntries.length}`);
  for (const entry of jsonEntries) {
    try {
      JSON.parse(entry.getData().toString("utf-8"));
    } catch (err: any) {
      assert.fail(`CRX zip entry ${entry.entryName} must be strict-valid JSON: ${err?.message}`);
    }
  }
});

test("ESCAPE-1 (audit d): generated updates.xml carries no raw backslash sequences", () => {
  // updates.xml shipped in dist (if present from a package run) is audited
  const updatesPath = path.resolve(process.env.PEC_UPDATES_DIR || "./dist/updates", "updates.xml");
  if (fs.existsSync(updatesPath)) {
    const updates = fs.readFileSync(updatesPath, "utf-8");
    assert.ok(!/[\\]u[0-9a-fA-F]{4}/.test(updates), "updates.xml must not contain raw unicode-escape sequences");
  }
});
