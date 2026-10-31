// WPE 网页壁纸运行时垫片：all-frames 初始化脚本，桌面壁纸窗口与主窗口共用。
// 只在一种文档里启用：顶层的直接子 frame、且是 file:（WallpaperStage web 层的网页壁纸 iframe，图库预览与
// 桌面同一份）。其它文档（应用页、更深的嵌套 iframe）第一行就返回，不定义任何全局。
// 协议见 cocs/wpe/WPE_IMPORT.md「运行时垫片与宿主协议」：垫片向宿主拉取完整状态、订阅事件后重拉，
// 宿主不推状态；什么时候回调页面、回调哪些键，全由这里决定。
(function () {
  "use strict";
  var direct = window !== window.top && window.parent === window.top && location.protocol === "file:";
  // CEF 给每个子 frame 都注入了 Tauri 的 IPC 桥；能调什么由 ACL（wpe-web-capability，frames: sub）决定
  var internals = window.__TAURI_INTERNALS__;
  if (!direct || !internals || window.__kbWpeShim) return;
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
  var randomQueue = [];
  window.wallpaperRequestRandomFileForProperty = function (key, cb) {
    if (typeof cb !== "function") return;
    if (!latest) return void randomQueue.push([key, cb]);
    answerRandom(key, cb);
  };
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
  function call(name) {
    var target = listener;
    if (target && typeof target[name] === "function") {
      try {
        target[name].apply(target, Array.prototype.slice.call(arguments, 1));
      } catch (error) {
        console.error("[kb-wpe] " + name, error);
      }
    }
  }
  function fetchallFiles(dirs, key) {
    var dir = dirs && dirs[key];
    return dir && dir.mode !== "ondemand" ? dir.files : [];
  }
  function deliverDirectories(prev, next) {
    var keys = {};
    Object.keys(prev || {})
      .concat(Object.keys(next || {}))
      .forEach(function (key) {
        keys[key] = true;
      });
    Object.keys(keys).forEach(function (key) {
      var before = new Set(fetchallFiles(prev, key));
      var after = fetchallFiles(next, key);
      var afterSet = new Set(after);
      var removed = Array.from(before).filter(function (file) {
        return !afterSet.has(file);
      });
      var added = after.filter(function (file) {
        return !before.has(file);
      });
      if (removed.length) call("userDirectoryFilesRemoved", key, removed);
      if (added.length) call("userDirectoryFilesAddedOrChanged", key, added);
    });
  }
  function answerRandom(key, cb) {
    var dir = latest.directories && latest.directories[key];
    var files = dir ? dir.files : [];
    if (!files.length) return;
    var file = files[Math.floor(Math.random() * files.length)];
    setTimeout(function () {
      try {
        cb(key, file);
      } catch (error) {
        console.error("[kb-wpe] random file", error);
      }
    }, 0);
  }
  function deliverFull(state) {
    call("applyUserProperties", clone(state.user));
    call("applyGeneralProperties", clone(state.general));
    deliverDirectories(null, state.directories);
    delivered = state;
  }
  function changedUser(prev, next) {
    var out = null;
    Object.keys(next).forEach(function (key) {
      if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
        (out || (out = {}))[key] = clone(next[key]);
      }
    });
    // 无默认值的 file / directory 重置后键会消失；页面仍需收到空路径以撤销旧选择。
    Object.keys(prev).forEach(function (key) {
      if (!(key in next) && (prev[key].type === "file" || prev[key].type === "directory")) {
        (out || (out = {}))[key] = { type: prev[key].type, value: "" };
      }
    });
    return out;
  }
  function receive(next) {
    latest = next;
    randomQueue.splice(0).forEach(function (request) {
      answerRandom(request[0], request[1]);
    });
    // load 之前只记下来，不提前回调（为 WPE 写的页面默认回调时 DOM 已就绪）
    if (!loaded) return;
    if (!delivered) return deliverFull(next);
    // WPE 没有整份替换的接口：只推值变化的键；作者删掉的键页面无从撤销，不推
    var changed = changedUser(delivered.user, next.user);
    if (changed) call("applyUserProperties", changed);
    if (JSON.stringify(delivered.general) !== JSON.stringify(next.general)) {
      call("applyGeneralProperties", clone(next.general));
    }
    deliverDirectories(delivered.directories, next.directories);
    delivered = next;
  }
  window.addEventListener("load", function () {
    loaded = true;
    if (latest && !delivered) deliverFull(latest);
  });

  // ---- 传输：iframe 自己直接 invoke / listen，事件只投递到本 frame ----
  // 权限只来自 wpe-web-capability（listen 只放行 wallpaper-ping / setting-change / image-changed /
  // images-change，新增监听要同步改 capability）。来源由 CEF 补丁 0007 在建工厂时确定，首批请求即可用，不做重试。
  var transport = {
    pull: function () {
      return internals.invoke("wpe_web_pull_state");
    },
    listen: function (names, onEvent) {
      return Promise.all(
        names.map(function (name) {
          var handler = internals.transformCallback(function (event) {
            onEvent({ name: name, payload: event.payload });
          });
          return internals.invoke("plugin:event|listen", { event: name, handler: handler });
        }),
      );
    },
  };

  // ---- ping 应答：后端每 10s 向壁纸窗口发一次 ping，连续 3 次不应答会整页重载 ----
  // 只应答本窗口：预览在主窗口里，metadata 的 label 是 main，过滤掉。网页壁纸显示期间壁纸窗口的应用页
  // 不应答，交给这里——页面卡死就不应答，照样触发重载。
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
})();
