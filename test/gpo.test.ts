import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { generateGpoConfig, buildGpoPackage } from "../src/packager.js";

test("generateGpoConfig generates multi-browser policies for HKCU and HKLM", () => {
  const extId = "abcdefghijklmnopabcdefghijklmnop";
  const serverUrl = "https://pec.corp.local";
  const token = "test-corp-token-123";

  const gpo = generateGpoConfig(extId, serverUrl, token, {
    targetGroup: "VIP-Users",
    autoConfigureProxy: true,
  });

  // Verify HKCU content
  assert.ok(gpo.regContentUser.includes("HKEY_CURRENT_USER\\Software\\Policies\\Google\\Chrome"), "Chrome HKCU must be included");
  assert.ok(gpo.regContentUser.includes("HKEY_CURRENT_USER\\Software\\Policies\\Microsoft\\Edge"), "Edge HKCU must be included");
  assert.ok(gpo.regContentUser.includes("HKEY_CURRENT_USER\\Software\\Policies\\YandexBrowser"), "YandexBrowser HKCU must be included");
  assert.ok(gpo.regContentUser.includes("HKEY_CURRENT_USER\\Software\\Policies\\Opera Software\\Opera"), "Opera HKCU must be included");
  assert.ok(gpo.regContentUser.includes("HKEY_CURRENT_USER\\Software\\Policies\\Chromium"), "Chromium HKCU fallback must be included");

  // Verify HKLM content
  assert.ok(gpo.regContentMachine.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome"), "Chrome HKLM must be included");
  assert.ok(gpo.regContentMachine.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge"), "Edge HKLM must be included");
  assert.ok(gpo.regContentMachine.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\YandexBrowser"), "YandexBrowser HKLM must be included");
  assert.ok(gpo.regContentMachine.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Opera Software\\Opera"), "Opera HKLM must be included");
  assert.ok(gpo.regContentMachine.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Chromium"), "Chromium HKLM fallback must be included");

  // Verify managed storage keys
  assert.ok(gpo.regContentUser.includes('"extToken"="test-corp-token-123"'), "extToken must be present in HKCU");
  assert.ok(gpo.regContentUser.includes('"targetGroup"="VIP-Users"'), "targetGroup must be present in HKCU");
  assert.ok(gpo.regContentUser.includes('"autoConfigureProxy"=dword:00000001'), "autoConfigureProxy must be dword in HKCU");

  // EXT-GPO-ALLOWLIST-1: allowlist entry with the default index; NO forcelist
  assert.ok(gpo.allowlistEntry.includes(extId), "allowlist must carry the extension id");
  assert.equal(gpo.allowlistIndex, 100, "default index must be 100");
  assert.ok(gpo.installSourcesEntry.includes("/*"), "install sources must carry the star wildcard");
  assert.ok(!gpo.regContentUser.includes("ExtensionInstallForcelist"), "forcelist must be dropped from the .reg output");
  for (const browser of ["Google" + String.fromCharCode(92) + "Chrome", "Microsoft" + String.fromCharCode(92) + "Edge", "YandexBrowser", "Opera Software" + String.fromCharCode(92) + "Opera"]) {
    assert.ok(gpo.regContentUser.includes(browser), browser + " must appear in the .reg output");
  }
  assert.ok(gpo.regContentUser.includes('"100"='), "indexed Allowlist value names must be present");

  // Verify ExtensionSettings JSON
  assert.ok(gpo.extensionSettingsJson[extId]);
  assert.equal(gpo.extensionSettingsJson[extId].installation_mode, "force_installed");

  // Verify browser-specific ExtensionSettings entries
  assert.ok((gpo as any).extensionSettingsEntries, "extensionSettingsEntries must exist");
  assert.equal((gpo as any).extensionSettingsEntries.chrome[extId].installation_mode, "force_installed");
  assert.equal((gpo as any).extensionSettingsEntries.chrome[extId].override_update_url, true);
  assert.ok((gpo as any).extensionSettingsEntries.chrome["*"].install_sources.includes(`${serverUrl}/*`));

  assert.equal((gpo as any).extensionSettingsEntries.edge[extId].installation_mode, "force_installed");
  assert.equal((gpo as any).extensionSettingsEntries.edge[extId].override_update_url, true);
  assert.ok((gpo as any).extensionSettingsEntries.edge["*"].install_sources.includes(`${serverUrl}/*`));

  // Critical: Yandex Browser unmanaged must be normal_installed
  assert.equal((gpo as any).extensionSettingsEntries.yandex[extId].installation_mode, "normal_installed");
  assert.equal((gpo as any).extensionSettingsEntries.yandex[extId].override_update_url, true);
  assert.ok((gpo as any).extensionSettingsEntries.yandex["*"].install_sources.includes(`${serverUrl}/*`));

  // Verify ExtensionSettings REG_SZ in .reg files
  assert.ok(gpo.regContentUser.includes('"ExtensionSettings"='), "ExtensionSettings must be defined in HKCU .reg");
  assert.ok(gpo.regContentUser.includes('normal_installed'), "Yandex normal_installed must be in HKCU .reg");
  assert.ok(gpo.regContentMachine.includes('"ExtensionSettings"='), "ExtensionSettings must be defined in HKLM .reg");

  // Verify backwards compatibility: regContent defaults to regContentUser
  assert.ok(gpo.regContent.includes("Google\\Chrome"));

  // REMNA-PERUSER-XRAY-1 Phase 4: PEC-App machine bootstrap hive
  assert.ok(gpo.regContentClientApp.includes("Windows Registry Editor Version 5.00"), "client reg must be a valid .reg header");
  assert.ok(gpo.regContentClientApp.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\PEC-App"), "client reg must target HKLM\\SOFTWARE\\PEC-App");
  assert.ok(gpo.regContentClientApp.includes('"ServerUrl"="https://pec.corp.local"'), "client reg must carry ServerUrl");
  assert.ok(gpo.regContentClientApp.includes('"FleetToken"="test-corp-token-123"'), "client reg must carry FleetToken");
});

test("renders README-GPO.txt with GPMC instructions and registry parameters", () => {
  const extId = "abcdefghijklmnopabcdefghijklmnop";
  const serverUrl = "https://pec.corp.local";
  const token = "corp-token-xyz";

  const gpo = generateGpoConfig(extId, serverUrl, token, { targetGroup: "Default" });

  assert.ok(gpo.readmeContent, "readmeContent must be defined");
  assert.ok(gpo.readmeContent.includes("Active Directory"), "readmeContent must explain AD deployment");
  assert.ok(gpo.readmeContent.includes("GPMC"), "readmeContent must mention GPMC");
  assert.ok(gpo.readmeContent.includes("ExtensionInstallAllowlist"), "readmeContent must describe ExtensionInstallAllowlist");
  assert.ok(gpo.readmeContent.includes("ExtensionInstallSources"), "readmeContent must describe ExtensionInstallSources");
  assert.ok(gpo.readmeContent.includes("Legacy"), "readmeContent must mark Forcelist as legacy");
  assert.ok(gpo.readmeContent.includes("ExtensionSettings"), "readmeContent must describe ExtensionSettings");
  assert.ok(gpo.readmeContent.includes("domainUser"), "readmeContent must describe domainUser");
  assert.ok(gpo.readmeContent.includes("normal_installed"), "readmeContent must explain Yandex normal_installed");
  // REMNA-PERUSER-XRAY-1 Phase 4: native client (PEC-App) deployment section
  assert.ok(gpo.readmeContent.includes("pec-app-client.reg"), "readmeContent must document pec-app-client.reg");
  assert.ok(gpo.readmeContent.includes("SOFTWARE\\PEC-App"), "readmeContent must document the PEC-App registry hive");
  assert.ok(gpo.readmeContent.includes("Xray"), "readmeContent must document the Xray runtime deployment");
});

test("generateGpoDeploymentPack creates valid zip with canonical deployment artifacts", async () => {
  const { generateGpoDeploymentPack } = await import("../src/packager.js");
  const pack = generateGpoDeploymentPack("https://pec.corp.local", "token-pack-test");

  assert.ok(pack.zipBuffer.length > 0, "zipBuffer must not be empty");
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(pack.zipBuffer);
  const entries = zip.getEntries().map(e => e.entryName);

  assert.deepEqual(
    entries.sort(),
    ["README-GPO.txt", "pec-app-client.reg", "pec-policy-machine.reg", "pec-policy-user.reg"].sort(),
    "pack must contain only canonical .reg files and README"
  );

  // Verify secret hygiene
  const regUser = zip.readAsText("pec-policy-user.reg");
  assert.ok(!regUser.includes(process.env.ADMIN_TOKEN || "test-root-admin-token"));

  // REMNA-PERUSER-XRAY-1 Phase 4: client bootstrap reg for HKLM\SOFTWARE\PEC-App
  const regClient = zip.readAsText("pec-app-client.reg");
  assert.ok(regClient.includes("HKEY_LOCAL_MACHINE\\SOFTWARE\\PEC-App"), "client reg must target HKLM\\SOFTWARE\\PEC-App");
  assert.ok(regClient.includes('"ServerUrl"="https://pec.corp.local"'), "client reg must carry ServerUrl");
  assert.ok(regClient.includes('"FleetToken"="token-pack-test"'), "client reg must carry FleetToken");
  assert.ok(!regClient.includes("ADMIN_TOKEN"), "client reg must never carry admin token");
});

test("buildGpoPackage alias creates valid zipBuffer", () => {
  const serverUrl = "https://pec.corp.local";
  const token = "token-pack-test";
  const gpoPack = buildGpoPackage(serverUrl, token);
  assert.ok(gpoPack.zipBuffer.length > 0, "buildGpoPackage must return valid zipBuffer");
});
