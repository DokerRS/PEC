import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { renderDashboardHtml } from "../src/views/dashboardView.js";
import { setupDashboardDom } from "./helpers/dashboardDom.js";

test("Task 1: dashboard view and i18n use Флот / Fleet terminology", () => {
  const html = renderDashboardHtml();
  assert.ok(html.includes("Флот"), "dashboard HTML must contain 'Флот'");
  assert.ok(html.includes("tab-instances") || html.includes("tab-fleet"), "must contain fleet tab navigation");

  // AUDIT-QA-P3: behavioral — exercise the shipped bundle's i18n dictionary
  // (was a source-content assert on the orphaned monolith): switching languages
  // must relabel the fleet tab in the live DOM.
  const env = setupDashboardDom({ authenticated: true });
  try {
    const tab = env.document.getElementById("tabBtnInstances");
    assert.ok(tab, "fleet tab button must exist");

    env.window.setLanguage("en");
    assert.match(
      tab?.textContent || "",
      /Fleet/,
      "bundle i18n must relabel the fleet tab to 'Fleet' in English"
    );

    env.window.setLanguage("ru");
    assert.match(
      tab?.textContent || "",
      /Флот/,
      "bundle i18n must relabel the fleet tab to 'Флот' in Russian"
    );
  } finally {
    env.teardown();
  }
});

test("Task 1: ExtensionInstance and ExtensionBuildConfig support multi-proxy fields", () => {
  const typesSrc = fs.readFileSync(path.resolve("src/types.ts"), "utf8");
  assert.ok(typesSrc.includes("assignedProxyId?: string"), "ExtensionInstance must include assignedProxyId");
  assert.ok(typesSrc.includes("appliedProxyName?: string"), "ExtensionInstance must include appliedProxyName");
  assert.ok(typesSrc.includes("allowUserProxySwitch?: boolean"), "ExtensionBuildConfig must include allowUserProxySwitch");
  assert.ok(typesSrc.includes("defaultProxyId?: string"), "ExtensionBuildConfig must include defaultProxyId");
});
