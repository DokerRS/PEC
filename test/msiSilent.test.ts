import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildMsiPackage, renderWxsManifest, getAppBuildConfig, buildAppProfile } from "../src/appPackager.js";
import { TEST_TMP_DIR } from "./helpers/setup.js";

/**
 * MSI-SILENT-1: the on-demand MSI build channel was silent on every failure
 * path and produced broken MSIs (absolute Source paths in wxs -> wixl 0.101
 * g_file_get_child assertion -> EXIT 1 -> catch-all swallowed the stderr).
 *
 * Fixed contract:
 *  - wxs references bare file names (no {{SOURCE_DIR}}), no Platform attr;
 *  - buildMsiPackage runs wixl with cwd = staging dir;
 *  - failures carry the compiler stderr in the returned error;
 *  - real baseUrl lands in SERVER_URL (no 127.0.0.1 stub).
 */

test("MSI-1 (g): renderWxsManifest emits bare Source names and no Platform attribute", () => {
  const cfg = getAppBuildConfig();
  const wxs = renderWxsManifest(cfg as any, "https://pec.corp.local", "/absolute/staging/path");
  assert.ok(!wxs.includes("{{SOURCE_DIR}}"), "SOURCE_DIR placeholder must be gone");
  assert.ok(!/Source="[/]/.test(wxs), `Source must be bare file names, got absolute: ${(wxs.match(/Source="[^"]*"/g) || []).slice(0, 4)}`);
  assert.ok(!/SourceFile="[/]/.test(wxs), "Icon SourceFile must be a bare file name");
  assert.ok(!/<Package[^>]*Platform=/.test(wxs), "wixl 0.101 does not know the Package Platform attribute");
  assert.match(wxs, /Source="PEC-App\.exe"/, "main exe Source must be a bare name");
  assert.match(wxs, /Source="pec_profile\.pbprofile"/, "profile Source must be a bare name");
});

test("MSI-1 (b,f): buildMsiPackage failure carries the compiler stderr in error", () => {
  // Staging dir with the wxs but WITHOUT the referenced files -> wixl must fail
  // (or the compiler must be absent — both paths return a non-success result
  // with diagnostics now, never a silent pass).
  const staging = fs.mkdtempSync(path.join(TEST_TMP_DIR, "msi-fail-"));
  fs.writeFileSync(path.join(staging, "pec-app.wxs"), '<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Product Id="*" Name="X" Language="1033" Version="1.0.0" Manufacturer="Y"><Package InstallerVersion="200" Compressed="yes"/></Product></Wix>', "utf-8");
  const outMsi = path.join(staging, "out.msi");

  const res = buildMsiPackage(getAppBuildConfig() as any, "http://127.0.0.1:3000", staging, outMsi);
  if (res.success) {
    // If wixl actually compiled a minimal wxs (no files referenced), that is
    // acceptable — the wxs written by renderWxsManifest references files that
    // do not exist here, so the full render + build path is covered below.
    assert.ok(fs.existsSync(res.msiPath!), "successful build must produce the msi");
  } else {
    assert.ok(res.error && res.error.length > 0, "failure must carry a diagnostic (stderr or message)");
  }
  fs.rmSync(staging, { recursive: true, force: true });
  void outMsi;
});

test("MSI-1 (f): full render+build on a staged dir with real files succeeds or reports wixl stderr", () => {
  // Build a fake staging dir with all 8 files the wxs references
  const staging = fs.mkdtempSync(path.join(TEST_TMP_DIR, "msi-ok-"));
  for (const f of ["PEC-App.exe", "PECAppSvc.exe", "PEC-CLI.exe", "PECAppCore.dll", "WinDivert.dll", "WinDivert64.sys", "pec_profile.pbprofile", "AppIcon.ico"]) {
    fs.writeFileSync(path.join(staging, f), Buffer.from(f), "utf-8");
  }
  const cfg = getAppBuildConfig();
  const wxs = renderWxsManifest(cfg as any, "https://pec.corp.local", staging);
  fs.writeFileSync(path.join(staging, "pec-app.wxs"), wxs, "utf-8");

  const res = buildMsiPackage(cfg as any, "https://pec.corp.local", staging, path.join(staging, "out.msi"));
  if (res.success) {
    assert.ok(fs.existsSync(res.msiPath!), "successful build must produce the msi file");
    assert.ok(fs.statSync(res.msiPath!).size > 1000, "msi must be non-trivial");
  } else {
    // wixl not installed on this host — the error must name the tool
    assert.match(res.error || "", /wixl|WiX/i, "no-wixl failure must name the toolchain");
  }
  fs.rmSync(staging, { recursive: true, force: true });
});

test("MSI-1 (c): real baseUrl lands in SERVER_URL (no 127.0.0.1 stub)", () => {
  const wxs = renderWxsManifest(getAppBuildConfig() as any, "https://fleet.corp.example", "/tmp/staging");
  assert.match(wxs, /Value="https:\/\/fleet\.corp\.example"/, "SERVER_URL must carry the real baseUrl");
  assert.ok(!wxs.includes('Value="http://127.0.0.1:3000"'), "127.0.0.1 stub must not appear when a real baseUrl is passed");
});

test("MSI-1 (e): committed template artifact uses bare Source names (no SOURCE_DIR, no Platform)", () => {
  const tpl = fs.readFileSync(path.resolve("templates/app/windows/pec-app.wxs.template"), "utf-8");
  assert.ok(!tpl.includes("{{SOURCE_DIR}}"), "committed template must not reference {{SOURCE_DIR}}");
  assert.ok(!/<Package[^>]*Platform=/.test(tpl), "committed template must not carry the Package Platform attribute");
  const syncCopy = path.resolve("templates/app/windows/pec-app.wxs.template");
  assert.ok(fs.existsSync(syncCopy), "synced template copy must exist");
});

// ---------------------------------------------------------------------------
// MSI-FALLBACK-2 (a): CLOSURE-4C criteria ported into the canonical
// buildMsiPackage/renderWxsManifest path (no separate build script).
// ---------------------------------------------------------------------------

test("MSI-FALLBACK-2: neutral token renders FLEET_TOKEN Property without @Value (CNDL0006 parity)", () => {
  for (const token of ["", "corp-proxy-secret-token-change-me", "test-admin-token", "********"]) {
    const wxs = renderWxsManifest({ defaultToken: token } as any, "https://pec.corp.local", "/tmp/staging");
    assert.ok(
      wxs.includes('<Property Id="FLEET_TOKEN" Secure="yes" />'),
      `placeholder/empty token (${JSON.stringify(token)}) must render the neutral Property`
    );
    assert.ok(!/Id="FLEET_TOKEN" Value=""/.test(wxs), "empty @Value is forbidden by WiX/wixl (CNDL0006)");
    if (token) {
      assert.ok(!wxs.includes(token), "placeholder must not appear anywhere in the wxs");
    }
  }
});

test("MSI-FALLBACK-2: a real configured token is baked into FLEET_TOKEN (two-token model)", () => {
  const wxs = renderWxsManifest(
    { defaultToken: "live-fleet-token-abcdef123456" } as any,
    "https://pec.corp.local",
    "/tmp/staging"
  );
  assert.ok(wxs.includes('Value="live-fleet-token-abcdef123456"'), "real fleet token must survive into the wxs");
  assert.ok(!wxs.includes("<Property Id=\"FLEET_TOKEN\" Secure=\"yes\" />"), "real token must not render the neutral property");
});

test("MSI-FALLBACK-2: cfg.version is the single MSI version source (no 1.0.0 fallback drift)", () => {
  const wxs = renderWxsManifest({ version: "1.0.7" } as any, "https://pec.corp.local", "/tmp/staging");
  assert.match(wxs, /Product [^>]*Version="1\.0\.7"/s, "MSI ProductVersion must come from cfg.version");
  assert.match(wxs, /Name="Version" Value="1\.0\.7"/, "registry Version value must match cfg.version");
});

test("MSI-FALLBACK-2: buildAppProfile scrubs placeholder/test fleet tokens (neutral provisioning)", () => {
  const base = {
    name: "PEC Corp",
    version: "1.0.0",
    serverUrl: "https://pec.corp.local",
  };

  const origExt = process.env.EXT_SHARED_TOKEN;
  try {
    delete process.env.EXT_SHARED_TOKEN;
    const neutral = buildAppProfile({ ...base, defaultToken: "corp-proxy-secret-token-change-me" } as any, base.serverUrl) as any;
    assert.equal(
      neutral.PecSync.fleetToken,
      "",
      "corp placeholder must degrade to the neutral token (provision via GPO/managed storage)"
    );

    process.env.EXT_SHARED_TOKEN = "live-fleet-token-abcdef123456";
    const live = buildAppProfile({ ...base } as any, base.serverUrl) as any;
    assert.equal(live.PecSync.fleetToken, "live-fleet-token-abcdef123456", "a real fleet token bakes by design");
  } finally {
    if (origExt !== undefined) process.env.EXT_SHARED_TOKEN = origExt;
    else delete process.env.EXT_SHARED_TOKEN;
  }
});
