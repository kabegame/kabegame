(function () {
  "use strict";

  var ROOT_ID = "__kabegame_surf_navbar_root__";
  var NAVBAR_HEIGHT = 40;
  var Z_INDEX = 2147483646;

  function themeColors() {
    var dark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    return {
      dark: dark,
      bg: dark ? "#1d1d1f" : "#f5f5f7",
      fg: dark ? "#f5f5f7" : "#1d1d1f",
      border: dark ? "#3a3a3c" : "#d2d2d7",
      btnHover: dark ? "#3a3a3c" : "#e5e5ea",
    };
  }

  function applyBarTheme(bar, urlInput, backBtn, fwdBtn, reloadBtn, devtoolsBtn, t) {
    bar.style.background = t.bg;
    bar.style.borderBottomColor = t.border;
    bar.style.color = t.fg;
    urlInput.style.color = t.fg;
    urlInput.style.background = t.dark
      ? "rgba(255,255,255,0.08)"
      : "rgba(0,0,0,0.06)";
    urlInput.style.borderColor = t.border;
    [backBtn, fwdBtn, reloadBtn, devtoolsBtn].forEach(function (btn) {
      btn.style.color = t.fg;
    });
  }

  function normalizeNavigateUrl(raw) {
    var s = String(raw || "").trim();
    if (!s) return null;
    if (!/^[a-zA-Z][-a-zA-Z0-9+.]*:/.test(s)) s = "https://" + s;
    try {
      var u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.href;
    } catch (_) {
      return null;
    }
  }

  function openSurfDevtools() {
    var I = window.__TAURI_INTERNALS__;
    if (I && typeof I.invoke === "function") {
      I.invoke("surf_open_devtools", {}).catch(function () {});
    }
  }

  function mount() {
    if (document.getElementById(ROOT_ID)) return;

    var t = themeColors();

    var bar = document.createElement("div");
    bar.id = ROOT_ID;
    bar.setAttribute("role", "navigation");
    bar.style.cssText =
      "position:sticky;top:0;left:0;right:0;width:100%;height:" +
      NAVBAR_HEIGHT +
      "px;display:flex;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;" +
      "border-bottom:1px solid;z-index:" +
      Z_INDEX +
      ";flex-shrink:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "box-shadow:0 1px 0 rgba(0,0,0,.06);";

    function bindBtnHover(el) {
      el.style.cssText =
        "display:flex;align-items:center;justify-content:center;width:32px;height:32px;" +
        "padding:0;border:none;border-radius:6px;background:transparent;cursor:pointer;" +
        "flex-shrink:0;line-height:0;overflow:visible;-webkit-appearance:none;appearance:none;";
      el.onmouseenter = function () {
        el.style.background = t.btnHover;
      };
      el.onmouseleave = function () {
        el.style.background = "transparent";
      };
    }

    var backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.title = "Back";
    backBtn.setAttribute("aria-label", "Back");
    backBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    bindBtnHover(backBtn);
    backBtn.onclick = function () {
      try {
        history.back();
      } catch (_) {}
    };

    var fwdBtn = document.createElement("button");
    fwdBtn.type = "button";
    fwdBtn.title = "Forward";
    fwdBtn.setAttribute("aria-label", "Forward");
    fwdBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    bindBtnHover(fwdBtn);
    fwdBtn.onclick = function () {
      try {
        history.forward();
      } catch (_) {}
    };

    var reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.title = "Reload";
    reloadBtn.setAttribute("aria-label", "Reload");
    reloadBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 1024 1024" style="display:block;overflow:visible;flex-shrink:0"><path fill="currentColor" d="M891 489.2c-13.3 0-24 10.7-24 24 0 195.2-158.8 354-354 354s-354-158.8-354-354 158.8-354 354-354c111 0 215.3 52.1 282.2 140.2L688 281.3c-13.1-2.2-25.5 6.6-27.7 19.7-2.2 13.1 6.6 25.5 19.7 27.7l162.6 27.5c1.3 0.2 2.7 0.3 4 0.3 5.6 0 11.1-2 15.5-5.7 5.4-4.6 8.5-11.3 8.5-18.3V168.7c0-13.3-10.7-24-24-24s-24 10.7-24 24v88.2c-76-91.8-189.3-145.7-309.6-145.7-54.3 0-106.9 10.6-156.5 31.6-47.9 20.2-90.9 49.2-127.8 86.1s-65.9 79.9-86.1 127.8C121.6 406.3 111 459 111 513.2s10.6 106.9 31.6 156.5c20.2 47.9 49.2 90.9 86.1 127.8s79.9 65.9 127.8 86.1c49.6 21 102.2 31.6 156.5 31.6s106.9-10.6 156.5-31.6c47.9-20.2 90.9-49.2 127.8-86.1s65.9-79.9 86.1-127.8c21-49.6 31.6-102.2 31.6-156.5 0-13.2-10.7-24-24-24z"></path></svg>';
    bindBtnHover(reloadBtn);
    reloadBtn.onclick = function () {
      try {
        location.reload();
      } catch (_) {}
    };

    var urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.setAttribute("aria-label", "Address");
    urlInput.title = "Enter URL, press Enter to go";
    urlInput.spellcheck = false;
    urlInput.setAttribute("autocomplete", "off");
    urlInput.setAttribute("inputmode", "url");
    urlInput.value = location.href;
    urlInput.style.cssText =
      "flex:1;min-width:0;height:28px;box-sizing:border-box;font-size:12px;line-height:1.2;" +
      "font-family:ui-monospace,monospace;border:1px solid;border-radius:6px;padding:0 8px;" +
      "outline:none;";

    urlInput.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var href = normalizeNavigateUrl(urlInput.value);
      if (href) {
        try {
          location.href = href;
        } catch (_) {}
      } else if (typeof window.__kabegame_toast === "function") {
        window.__kabegame_toast("无效 URL", "failed");
      }
    });

    urlInput.addEventListener("blur", function () {
      urlInput.value = location.href;
    });

    var devtoolsBtn = document.createElement("button");
    devtoolsBtn.type = "button";
    devtoolsBtn.title = "Developer tools";
    devtoolsBtn.setAttribute("aria-label", "Developer tools");
    devtoolsBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>';
    bindBtnHover(devtoolsBtn);
    devtoolsBtn.onclick = function () {
      openSurfDevtools();
    };

    function updateUrl() {
      if (document.activeElement !== urlInput) urlInput.value = location.href;
    }

    applyBarTheme(bar, urlInput, backBtn, fwdBtn, reloadBtn, devtoolsBtn, t);

    bar.appendChild(backBtn);
    bar.appendChild(fwdBtn);
    bar.appendChild(reloadBtn);
    bar.appendChild(urlInput);
    bar.appendChild(devtoolsBtn);

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      function onSchemeChange() {
        t = themeColors();
        applyBarTheme(bar, urlInput, backBtn, fwdBtn, reloadBtn, devtoolsBtn, t);
      }
      if (mq.addEventListener) mq.addEventListener("change", onSchemeChange);
      else if (mq.addListener) mq.addListener(onSchemeChange);
    }

    var push = history.pushState;
    var replace = history.replaceState;
    history.pushState = function () {
      var r = push.apply(history, arguments);
      setTimeout(updateUrl, 0);
      return r;
    };
    history.replaceState = function () {
      var r = replace.apply(history, arguments);
      setTimeout(updateUrl, 0);
      return r;
    };
    window.addEventListener("popstate", updateUrl);
    window.addEventListener("hashchange", updateUrl);
    setInterval(updateUrl, 1000);

    if (document.body) {
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
