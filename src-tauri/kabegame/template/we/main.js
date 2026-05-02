// 由 Kabegame 导出生成
(function() {
  'use strict';

  const CONFIG = __CONFIG_JSON__;
  const IMAGES = __IMAGES_JSON__;

  function clampPositiveInt(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }

  // 把过渡时长也导出成 CSS 变量，方便用户在 WE 里二次调（在 DOM 加载前就可以设置）
  if (document.documentElement) {
    document.documentElement.style.setProperty("--kabegame-fade-ms", `${clampPositiveInt(CONFIG.fadeMs || 800, 800)}ms`);
    document.documentElement.style.setProperty("--kabegame-slide-ms", `${clampPositiveInt(CONFIG.slideMs || 800, 800)}ms`);
    document.documentElement.style.setProperty("--kabegame-zoom-ms", `${clampPositiveInt(CONFIG.zoomMs || 900, 900)}ms`);
  }

  function init() {
    // 确保 DOM 已加载
    const baseImg = document.getElementById("baseImg");
    const topImg = document.getElementById("topImg");
    const baseTile = document.getElementById("baseTile");
    const topTile = document.getElementById("topTile");

    // 安全检查：如果元素不存在，直接返回（避免崩溃）
    if (!baseImg || !topImg || !baseTile || !topTile) {
      console.error("Wallpaper: Required DOM elements not found");
      return;
    }

    const intervalMs = clampPositiveInt(CONFIG.intervalMs, 60000);
    const transition = (CONFIG.transition || "fade").toLowerCase();
    const style = (CONFIG.style || "fill").toLowerCase();
    const order = (CONFIG.order || "random").toLowerCase();

    function applyStyle() {
      // tile 模式：使用 background-repeat
      const isTile = style === "tile";
      baseImg.style.display = isTile ? "none" : "block";
      topImg.style.display = isTile ? "none" : "block";
      baseTile.style.display = isTile ? "block" : "none";
      topTile.style.display = isTile ? "block" : "none";

      // img 模式：使用 object-fit
      const fit = style === "fit" ? "contain"
        : style === "stretch" ? "fill"
        : "cover"; // fill/center 默认 cover

      baseImg.style.objectFit = fit;
      topImg.style.objectFit = fit;
      baseImg.style.objectPosition = "center center";
      topImg.style.objectPosition = "center center";

      // center：不拉伸，保持原比例，但居中展示（object-fit: none）
      if (style === "center") {
        baseImg.style.objectFit = "none";
        topImg.style.objectFit = "none";
      }
    }

    function setBase(url) {
      if (style === "tile") {
        baseTile.style.backgroundImage = `url("${url}")`;
        baseTile.style.backgroundRepeat = "repeat";
        baseTile.style.backgroundPosition = "0 0";
        baseTile.style.backgroundSize = "auto";
      } else {
        baseImg.src = url;
      }
    }

    function setTop(url) {
      if (style === "tile") {
        topTile.style.backgroundImage = `url("${url}")`;
        topTile.style.backgroundRepeat = "repeat";
        topTile.style.backgroundPosition = "0 0";
        topTile.style.backgroundSize = "auto";
      } else {
        topImg.src = url;
      }
    }

    function resetTopClasses() {
      topImg.className = "wallpaper-img top";
      topTile.className = "wallpaper-tile top";
    }

    function applyTransitionPrep() {
      resetTopClasses();
      if (transition === "none") return;
      if (style === "tile") {
        topTile.classList.add("top", transition, "prep");
      } else {
        topImg.classList.add("top", transition, "prep");
      }
    }

    function applyTransitionEnter() {
      if (transition === "none") return;
      if (style === "tile") {
        topTile.classList.remove("prep");
        topTile.classList.add("enter");
      } else {
        topImg.classList.remove("prep");
        topImg.classList.add("enter");
      }
    }

    function commitTopToBase() {
      // 把 top 变成 base
      if (style === "tile") {
        baseTile.style.backgroundImage = topTile.style.backgroundImage;
        topTile.style.backgroundImage = "";
      } else {
        baseImg.src = topImg.src;
        topImg.src = "";
      }
      resetTopClasses();
    }

    function buildSequence(images) {
      if (order === "sequential") return images.slice();
      // random：简单洗牌，循环用
      const arr = images.slice();
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    let seq = buildSequence(IMAGES);
    let idx = 0;
    let started = false;

    function nextUrl() {
      if (seq.length === 0) return "";
      const url = seq[idx % seq.length];
      idx++;
      if (order !== "sequential" && idx % seq.length === 0) {
        // random 每轮重新洗牌一次
        seq = buildSequence(IMAGES);
        idx = 0;
      }
      return url;
    }

    function tick() {
      if (IMAGES.length === 0) return;
      if (!started) {
        applyStyle();
        setBase(nextUrl());
        started = true;
        setTimeout(tick, intervalMs);
        return;
      }

      const url = nextUrl();
      if (!url) return;

      // prepare
      applyTransitionPrep();
      setTop(url);

      // force reflow
      void (style === "tile" ? topTile.offsetHeight : topImg.offsetHeight);

      // enter
      applyTransitionEnter();

      const target = style === "tile" ? topTile : topImg;
      if (transition === "none") {
        commitTopToBase();
      } else {
        const onEnd = (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.propertyName !== "opacity") return;
          target.removeEventListener("transitionend", onEnd);
          commitTopToBase();
        };
        target.addEventListener("transitionend", onEnd);
        // guard：避免某些情况下 transitionend 丢失
        setTimeout(() => {
          target.removeEventListener("transitionend", onEnd);
          commitTopToBase();
        }, Math.max(1400, intervalMs / 3));
      }

      setTimeout(tick, intervalMs);
    }

    tick();
  }

  // 等待 DOM 加载完成
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // DOM 已加载，直接执行
    init();
  }
})();
