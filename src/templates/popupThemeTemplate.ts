// popupTheme.js template - pre-render theme bootstrap (AUDIT-EXT-2)
//
// MV3 extension pages enforce script-src 'self': the former inline <script>
// in popup.html was silently blocked by CSP (theme flash on every open plus
// a console violation). The same bootstrap now ships as this external file,
// loaded synchronously from <head> before first paint.

export const POPUP_THEME_TEMPLATE = `// popupTheme.js - theme bootstrap (generated from src/templates/popupThemeTemplate.ts; edit the template, not this file)
try {
  var m = localStorage.getItem("pec_theme_mode") || (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  if (m) {
    document.documentElement.setAttribute("data-theme", m);
    if (document.body) {
      document.body.setAttribute("data-theme", m);
    } else {
      document.addEventListener("DOMContentLoaded", function() {
        if (document.body) document.body.setAttribute("data-theme", m);
      });
    }
  }
} catch(e) {}
`;
