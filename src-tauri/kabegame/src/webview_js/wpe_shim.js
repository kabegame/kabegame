// WPE 网页壁纸运行时垫片：all-frames 初始化脚本，桌面壁纸窗口与主窗口共用。
// 只在两种文档里启用：桌面壁纸窗口的 file:// 主 frame；预览里主窗口的 file: 直接子 iframe。
// 其它文档（应用页、更深的嵌套 iframe）第一行就返回，不定义任何全局。
// 协议见 cocs/wpe/WPE_IMPORT.md「运行时垫片与宿主协议」：垫片向宿主拉取完整状态、订阅事件后重拉，
// 宿主不推状态；什么时候回调页面、回调哪些键，全由这里决定。
(function () {
  "use strict";
  var isTop = window === window.top;
  var desktop = isTop && location.protocol === "file:";
  var preview = !isTop && window.parent === window.top && location.protocol === "file:";
  if ((!desktop && !preview) || window.__kbWpeShim) return;
  Object.defineProperty(window, "__kbWpeShim", { value: true });

  // ---- WPE 全局接口（API.md §3.2 / §3.4）----
  window.wallpaperMediaIntegration = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };
  var registered = {};
  [
    "wallpaperRegisterAudioListener",
    "wallpaperRegisterMediaStatusListener",
    "wallpaperRegisterMediaPropertiesListener",
    "wallpaperRegisterMediaThumbnailListener",
    "wallpaperRegisterMediaPlaybackListener",
    "wallpaperRegisterMediaTimelineListener",
  ].forEach(function (name) {
    registered[name] = [];
    // 可多次注册、全部保留；Phase 8 起才有数据回调
    window[name] = function (cb) {
      if (typeof cb === "function") registered[name].push(cb);
    };
  });
  window.wallpaperRequestRandomFileForProperty = function () {}; // file / directory 属性暂不支持
  window.wallpaperGetUtilities = function () {
    return {};
  };

  // ---- 投递：load 后首次全量；之后用户属性按键差异、通用属性整份；首次之后换 listener 补投全量 ----
  var listener;
  var latest = null; // 收到的最新状态
  var delivered = null; // 上次投递给页面的状态
  var loaded = false;
  // 访问器装在 window 上：页面写 `window.x = …` 或顶层 `var x = …` 都会走到 setter
  Object.defineProperty(window, "wallpaperPropertyListener", {
    configurable: true,
    enumerable: true,
    get: function () {
      return listener;
    },
    set: function (value) {
      listener = value;
      if (delivered) {
        queueMicrotask(function () {
          if (listener === value) deliverFull(delivered);
        });
      }
    },
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }
  function call(name, arg) {
    var target = listener;
    if (target && typeof target[name] === "function") {
      try {
        target[name](arg);
      } catch (error) {
        console.error("[kb-wpe] " + name, error);
      }
    }
  }
  function deliverFull(state) {
    call("applyUserProperties", clone(state.user));
    call("applyGeneralProperties", clone(state.general));
    delivered = state;
  }
  function changedUser(prev, next) {
    var out = null;
    Object.keys(next).forEach(function (key) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
        (out || (out = {}))[key] = clone(next[key]);
      }
    });
    return out;
  }
  function receive(next) {
    latest = next;
    // load 之前只记下来，不提前回调（为 WPE 写的页面默认回调时 DOM 已就绪）
    if (!loaded) return;
    if (!delivered) return deliverFull(next);
    // WPE 没有整份替换的接口：只推值变化的键；作者删掉的键页面无从撤销，不推
    var changed = changedUser(delivered.user, next.user);
    if (changed) call("applyUserProperties", changed);
    if (JSON.stringify(delivered.general) !== JSON.stringify(next.general)) {
      call("applyGeneralProperties", clone(next.general));
    }
    delivered = next;
  }
  window.addEventListener("load", function () {
    loaded = true;
    if (latest && !delivered) deliverFull(latest);
  });

  // ---- 传输：pull() → Promise<state>；listen(names, onEvent) → Promise，各事件并入同一个 onEvent ----
  var transport = desktop ? tauriTransport(window.__TAURI_INTERNALS__) : parentTransport();
  if (!transport) return;

  // ---- ping 应答（只桌面 file:// 主 frame）：后端每 10s 发一次 ping ----
  // 只应答本窗口；连续 3 次不应答会整页重载。预览 iframe 碰不到 IPC，不参与。
  if (desktop) {
    var internals = window.__TAURI_INTERNALS__;
    var meta = internals.metadata || {};
    var selfLabel = meta.currentWebview ? meta.currentWebview.label : null;
    transport
      .listen(["wallpaper-ping"], function (event) {
        var payload = event.payload || {};
        if (payload.label !== selfLabel) return;
        internals.invoke("wallpaper_pong", { seq: payload.seq }).catch(function () {});
      })
      .catch(function (error) {
        console.warn("[kb-wpe] listen ping", error);
      });
  }

  // 拉取编号：某次结果落地后，丢弃更早发出、更晚返回的结果
  var issued = 0;
  var applied = 0;
  function pull() {
    var seq = ++issued;
    transport.pull().then(
      function (state) {
        if (!state || seq <= applied) return;
        applied = seq;
        receive(state);
      },
      function (error) {
        console.warn("[kb-wpe] pull", error);
      },
    );
  }

  function patchesOf(event) {
    var payload = event.payload || {};
    if (event.name === "image-changed") return payload.patch ? [payload.patch] : [];
    if (event.name === "images-change") return Array.isArray(payload.patches) ? payload.patches : [];
    return [];
  }
  function shouldPull(event) {
    if (event.name === "setting-change") {
      var payload = event.payload || {};
      var changes = payload.changes && typeof payload.changes === "object" ? payload.changes : payload;
      return Object.prototype.hasOwnProperty.call(changes, "language");
    }
    // 图片 metadata 按 id 不可变：属性改了就换 metadataId。首个状态到达前不知道本张 id，任何 metadataId 补丁都重拉
    var id = latest && latest.imageId;
    return patchesOf(event).some(function (patch) {
      return patch && typeof patch === "object" && "metadataId" in patch && (!id || String(patch.id) === id);
    });
  }

  // 先订阅再拉取：订阅生效之后的变化都会触发重拉
  transport
    .listen(["setting-change", "image-changed", "images-change"], function (event) {
      if (shouldPull(event)) pull();
    })
    .catch(function (error) {
      console.warn("[kb-wpe] listen", error);
    })
    .then(pull);

  // 桌面：主 frame 有 Tauri 脚本，直接 invoke / listen；权限只来自 wpe-web-capability
  function tauriTransport(internals) {
    if (!internals) return null;
    return {
      pull: function () {
        return internals.invoke("wpe_web_pull_state");
      },
      listen: function (names, onEvent) {
        return Promise.all(
          names.map(function (name) {
            return internals.invoke("plugin:event|listen", {
              event: name,
              target: { kind: "Any" },
              handler: internals.transformCallback(function (event) {
                onEvent({ name: name, payload: event.payload });
              }),
            });
          }),
        );
      },
    };
  }

  // 预览：file: iframe 碰不到 IPC，拉取与 listen 都 postMessage 给宿主页代办
  function parentTransport() {
    var nextId = 0;
    var pending = {}; // 拉取 id → 落地回调
    var onEvent = null;
    // 发出的消息只有拉取编号与事件名，不含数据；宿主页按 event.source 认 iframe
    function post(message) {
      message.kbWpe = 1;
      window.parent.postMessage(message, "*");
    }
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (event.source !== window.parent || !data || data.kbWpe !== 1) return;
      if (data.type === "state" && pending[data.id]) {
        var settle = pending[data.id];
        delete pending[data.id];
        settle(data);
      } else if (data.type === "event" && onEvent) {
        onEvent({ name: data.name, payload: data.payload });
      }
    });
    return {
      pull: function () {
        var id = ++nextId;
        return new Promise(function (resolve, reject) {
          pending[id] = function (data) {
            if (data.error) reject(data.error);
            else resolve(data.state);
          };
          post({ type: "pull", id: id });
        });
      },
      listen: function (names, handler) {
        onEvent = handler;
        post({ type: "listen", events: names });
        // 宿主页收到消息即登记；宿主自己的 Tauri listen 何时生效不回报，预览接受这一点窗口
        return Promise.resolve();
      },
    };
  }
})();
