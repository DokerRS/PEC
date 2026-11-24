import "./helpers/setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AdSyncService } from "../src/adSync.js";

/**
 * AD-DX-1: structural AD error classification — phase (connect|bind|search),
 * kind (network|ldap), win32 data suffix (52e/533/532/775/525) with human
 * hints, and the safe query digest (no passwords).
 */

const svc = new AdSyncService({ enabled: false, ldapUrl: "ldaps://ad.test:636" });

test("AD-DX-1: win32 data suffixes map to the documented hints", () => {
  const cases: Array<[string, string]> = [
    ["data 52e", "Неверный пароль"],
    ["data 533", "отключена"],
    ["data 532", "истёк"],
    ["data 775", "заблокирована"],
    ["data 525", "не найдена"],
  ];
  for (const [suffix, hintPart] of cases) {
    const err = new Error(`80090308: LdapErr: DSID-0C090447, comment: AcceptSecurityContext error, ${suffix}, v1db1`);
    const cls = svc.classifyAdError(err, "bind");
    assert.equal(cls.kind, "ldap", `${suffix} must be classified as ldap`);
    assert.equal(cls.phase, "bind");
    assert.ok(cls.hint && cls.hint.includes(hintPart), `${suffix} hint must include "${hintPart}", got: ${cls.hint}`);
  }
});

test("AD-DX-1: transport failures classify as network, not ldap", () => {
  for (const message of ["connect ECONNREFUSED 10.0.0.5:636", "getaddrinfo ENOTFOUND dc.corp.local", "TLS handshake timeout"]) {
    const cls = svc.classifyAdError(new Error(message), "connect");
    assert.equal(cls.kind, "network", `${message} must be network`);
    assert.equal(cls.phase, "connect");
  }
  // E-codes on the error object also signal network
  const err: any = new Error("socket hang up");
  err.code = "ECONNRESET";
  const cls = svc.classifyAdError(err, "connect");
  assert.equal(cls.kind, "network", "ECONNRESET must classify as network");
});

test("AD-DX-1: describeQuery includes base/scope/filter/attributes and never passwords", () => {
  const digest = svc.describeQuery(
    "DC=corp,DC=local",
    "sub",
    "(&(objectCategory=person)(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:=CN=P,OU=G))",
    ["sAMAccountName", "userPrincipalName", "mail"]
  );
  assert.ok(digest.includes("base=DC=corp,DC=local"), "digest must carry the base");
  assert.ok(digest.includes("scope=sub"), "digest must carry the scope");
  assert.ok(digest.includes("filter="), "digest must carry the filter");
  assert.ok(digest.includes("sAMAccountName") && digest.includes("mail"), "digest must list attributes");
  assert.ok(!digest.toLowerCase().includes("password"), "digest must never carry passwords");
});

test("AD-DX-1: unknown/garbage errors classify as ldap without a fabricated hint", () => {
  const cls = svc.classifyAdError(new Error("weird server said something"), "bind");
  assert.equal(cls.kind, "ldap", "non-transport errors default to ldap");
  assert.equal(cls.data, undefined, "no data suffix -> no fabricated data");
  assert.equal(cls.hint, undefined, "no data suffix -> no fabricated hint");
  assert.equal(cls.message, "weird server said something");
});
