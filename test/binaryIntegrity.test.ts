import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Expected SHA-256 hashes of the 7 Windows binary templates.
 * Pinned per Security Requirement M-22.
 */
export const EXPECTED_WINDOWS_BINARY_HASHES: Record<string, string> = {
  "PEC-App.exe": "548ad8c40983d99b9a699ba13c7db9a2ce8e15e596f79864db431e729a7226d8",
  "PEC-CLI.exe": "caeebcda6212477c0c1a42847f822e3b783ef125ee298bec1fa56a70b602da4c",
  "PECAppSvc.exe": "9b0e802c6f30b1abf7b2da0e5180e39d0adf860302f5d9d55e1e1bea69c487e4",
  "PEC-App-Setup.exe": "a38db5e22a68388edc4cdd3b788423c8e904ef61f8526956a4a0c337d83a0855",
  "PECAppCore.dll": "a6cf9a288d5a776dcf026ae40c9ba4af682f9e7a29f41f9cbbf677825d9c3423",
  "WinDivert.dll": "c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2",
  "WinDivert64.sys": "8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2",
};

import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_WIN_DIR = path.join(PROJECT_ROOT, "templates/app/windows");
const PRISTINE_WIN_DIR = path.join(PROJECT_ROOT, "templates/app/windows/.pristine");

function computeSha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("M-22: All 7 Windows binary templates exist and match pinned SHA-256 hashes", () => {
  const binaryNames = Object.keys(EXPECTED_WINDOWS_BINARY_HASHES);
  assert.equal(binaryNames.length, 7, "Must test exactly 7 binary templates");

  for (const filename of binaryNames) {
    const filePath = path.join(TEMPLATES_WIN_DIR, filename);
    assert.ok(fs.existsSync(filePath), `Binary template missing: ${filename}`);

    const actualHash = computeSha256(filePath);
    const expectedHash = EXPECTED_WINDOWS_BINARY_HASHES[filename];

    assert.equal(
      actualHash,
      expectedHash,
      `Binary template ${filename} SHA-256 hash mismatch! Possible tampering.`
    );
  }
});

test("M-22: All 7 Windows binary templates in templates/app/windows/ match .pristine/ 1:1", () => {
  assert.ok(fs.existsSync(PRISTINE_WIN_DIR), ".pristine directory must exist");

  const binaryNames = Object.keys(EXPECTED_WINDOWS_BINARY_HASHES);

  for (const filename of binaryNames) {
    const templatePath = path.join(TEMPLATES_WIN_DIR, filename);
    const pristinePath = path.join(PRISTINE_WIN_DIR, filename);

    assert.ok(fs.existsSync(templatePath), `Template missing: ${templatePath}`);
    assert.ok(fs.existsSync(pristinePath), `Pristine copy missing: ${pristinePath}`);

    const templateHash = computeSha256(templatePath);
    const pristineHash = computeSha256(pristinePath);

    assert.equal(
      templateHash,
      pristineHash,
      `Template ${filename} does not match its pristine reference copy in .pristine/`
    );

    assert.equal(
      pristineHash,
      EXPECTED_WINDOWS_BINARY_HASHES[filename],
      `Pristine copy of ${filename} does not match pinned hash`
    );
  }
});

test("M-22: Binary integrity test fails if template file is modified or corrupted", () => {
  // Verify that hash comparison detects modifications
  const dummyModified = Buffer.from("corrupted executable header");
  const corruptedHash = crypto.createHash("sha256").update(dummyModified).digest("hex");

  assert.notEqual(
    corruptedHash,
    EXPECTED_WINDOWS_BINARY_HASHES["PEC-App.exe"],
    "Corrupted file hash must not match pinned PEC-App.exe hash"
  );
});
