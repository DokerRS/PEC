// popupTheme.js - theme bootstrap (generated from src/templates/popupThemeTemplate.ts; edit the template, not this file)
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
