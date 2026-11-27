import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert";
import { registerHeartbeat, assignInstanceProfile, deleteInstance, getActiveInstances, detectBrowser, registerDesktopHeartbeat, sanitizeDesktopXrayStatus } from "../src/instances.js";

test("instance IDs cannot pollute the prototype chain or traverse paths", () => {
  assert.throws(() => registerHeartbeat({ instanceId: "__proto__", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: "constructor", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: "prototype", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: "toString", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: "valueOf", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: "hasOwnProperty", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: ".", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => registerHeartbeat({ instanceId: "..", ip: "1.2.3.4", version: "1.0.0" }), /Forbidden|Invalid instanceId/);
  assert.throws(() => assignInstanceProfile("__proto__", "prof_x"), /Forbidden|Invalid instanceId/);
  assert.throws(() => assignInstanceProfile("toString", "prof_x"), /Forbidden|Invalid instanceId/);

  // prototype untouched
  const meta: Record<string, unknown> = {};
  assert.strictEqual(({} as any).polluted, undefined);
  assert.strictEqual(typeof Object.prototype.toString, "function");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(meta, "__proto__"), false);
});

test("instances can be deleted from the registry (diagnostics cleanup)", () => {
  registerHeartbeat({ instanceId: "inst_cleanup_me", ip: "10.0.0.9", version: "1.0.0" });
  assert.ok(getActiveInstances().some((i) => i.instanceId === "inst_cleanup_me"));

  const removed = deleteInstance("inst_cleanup_me");
  assert.strictEqual(removed, true);
  assert.ok(!getActiveInstances().some((i) => i.instanceId === "inst_cleanup_me"));

  const removedAgain = deleteInstance("inst_cleanup_me");
  assert.strictEqual(removedAgain, false);
  assert.strictEqual(deleteInstance("__proto__"), false);
});

test("profile assignment persists and resolves the applied profile name", () => {
  registerHeartbeat({ instanceId: "inst_assign_target", ip: "10.1.1.1", version: "1.0.0", group: "Grunts" });
  assignInstanceProfile("inst_assign_target", "profile_default_split", "SEC-Proxy-VPN-VIP");

  const inst = registerHeartbeat({ instanceId: "inst_assign_target", ip: "10.1.1.1", version: "1.0.0" });
  assert.strictEqual(inst.assignedProfileId, "profile_default_split");
  assert.strictEqual(inst.group, "SEC-Proxy-VPN-VIP");
  assert.ok(inst.appliedProfileName);
});

test("LRU eviction is order-based and drops the least recently synced instance", () => {
  // fill with fresh IDs; earliest inserted must be evicted first
  const first = "inst_lru_first";
  registerHeartbeat({ instanceId: first, ip: "10.0.0.1", version: "1.0.0" });
  for (let i = 0; i < 2500; i++) {
    registerHeartbeat({ instanceId: `inst_lru_bulk_${i}`, ip: "10.0.0.2", version: "1.0.0" });
  }
  const active = getActiveInstances();
  assert.ok(active.length <= 2000, `registry must stay capped, got ${active.length}`);
  assert.ok(!active.some((i) => i.instanceId === first), "oldest entry must be evicted");
  assert.ok(active.some((i) => i.instanceId === "inst_lru_bulk_2499"), "newest entry must survive");
});

test("routingMode defaults to 'pac', can be updated to 'fixed', and validates input", async () => {
  const { getProxyConfig, updateProxyConfig } = await import("../src/instances.js");
  const cfg = getProxyConfig();
  assert.strictEqual(cfg.routingMode, "pac");

  const updated = updateProxyConfig({ routingMode: "fixed" });
  assert.strictEqual(updated.routingMode, "fixed");
  assert.strictEqual(getProxyConfig().routingMode, "fixed");

  // Extension background logic check:
  // const usePac = (config.protocol === "pac" || (config.pacUrl && config.routingMode !== "fixed"));
  const fixedConfig = getProxyConfig();
  const usePacWithFixed = (fixedConfig.protocol === "pac" || (Boolean(fixedConfig.pacUrl) && fixedConfig.routingMode !== "fixed"));
  assert.strictEqual(usePacWithFixed, false, "when routingMode is fixed, usePac must evaluate to false (fixed_servers)");

  assert.throws(() => updateProxyConfig({ routingMode: "invalid" as any }), /Invalid routingMode/);

  // revert back to pac
  updateProxyConfig({ routingMode: "pac" });
  assert.strictEqual(getProxyConfig().routingMode, "pac");
  const pacConfig = getProxyConfig();
  const usePacWithPac = (pacConfig.protocol === "pac" || (Boolean(pacConfig.pacUrl) && pacConfig.routingMode !== "fixed"));
  assert.strictEqual(usePacWithPac, true, "when routingMode is pac, usePac must evaluate to true (pac_script)");
});



test("registerHeartbeat stores domainUser and populates username when empty without breaking compatibility", () => {
  // 1. Extension without domainUser maintains backward compatibility
  const inst1 = registerHeartbeat({
    instanceId: "inst_no_domain",
    ip: "10.0.0.10",
    version: "1.0.0",
  });
  assert.strictEqual(inst1.domainUser, undefined);
  assert.strictEqual(inst1.username, undefined);

  // 2. Extension with domainUser populates both domainUser and username
  const inst2 = registerHeartbeat({
    instanceId: "inst_with_domain",
    ip: "10.0.0.11",
    version: "1.0.0",
    domainUser: "CORP\\john.doe",
  });
  assert.strictEqual(inst2.domainUser, "CORP\\john.doe");
  assert.strictEqual(inst2.username, "CORP\\john.doe");

  // 3. Subsequent heartbeat without domainUser preserves existing domainUser and username
  const inst2Next = registerHeartbeat({
    instanceId: "inst_with_domain",
    ip: "10.0.0.11",
    version: "1.0.1",
  });
  assert.strictEqual(inst2Next.domainUser, "CORP\\john.doe");
  assert.strictEqual(inst2Next.username, "CORP\\john.doe");
});

test("detectBrowser correctly identifies browser from explicit value, instanceId prefix, and userAgent", () => {
  // Explicit client browser
  assert.strictEqual(detectBrowser(undefined, "edge"), "Edge");
  assert.strictEqual(detectBrowser(undefined, "chrome"), "Chrome");
  assert.strictEqual(detectBrowser(undefined, "yandex"), "Yandex");
  assert.strictEqual(detectBrowser(undefined, "opera"), "Opera");
  assert.strictEqual(detectBrowser(undefined, "brave"), "Brave");
  assert.strictEqual(detectBrowser(undefined, "vivaldi"), "Vivaldi");

  // Instance ID prefix
  assert.strictEqual(detectBrowser(undefined, undefined, "inst_edge_123456_abcdef"), "Edge");
  assert.strictEqual(detectBrowser(undefined, undefined, "inst_chrome_123456_abcdef"), "Chrome");
  assert.strictEqual(detectBrowser(undefined, undefined, "inst_yandex_123456_abcdef"), "Yandex");
  assert.strictEqual(detectBrowser(undefined, undefined, "inst_opera_123456_abcdef"), "Opera");

  // User-Agent string detection
  const edgeUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56";
  assert.strictEqual(detectBrowser(edgeUa), "Edge");

  const chromeUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  assert.strictEqual(detectBrowser(chromeUa), "Chrome");

  const yaUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36";
  assert.strictEqual(detectBrowser(yaUa), "Yandex");

  const oprUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0";
  assert.strictEqual(detectBrowser(oprUa), "Opera");

  // registerHeartbeat sets browser property on ExtensionInstance
  const instEdge = registerHeartbeat({
    instanceId: "inst_edge_auto_detect",
    ip: "10.0.0.12",
    version: "1.0.2",
    userAgent: edgeUa,
  });
  assert.strictEqual(instEdge.browser, "Edge");

  const instGeneric = registerHeartbeat({
    instanceId: "inst_generic_fallback",
    ip: "10.0.0.13",
    version: "1.0.2",
  });
  assert.strictEqual(instGeneric.browser, "Chrome");
});

test("xrayStatus from desktop clients is sanitized and preserved", () => {
  // garbage in -> undefined (heartbeat then preserves previous value)
  assert.strictEqual(sanitizeDesktopXrayStatus(undefined), undefined);
  assert.strictEqual(sanitizeDesktopXrayStatus("running"), undefined);
  assert.strictEqual(sanitizeDesktopXrayStatus([1, 2]), undefined);

  // shape is fixed, reason is whitelisted, numbers are bounded
  const ok = sanitizeDesktopXrayStatus({
    enabled: true,
    running: true,
    version: " 24.11.11 ",
    socksPort: 20810.7,
    reason: " NO_ACTIVE_SUBSCRIPTION ",
    serverCount: 999,
    updatedAt: "2026-11-27T00:00:00.000Z",
    evil: { nested: true },
  });
  assert.ok(ok);
  assert.strictEqual(ok.enabled, true);
  assert.strictEqual(ok.running, true);
  assert.strictEqual(ok.version, "24.11.11");
  assert.strictEqual(ok.socksPort, 20810);
  assert.strictEqual(ok.reason, "no_active_subscription");
  assert.strictEqual(ok.serverCount, 64);
  assert.strictEqual((ok as Record<string, unknown>).evil, undefined);

  // non-whitelisted reason is dropped
  const noReason = sanitizeDesktopXrayStatus({ enabled: false, running: false, reason: "arbitrary_text" });
  assert.strictEqual(noReason?.reason, undefined);

  // heartbeat stores status, then preserves it when a later beat omits it
  const beat = (xrayStatus?: unknown) =>
    registerDesktopHeartbeat({
      appInstanceId: "inst_xray_status",
      hostname: "PC-X",
      username: "xray-user",
      version: "2.3.0",
      ip: "10.9.9.9",
      xrayStatus,
    });
  const withStatus = beat({ enabled: true, running: true, socksPort: 20810, serverCount: 2 });
  assert.strictEqual(withStatus.xrayStatus?.running, true);
  assert.strictEqual(withStatus.xrayStatus?.socksPort, 20810);
  const withoutStatus = beat(undefined);
  assert.strictEqual(withoutStatus.xrayStatus?.running, true);
  assert.strictEqual(withoutStatus.xrayStatus?.serverCount, 2);
});
