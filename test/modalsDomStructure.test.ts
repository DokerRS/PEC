import test from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml } from "../src/views/dashboardView.js";

/**
 * GEO-PRESET-UX-2: the geobase-inspector / preset-edit / import-presets
 * modals were replaced by the full-width preset constructor sub-page inside
 * the Routing tab. These assertions keep the DOM structure contract: the
 * proxy form modal stays self-contained and the constructor is a top-level
 * sibling (not nested inside another dialog).
 */
test("preset constructor sub-page is top-level in the routing tab and modals are removed", () => {
  const html = renderDashboardHtml({ isDefaultTokenInUse: false, port: 8080 });

  assert.ok(html.includes('id="modalProxyForm"'), "modalProxyForm exists");
  assert.ok(!html.includes('id="modalGeobaseInspector"'), "modalGeobaseInspector must be removed");
  assert.ok(!html.includes('id="modalImportPresets"'), "modalImportPresets must be removed");
  assert.ok(!html.includes('id="modalPresetEdit"'), "modalPresetEdit must be removed");

  // The proxy form must close before the constructor page opens
  const proxyFormIndex = html.indexOf('id="modalProxyForm"');
  const builderIndex = html.indexOf('id="presetBuilderPage"');
  assert.ok(builderIndex !== -1, "presetBuilderPage exists");
  assert.ok(builderIndex > proxyFormIndex, "constructor page must come after the proxy form modal");
  const proxyFormSnippet = html.slice(proxyFormIndex, builderIndex);
  assert.ok(proxyFormSnippet.includes('</form>'), "Proxy form has closed form tag");
  assert.ok(
    proxyFormSnippet.includes('</div>\n  </div>') || proxyFormSnippet.includes('</div></div>'),
    "Proxy form closes dialog and overlay"
  );

  // Constructor internals: layers panel, composition table, footer actions
  assert.ok(html.includes('id="builderLayersList"'), "layers panel exists");
  assert.ok(html.includes('id="builderEntriesBody"'), "composition table exists");
  assert.ok(html.includes('id="builderGeoSelect"'), "geo list dropdown exists");
  assert.ok(html.includes('id="builderLayerFileInput"'), "file layer input exists");
  assert.ok(html.includes('id="builderImportJsonInput"'), "preset JSON import input exists");
  assert.ok(html.includes('id="builderAddDomain"'), "domain quick-add input exists");
  assert.ok(html.includes('btn-builder-save'), "save action exists");
  assert.ok(html.includes('btn-builder-back'), "back action exists");
});

test("renderDashboardHtml works with empty options", () => {
  const html = renderDashboardHtml({});
  assert.ok(html.includes('id="modalProxyForm"'));
  assert.ok(html.includes('id="presetBuilderPage"'));
  assert.ok(html.includes('id="routingBranchSwitcher"'));
});
