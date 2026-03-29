(function () {
  var _id = 0,
    _cbs = {};
  window.addEventListener("message", function (e) {
    if (!e.data) return;
    var t = e.data.type;
    if (t !== "ejs-fetch-response" && t !== "ejs-bridge-response") return;
    var cb = _cbs[e.data.id];
    if (!cb) return;
    delete _cbs[e.data.id];
    if (e.data.error) {
      cb.reject(new Error(e.data.error));
      return;
    }
    if (t === "ejs-bridge-response") {
      cb.resolve(e.data.data);
      return;
    }
    var raw = e.data.data;
    var o = cb.opts || {};
    if (o.json) {
      try {
        var b64 = raw.base64;
        var u8 = Uint8Array.from(atob(b64), function (c) {
          return c.charCodeAt(0);
        });
        var txt = new TextDecoder("utf-8").decode(u8);
        cb.resolve(JSON.parse(txt));
      } catch (err) {
        cb.reject(err);
      }
    } else {
      cb.resolve(raw);
    }
  });
  window.__bridge = {
    fetch: function (url, options) {
      return new Promise(function (resolve, reject) {
        var id = ++_id;
        var opts = options || {};
        _cbs[id] = { resolve: resolve, reject: reject, opts: opts };
        window.parent.postMessage(
          { type: "ejs-fetch", id: id, url: url, options: opts },
          "*"
        );
      });
    },
    getLocale: function () {
      return new Promise(function (resolve, reject) {
        var id = ++_id;
        _cbs[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage(
          { type: "ejs-bridge", id: id, action: "getLocale" },
          "*"
        );
      });
    },
    openUrl: function (url) {
      return new Promise(function (resolve, reject) {
        var id = ++_id;
        _cbs[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage(
          { type: "ejs-bridge", id: id, action: "openUrl", url: String(url) },
          "*"
        );
      });
    },
  };
  function _resolveAnchorUrl(a) {
    if (!a || !a.getAttribute) return "";
    var u = (a.getAttribute("data-url") || "").trim();
    if (u && /^https?:\/\//i.test(u)) return u;
    var h = (a.getAttribute("href") || "").trim();
    if (!h || h === "#" || h.charAt(0) === "#") return "";
    if (
      /^javascript:/i.test(h) ||
      /^mailto:/i.test(h) ||
      /^tel:/i.test(h)
    ) {
      return "";
    }
    if (/^https?:\/\//i.test(h)) return h;
    if (/^\/\//.test(h)) return "https:" + h;
    try {
      var ru = new URL(h, document.baseURI);
      if (/^https?:$/i.test(ru.protocol)) return ru.toString();
    } catch (_) {}
    return "";
  }
  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var t = e.target;
      if (!t || !t.closest) return;
      var a = t.closest("a");
      if (!a) return;
      var u = _resolveAnchorUrl(a);
      if (!u) return;
      e.preventDefault();
      if (window.__bridge && window.__bridge.openUrl) {
        window.__bridge.openUrl(u).catch(function () {});
      } else {
        window.open(u, "_blank", "noopener,noreferrer");
      }
    },
    true
  );
})();
