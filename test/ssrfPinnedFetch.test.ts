import "./helpers/setup.js";
import http from "node:http";
import dns from "node:dns";
import test from "node:test";
import assert from "node:assert";
import type { AddressInfo } from "node:net";

/**
 * AUDIT-SEC-2 (SSRF TOCTOU): validateSafeEndpointUrlAsync vets the DNS record,
 * but plain fetch() re-resolves at connect time. The rebind scenario:
 *   resolution #1 (validation) -> public TEST-NET address  -> check passes
 *   resolution #2 (connect)    -> 127.0.0.1                -> local service hit
 * A pinned fetch must keep connecting to the verified public address and never
 * reach the rebound loopback listener.
 */

test("SEC-2: pinned fetch defeats DNS rebinding between validation and connect", async () => {
  const prevAllow = process.env.ALLOW_INTERNAL_PANEL;
  delete process.env.ALLOW_INTERNAL_PANEL;
  const realLookup = dns.promises.lookup.bind(dns.promises);

  let localHits = 0;
  const server = http.createServer((_req, res) => {
    localHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, obj: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  let resolveCount = 0;
  (dns.promises as any).lookup = async (_hostname: string, _opts: unknown) => {
    resolveCount++;
    if (resolveCount === 1) {
      // Validation sees a public address (RFC 5737 TEST-NET-1, guaranteed unroutable)
      return [{ address: "192.0.2.1", family: 4 }];
    }
    // Every later resolution (what a vulnerable plain fetch would use) rebinds to loopback
    return [{ address: "127.0.0.1", family: 4 }];
  };

  try {
    const { createSsrfPinnedFetch } = await import("../src/rotate.js");
    const plan = await createSsrfPinnedFetch(`http://rebind.corp.test:${port}`);
    assert.strictEqual(plan.valid, true, "first resolution is public, so validation must pass");

    await assert.rejects(
      () => plan.fetch(`http://rebind.corp.test:${port}/csrf-token`, { signal: AbortSignal.timeout(750) }),
      "pinned fetch must not follow the rebound DNS record to 127.0.0.1"
    );
    assert.strictEqual(localHits, 0, "the loopback rebind target must receive zero connections");
    assert.ok(resolveCount >= 1, "validation performed the DNS lookup");
    plan.close();
  } finally {
    (dns.promises as any).lookup = realLookup;
    if (prevAllow !== undefined) process.env.ALLOW_INTERNAL_PANEL = prevAllow;
    if (typeof (server as any).closeAllConnections === "function") {
      (server as any).closeAllConnections();
    }
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("SEC-2: makePinnedLookup serves only verified addresses (single/all + family semantics)", async () => {
  const { makePinnedLookup } = await import("../src/rotate.js");
  const pinned = [
    { address: "203.0.113.10", family: 4 },
    { address: "2001:db8::10", family: 6 },
  ];
  const lookup = makePinnedLookup("panel.corp.test", pinned);

  // Single-address style (net.connect default)
  await new Promise<void>((resolve, reject) => {
    lookup("panel.corp.test", {}, (err: Error | null, address: string, family: number) => {
      if (err) return reject(err);
      assert.strictEqual(address, "203.0.113.10");
      assert.strictEqual(family, 4);
      resolve();
    });
  });

  // IPv6-family filter
  await new Promise<void>((resolve, reject) => {
    lookup("PANEL.CORP.TEST", { family: 6 }, (err: Error | null, address: string) => {
      if (err) return reject(err);
      assert.strictEqual(address, "2001:db8::10");
      resolve();
    });
  });

  // all:true style (happy-eyeballs)
  await new Promise<void>((resolve, reject) => {
    lookup("panel.corp.test", { all: true }, (err: Error | null, list: Array<{ address: string; family: number }>) => {
      if (err) return reject(err);
      assert.deepStrictEqual(list.map((e) => e.address).sort(), ["2001:db8::10", "203.0.113.10"]);
      resolve();
    });
  });

  // options-as-callback style (lookup(hostname, cb))
  await new Promise<void>((resolve, reject) => {
    (lookup as any)("panel.corp.test", (err: Error | null, address: string) => {
      if (err) return reject(err);
      assert.strictEqual(address, "203.0.113.10");
      resolve();
    });
  });
});

test("SEC-2: createSsrfPinnedFetch keeps rejecting private targets before any connection", async () => {
  const prevAllow = process.env.ALLOW_INTERNAL_PANEL;
  delete process.env.ALLOW_INTERNAL_PANEL;
  try {
    const { createSsrfPinnedFetch } = await import("../src/rotate.js");
    // 127.0.0.1 literal is blocked synchronously by the SSRF guard
    const loopback = await createSsrfPinnedFetch("http://127.0.0.1:1/");
    assert.strictEqual(loopback.valid, false);
    assert.ok(/SSRF/i.test(loopback.error || ""), `error should mention SSRF, got: ${loopback.error}`);
    await assert.rejects(() => loopback.fetch("http://127.0.0.1:1/"), /SSRF validation failed/);
    loopback.close();

    // Host resolving to RFC1918 is blocked at the DNS stage
    const realLookup = dns.promises.lookup.bind(dns.promises);
    (dns.promises as any).lookup = async () => [{ address: "10.1.2.3", family: 4 }];
    try {
      const priv = await createSsrfPinnedFetch("http://intranet.corp.test/");
      assert.strictEqual(priv.valid, false);
      assert.ok(/private address 10\.1\.2\.3/.test(priv.error || ""), `error should name the private address, got: ${priv.error}`);
      priv.close();
    } finally {
      (dns.promises as any).lookup = realLookup;
    }
  } finally {
    if (prevAllow !== undefined) process.env.ALLOW_INTERNAL_PANEL = prevAllow;
  }
});
