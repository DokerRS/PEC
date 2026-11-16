import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  extractCertificateMetadata,
  signBinary,
  saveCertificate,
  deleteCertificate,
  buildSigntoolCertStoreArgs,
  buildPfxImportScript,
} from "../src/codeSigner.js";

test("codeSigner: extractCertificateMetadata uses execFileSync with safe env and array args", (t) => {
  const originalExecFileSync = child_process.execFileSync;
  const calls: Array<{ file: string; args?: readonly string[]; options?: any }> = [];

  child_process.execFileSync = ((file: string, args?: readonly string[], options?: any) => {
    calls.push({ file, args, options });
    if (file === "openssl") {
      // simulate openssl failure or success
      return Buffer.from("fake openssl output");
    }
    return Buffer.from("");
  }) as any;

  t.after(() => {
    child_process.execFileSync = originalExecFileSync;
  });

  const dummyPfx = crypto.randomBytes(64);
  const maliciousPassword = 'malicious"$(whoami)&calc.exe|dir;test\'';

  // Call extractCertificateMetadata
  extractCertificateMetadata(dummyPfx, maliciousPassword);

  const opensslCall = calls.find((c) => c.file === "openssl");
  if (opensslCall) {
    assert.ok(Array.isArray(opensslCall.args), "openssl must be called with array args");
    assert.ok(opensslCall.args.includes("-passin"), "must use -passin arg");
    assert.ok(opensslCall.args.includes("env:PFX_PASS"), "must use env:PFX_PASS for password");
    assert.equal(
      opensslCall.options?.env?.PFX_PASS,
      maliciousPassword,
      "raw password must be passed in env.PFX_PASS without shell interpolation"
    );
  }
});

test("codeSigner: signBinary invokes tools via execFileSync with discrete array arguments", (t) => {
  const originalExecFileSync = child_process.execFileSync;
  const calls: Array<{ file: string; args?: readonly string[]; options?: any }> = [];

  child_process.execFileSync = ((file: string, args?: readonly string[], options?: any) => {
    calls.push({ file, args, options });
    if (args && args.includes("--version")) {
      return Buffer.from("osslsigncode 2.5");
    }
    if (file === "osslsigncode" && args && args[0] === "sign") {
      const outIdx = args.indexOf("-out");
      if (outIdx !== -1 && args[outIdx + 1]) {
        fs.writeFileSync(args[outIdx + 1], "dummy signed data");
      }
      return Buffer.from("signed");
    }
    return Buffer.from("");
  }) as any;

  t.after(() => {
    child_process.execFileSync = originalExecFileSync;
    deleteCertificate();
  });

  const tmpDir = path.resolve("./data/certs");
  fs.mkdirSync(tmpDir, { recursive: true });
  const dummyTarget = path.join(tmpDir, `test_target_${Date.now()}.exe`);
  fs.writeFileSync(dummyTarget, "dummy executable data");

  try {
    const maliciousPassword = 'pass"&calc.exe|dir;$(id)';
    const dummyPfx = crypto.randomBytes(128);
    saveCertificate(dummyPfx, maliciousPassword, "commercial", "http://timestamp.digicert.com");

    const signed = signBinary(dummyTarget);
    assert.equal(signed, true, "signBinary should succeed when osslsigncode mock succeeds");

    const signCall = calls.find((c) => c.file === "osslsigncode" && c.args?.[0] === "sign");
    assert.ok(signCall, "osslsigncode sign must be called");
    assert.ok(Array.isArray(signCall.args), "args must be an array");

    // Check that maliciousPassword is NOT passed as a CLI argument (M-7 security hardening)
    assert.ok(!signCall.args.includes(maliciousPassword), "raw password must NOT be passed in CLI arguments");
    assert.equal(signCall.args.indexOf("-pass"), -1, "-pass flag must not be used to avoid process table leakage");
    assert.ok(signCall.args.includes("-readpass"), "-readpass flag must be used with temporary file");
    assert.equal(
      signCall.options?.env?.PFX_PASS,
      maliciousPassword,
      "password must be safely passed via environment or secure temporary file"
    );
  } finally {
    if (fs.existsSync(dummyTarget)) fs.unlinkSync(dummyTarget);
    deleteCertificate();
  }
});

test("SEC-3: buildSigntoolCertStoreArgs signs by thumbprint and never carries a password slot", () => {
  const args = buildSigntoolCertStoreArgs("AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12", "http://timestamp.digicert.com", "C:\out\PEC-App.exe");
  assert.deepEqual(args, [
    "sign",
    "/sha1",
    "AB12CD34EF56AB12CD34EF56AB12CD34EF56AB12",
    "/fd",
    "sha256",
    "/tr",
    "http://timestamp.digicert.com",
    "/td",
    "sha256",
    "C:\out\PEC-App.exe",
  ]);
  assert.equal(args.indexOf("/p"), -1, "argv must never contain the /p password flag (AUDIT-SEC-3)");
  assert.equal(args.indexOf("/f"), -1, "argv must not reference the PFX file - signing goes through the cert store");

  const noTs = buildSigntoolCertStoreArgs("AB12", "", "bin.exe");
  assert.ok(!noTs.includes("/tr") && !noTs.includes("/td"), "no timestamp URL - no timestamp flags");
});

test("SEC-3: buildPfxImportScript takes no password and resists PowerShell injection", () => {
  const hostileThumbprint = "'; Remove-Item C:\ -Recurse; '";
  const script = buildPfxImportScript("C:\certs\my 'quotes'.pfx", hostileThumbprint);
  assert.ok(!script.includes("Remove-Item"), "hostile thumbprint content must be stripped");
  assert.ok(script.includes("$env:PFX_PASS"), "password reaches PowerShell only via environment");
  assert.ok(script.includes("Import-PfxCertificate"), "script imports the PFX into the user store");
  assert.ok(script.includes("my ''quotes''.pfx"), "PFX path single quotes are escaped");
});

test("SEC-3: signtool branch signs via cert store without the PFX password in argv", (t) => {
  if (process.platform !== "win32") {
    return; // signtool branch is only reachable on Windows
  }
  const originalExecFileSync = child_process.execFileSync;
  const calls: Array<{ file: string; args?: readonly string[]; options?: any }> = [];

  child_process.execFileSync = ((file: string, args?: readonly string[], options?: any) => {
    calls.push({ file, args, options });
    if (file === "osslsigncode" && args?.includes("--version")) {
      throw new Error("not installed");
    }
    if (file === "signtool.exe" && args?.includes("/?")) {
      return Buffer.from("signtool mock");
    }
    if (file === "powershell") {
      return Buffer.from("");
    }
    if (file === "signtool.exe" && args?.[0] === "sign") {
      return Buffer.from("done");
    }
    return Buffer.from("");
  }) as any;

  t.after(() => {
    child_process.execFileSync = originalExecFileSync;
    deleteCertificate();
  });

  const tmpDir = path.resolve("./data/certs");
  fs.mkdirSync(tmpDir, { recursive: true });
  const dummyTarget = path.join(tmpDir, `test_target_signtool_${Date.now()}.exe`);
  fs.writeFileSync(dummyTarget, "dummy executable data");

  try {
    const maliciousPassword = 'pass"&calc.exe|dir;$(id)';
    const dummyPfx = crypto.randomBytes(128);
    saveCertificate(dummyPfx, maliciousPassword, "commercial", "http://timestamp.digicert.com");

    const signed = signBinary(dummyTarget);
    assert.equal(signed, true, "signtool path must succeed with mocks");

    const signCall = calls.find((c) => c.file === "signtool.exe" && c.args?.[0] === "sign");
    assert.ok(signCall, "signtool sign must be called");
    assert.ok(signCall.args!.includes("/sha1"), "must address the certificate by /sha1 thumbprint");
    assert.equal(signCall.args!.indexOf("/p"), -1, "argv must never contain the /p password flag (AUDIT-SEC-3)");
    assert.equal(signCall.args!.indexOf("/f"), -1, "argv must not pass the PFX file");
    for (const a of signCall.args!) {
      assert.ok(!String(a).includes(maliciousPassword), "no argv element may contain the raw password");
    }

    const psCall = calls.find((c) => c.file === "powershell");
    assert.ok(psCall, "cert-store import via PowerShell must run");
    for (const a of psCall.args!) {
      assert.ok(!String(a).includes(maliciousPassword), "PowerShell argv must not contain the raw password");
    }
    assert.equal(psCall.options?.env?.PFX_PASS, maliciousPassword, "password reaches import only through env");
  } finally {
    if (fs.existsSync(dummyTarget)) fs.unlinkSync(dummyTarget);
    deleteCertificate();
  }
});
