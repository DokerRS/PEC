import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "ldapts";
import {
  AdSyncService,
  escapeLdapFilter,
  isDomainUserAllowed,
  loadAdConfig,
  clampSyncIntervalSec,
} from "../src/adSync.js";
import { sanitizeLogValue } from "../src/logger.js";
import { periodicAdSyncTask, stopScheduler } from "../src/scheduler.js";
import { getAdCachePath, getDataDir, getAdConfigPath } from "../src/storage.js";

test("adSync: loads configuration defaults and honors environment variables", () => {
  const origEnabled = process.env.AD_ENABLED;
  const origUrl = process.env.AD_LDAP_URL;
  const origReject = process.env.AD_REJECT_UNKNOWN_USERS;

  try {
    process.env.AD_ENABLED = "true";
    process.env.AD_LDAP_URL = "ldaps://dc.example.corp:636";
    process.env.AD_REJECT_UNKNOWN_USERS = "true";

    const cfg = loadAdConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.ldapUrl, "ldaps://dc.example.corp:636");
    assert.equal(cfg.rejectUnknownUsers, true);
  } finally {
    process.env.AD_ENABLED = origEnabled;
    process.env.AD_LDAP_URL = origUrl;
    process.env.AD_REJECT_UNKNOWN_USERS = origReject;
  }
});

test("adSync: escapeLdapFilter properly escapes special LDAP characters", () => {
  assert.equal(escapeLdapFilter("normal_group"), "normal_group");
  assert.equal(escapeLdapFilter("CN=Admin*Group (Tier 1)\\Special"), "CN=Admin\\2aGroup \\28Tier 1\\29\\5cSpecial");
});

test("adSync: isDomainUserAllowed allows all users when AD_ENABLED !== 'true'", () => {
  const svc = new AdSyncService({ enabled: false });
  assert.equal(svc.isUserAllowed("CORP\\alice"), true);
  assert.equal(svc.isUserAllowed("bob"), true);
  assert.equal(svc.isUserAllowed(""), true);
  assert.equal(svc.isUserAllowed(undefined), true);
  assert.equal(svc.isUserAllowed(null), true);
});

test("adSync: fast in-memory matching supports domain prefixes, UPNs, and case-insensitivity", () => {
  const svc = new AdSyncService({
    enabled: true,
    rejectUnknownUsers: true,
  });

  svc.setMockAllowedUsers(["john.doe", "alice.smith", "admin_ops@corp.local"]);

  // Direct match
  assert.equal(svc.isUserAllowed("john.doe"), true);
  assert.equal(svc.isUserAllowed("JOHN.DOE"), true);

  // Domain prefix (DOMAIN\username)
  assert.equal(svc.isUserAllowed("CORP\\john.doe"), true);
  assert.equal(svc.isUserAllowed("corp.local\\john.doe"), true);
  assert.equal(svc.isUserAllowed("CORP\\ALICE.SMITH"), true);

  // UPN (username@domain)
  assert.equal(svc.isUserAllowed("admin_ops@corp.local"), true);
  assert.equal(svc.isUserAllowed("ADMIN_OPS@CORP.LOCAL"), true);
  assert.equal(svc.isUserAllowed("john.doe@corp.local"), true); // prefix matches allowed sAMAccountName

  // Unknown or unauthorized users
  assert.equal(svc.isUserAllowed("CORP\\mallory"), false);
  assert.equal(svc.isUserAllowed("hacker"), false);
  assert.equal(svc.isUserAllowed(""), false);
  assert.equal(svc.isUserAllowed(undefined), false);
});

test("adSync: comprehensive normalization of DOMAIN\\user, user@domain.com, and user variants", () => {
  const svc = new AdSyncService({
    enabled: true,
    rejectUnknownUsers: true,
  });

  svc.setMockAllowedUsers(["alice.smith", "bob_ops"]);

  // 1. Bare user
  assert.equal(svc.isUserAllowed("alice.smith"), true);
  assert.equal(svc.isUserAllowed("bob_ops"), true);

  // 2. NetBIOS domain format (DOMAIN\user)
  assert.equal(svc.isUserAllowed("CORP\\alice.smith"), true);
  assert.equal(svc.isUserAllowed("DEV\\bob_ops"), true);

  // 3. FQDN domain prefix (domain.local\user)
  assert.equal(svc.isUserAllowed("corp.example.local\\alice.smith"), true);
  assert.equal(svc.isUserAllowed("sub.prod.network\\bob_ops"), true);

  // 4. UPN format (user@domain.com)
  assert.equal(svc.isUserAllowed("alice.smith@corp.example.com"), true);
  assert.equal(svc.isUserAllowed("bob_ops@internal.net"), true);

  // 5. Case-insensitivity across all formats
  assert.equal(svc.isUserAllowed("cOrP\\AlIcE.sMiTh"), true);
  assert.equal(svc.isUserAllowed("ALICE.SMITH@CORP.EXAMPLE.COM"), true);
  assert.equal(svc.isUserAllowed("BOB_OPS"), true);

  // 6. Trimming whitespace
  assert.equal(svc.isUserAllowed("  CORP\\alice.smith  "), true);
  assert.equal(svc.isUserAllowed("  alice.smith@corp.com  "), true);
  assert.equal(svc.isUserAllowed("\tbob_ops\n"), true);

  // 7. Non-matching users
  assert.equal(svc.isUserAllowed("CORP\\charlie"), false);
  assert.equal(svc.isUserAllowed("charlie@corp.com"), false);
  assert.equal(svc.isUserAllowed("charlie"), false);
});

test("adSync: filters userAccountControl bitmask (active vs disabled accounts)", async () => {
  const origBind = Client.prototype.bind;
  const origSearch = Client.prototype.search;
  const origUnbind = Client.prototype.unbind;

  try {
    Client.prototype.bind = async function () {};
    Client.prototype.unbind = async function () {};
    Client.prototype.search = async function () {
      return {
        searchEntries: [
          // Active users (bit 2 is 0)
          { sAMAccountName: "alice.active", userAccountControl: 512 }, // NORMAL_ACCOUNT
          {
            sAMAccountName: "bob.noexpire",
            userPrincipalName: "bob.noexpire@corp.local",
            userAccountControl: 66048, // NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD
          },
          { sAMAccountName: "charlie.string_uac", userAccountControl: "512" }, // String format
          // Disabled users (bit 2 is 1 -> ACCOUNTDISABLE = 0x0002)
          { sAMAccountName: "dave.disabled", userAccountControl: 514 }, // NORMAL_ACCOUNT | ACCOUNTDISABLE
          { sAMAccountName: "eve.dis_noexpire", userAccountControl: 66050 }, // DONT_EXPIRE_PASSWORD | ACCOUNTDISABLE
          { sAMAccountName: "frank.just_disabled", userAccountControl: 2 }, // ACCOUNTDISABLE
          { sAMAccountName: "grace.string_disabled", userAccountControl: "514" }, // String disabled
        ],
      } as any;
    };

    const svc = new AdSyncService({
      enabled: true,
      ldapUrl: "ldaps://fake-dc.corp:636",
      rejectUnknownUsers: true,
    });

    const result = await svc.sync();
    assert.equal(result.success, true);

    // Active accounts MUST be allowed
    assert.equal(svc.isUserAllowed("alice.active"), true);
    assert.equal(svc.isUserAllowed("CORP\\alice.active"), true);
    assert.equal(svc.isUserAllowed("bob.noexpire"), true);
    assert.equal(svc.isUserAllowed("bob.noexpire@corp.local"), true);
    assert.equal(svc.isUserAllowed("charlie.string_uac"), true);

    // Disabled accounts MUST be rejected (skipped during sync)
    assert.equal(svc.isUserAllowed("dave.disabled"), false);
    assert.equal(svc.isUserAllowed("CORP\\dave.disabled"), false);
    assert.equal(svc.isUserAllowed("eve.dis_noexpire"), false);
    assert.equal(svc.isUserAllowed("frank.just_disabled"), false);
    assert.equal(svc.isUserAllowed("grace.string_disabled"), false);
  } finally {
    Client.prototype.bind = origBind;
    Client.prototype.search = origSearch;
    Client.prototype.unbind = origUnbind;
  }
});

test("adSync: rejectUnknownUsers=false permits empty domainUser while still enforcing allowed list for known users", () => {
  const svc = new AdSyncService({
    enabled: true,
    rejectUnknownUsers: false,
  });

  svc.setMockAllowedUsers(["john.doe"]);

  // Allowed member
  assert.equal(svc.isUserAllowed("CORP\\john.doe"), true);

  // Unknown member is rejected even when rejectUnknownUsers=false
  assert.equal(svc.isUserAllowed("CORP\\unauthorized_user"), false);

  // Devices/extensions without domainUser are permitted when rejectUnknownUsers=false
  assert.equal(svc.isUserAllowed(""), true);
  assert.equal(svc.isUserAllowed(undefined), true);
});

test("adSync: fault tolerance preserves existing cache when Domain Controller is unreachable", async () => {
  const svc = new AdSyncService({
    enabled: true,
    ldapUrl: "ldaps://127.0.0.1:19999", // non-existent port
    bindDn: "CN=svc,DC=corp",
    bindPassword: "pass",
    searchBase: "DC=corp",
    requiredGroupDn: "CN=ProxyGroup,DC=corp",
  });

  // Pre-seed in-memory allowed users
  svc.setMockAllowedUsers(["persisted.user"]);
  assert.equal(svc.isUserAllowed("persisted.user"), true);

  // Trigger sync against dead server
  const result = await svc.sync();

  assert.equal(result.success, false);
  assert.ok(result.error);

  // In-memory cache must NOT be purged
  assert.equal(svc.isUserAllowed("CORP\\persisted.user"), true);
  assert.equal(svc.getAllowedUsersCount(), 1);
});

test("adSync: loads cached users from data/ad_cache.json on service initialization", () => {
  const cachePath = getAdCachePath();
  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });

  const testCache = {
    updatedAt: new Date().toISOString(),
    groupDn: "CN=TestGroup,DC=corp",
    count: 2,
    allowedUsers: ["cached.user1", "cached.user2"],
  };

  fs.writeFileSync(cachePath, JSON.stringify(testCache), "utf-8");

  const svc = new AdSyncService({ enabled: true, rejectUnknownUsers: true });

  assert.equal(svc.isUserAllowed("CORP\\cached.user1"), true);
  assert.equal(svc.isUserAllowed("cached.user2"), true);
  assert.equal(svc.isUserAllowed("cached.user3"), false);
});

test("logger: sanitizes AD_BIND_PASSWORD and adBindPassword keys", () => {
  const origPass = process.env.AD_BIND_PASSWORD;
  try {
    process.env.AD_BIND_PASSWORD = "SuperSecretAdPassword123!";

    // 1. String redaction
    const logStr = "Connecting with pass SuperSecretAdPassword123! to LDAPS";
    const sanitizedStr = sanitizeLogValue(logStr);
    assert.ok(!String(sanitizedStr).includes("SuperSecretAdPassword123!"));
    assert.ok(String(sanitizedStr).includes("[REDACTED]"));

    // 2. Object key redaction
    const logObj = {
      ad_bind_password: "SuperSecretAdPassword123!",
      adBindPassword: "AnotherSecretPassword",
      bindPassword: "ThirdSecretPassword",
    };
    const sanitizedObj = sanitizeLogValue(logObj) as any;
    assert.equal(sanitizedObj.ad_bind_password, "[REDACTED]");
    assert.equal(sanitizedObj.adBindPassword, "[REDACTED]");
    assert.equal(sanitizedObj.bindPassword, "[REDACTED]");
  } finally {
    process.env.AD_BIND_PASSWORD = origPass;
  }
});

test("scheduler: periodicAdSyncTask starts and stopScheduler cleanly stops periodic AD sync", () => {
  // Should not throw or crash
  assert.doesNotThrow(() => {
    periodicAdSyncTask();
  });
  assert.doesNotThrow(() => {
    stopScheduler();
  });
});

test("SRV-2: syncIntervalSec is clamped to 5..86400 in saveConfig, updateConfig and disk merge (anti-hot-loop)", () => {

  // Pure clamp semantics
  assert.equal(clampSyncIntervalSec(0), 5, "zero must clamp to the 5s floor");
  assert.equal(clampSyncIntervalSec(-100), 5, "negative must clamp to the 5s floor");
  assert.equal(clampSyncIntervalSec(1), 5);
  assert.equal(clampSyncIntervalSec(60), 60, "in-range values pass through");
  assert.equal(clampSyncIntervalSec(86400), 86400, "upper bound is inclusive");
  assert.equal(clampSyncIntervalSec(999999999), 86400, "huge values clamp to one day");
  assert.equal(clampSyncIntervalSec("0"), 5, "string zero must clamp too");
  assert.equal(clampSyncIntervalSec("abc"), 300, "garbage falls back to the 300s default");
  assert.equal(clampSyncIntervalSec(undefined), 300);
  assert.equal(clampSyncIntervalSec(NaN), 300);

  // saveConfig: raw web-form body values must never reach setInterval/setTimeout
  const svc = new AdSyncService({ enabled: false, ldapUrl: "ldaps://ad.test:636" });
  svc.saveConfig({ syncIntervalSec: 0 });
  assert.equal(svc.getConfig().syncIntervalSec, 5, "saveConfig(0) must persist the clamped floor");
  svc.saveConfig({ syncIntervalSec: 10_000_000 });
  assert.equal(svc.getConfig().syncIntervalSec, 86400, "saveConfig(huge) must persist the clamped ceiling");
  const persisted = JSON.parse(fs.readFileSync(getAdConfigPath(), "utf-8"));
  assert.equal(persisted.syncIntervalSec, 86400, "clamped value must be what lands on disk");

  // updateConfig: direct programmatic path is clamped as well
  svc.updateConfig({ syncIntervalSec: -42 });
  assert.equal(svc.getConfig().syncIntervalSec, 5, "updateConfig(negative) must clamp");

  // Disk merge: a hand-edited ad_config.json with 0 must not hot-loop on boot
  fs.writeFileSync(
    getAdConfigPath(),
    JSON.stringify({ enabled: true, ldapUrl: "ldaps://ad.test:636", syncIntervalSec: 0 })
  );
  const fromDisk = new AdSyncService();
  assert.equal(fromDisk.getConfig().syncIntervalSec, 5, "disk value 0 must clamp at load");

  fs.unlinkSync(getAdConfigPath());
});

test("AD-TLS-OPT-1: buildClientOptions attaches tlsOptions ONLY for ldaps:// URLs", () => {
  const svc = new AdSyncService({ enabled: false, ldapUrl: "ldaps://ad.test:636" });

  // Plain ldap://: NO tlsOptions (ldapts 9.2.0 ECONNRESET quirk — see observations.md [runtime])
  const plain = svc.buildClientOptions("ldap://dc01.corp.local:389", true, 5000);
  assert.equal(plain.url, "ldap://dc01.corp.local:389");
  assert.equal(plain.timeout, 5000);
  assert.equal(plain.connectTimeout, 5000);
  assert.equal((plain as any).tlsOptions, undefined, "ldap:// must NOT carry tlsOptions");

  // LDAPS: tlsOptions present with the passed rejectUnauthorized
  const secureSecure = svc.buildClientOptions("ldaps://dc01.corp.local:636", true, 5000);
  assert.deepEqual(secureSecure.tlsOptions, { rejectUnauthorized: true });
  const secureInsecure = svc.buildClientOptions("ldaps://dc01.corp.local:636", false, 10000);
  assert.deepEqual(secureInsecure.tlsOptions, { rejectUnauthorized: false }, "explicit insecure mode must survive for ldaps://");

  // Scheme matching is case-insensitive and trims whitespace
  assert.deepEqual(svc.buildClientOptions("  LDAPS://ad.test:636 ", false, 1000).tlsOptions, { rejectUnauthorized: false });
  assert.equal(svc.buildClientOptions("ldap://ad.test:389 ", true, 1000).tlsOptions, undefined);
});

test("AD-TLS-OPT-1: ldapts version is pinned in the lock (quirk behavior guard)", async () => {
  // AD-TLS-OPT-1 quirk: ldapts 9.2.0 sends tlsOptions to the socket layer even
  // for plain ldap:// and the connection dies with ECONNRESET before the LDAP
  // dialogue (production, three-variant bisection). buildClientOptions works
  // around it by attaching tlsOptions only for ldaps://.
  //
  // If this test fails after a dependency upgrade, RE-VERIFY THE QUIRK on a
  // live ldap:// endpoint before touching buildClientOptions: newer ldapts
  // versions may ignore tlsOptions for ldap:// (fixing the bug) or change the
  // failure mode.
  const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf-8"));
  const locked = lock.packages?.["node_modules/ldapts"]?.version;
  assert.equal(locked, "9.2.0", "ldapts version changed — re-verify the ldap:// + tlsOptions ECONNRESET quirk and update buildClientOptions/this comment");

  const installed = JSON.parse(
    fs.readFileSync(path.resolve("node_modules", "ldapts", "package.json"), "utf-8")
  ).version as string;
  assert.equal(installed, locked, "installed ldapts must match the lock entry");
});

test("AD-UX-2: countUniqueUsers counts unique sAMAccountName (user case 28+28+8=64 identifiers)", () => {
  const svc = new AdSyncService({ enabled: false, ldapUrl: "ldaps://ad.test:636" });
  // The user report: 28 users, all with UPN, 8 with mail filled -> 64 identifiers
  svc.setMockAllowedUsers([
    // 28 sAMAccountName + 28 UPN
    ...Array.from({ length: 28 }, (_, i) => `user${i + 1}`),
    ...Array.from({ length: 28 }, (_, i) => `user${i + 1}@corp.local`),
    // 8 mail-filled users
    ...Array.from({ length: 8 }, (_, i) => `user${i + 1}@corp.com`),
  ]);
  assert.equal(svc.getAllowedUsersCount(), 64, "identifier count must be the full Set size (sam+UPN+mail)");
  assert.equal(svc.countUniqueUsers(), 28, "unique sAMAccountName count must be the honest user count");

  // DOMAIN\username form is also an identity form, not a separate user
  svc.setMockAllowedUsers(["CORP\\alice", "alice", "alice@corp.local"]);
  assert.equal(svc.getAllowedUsersCount(), 3);
  assert.equal(svc.countUniqueUsers(), 1, "sam-only entries count as users; the DOMAIN-backslash form is an identity form");
});
