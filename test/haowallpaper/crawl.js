// haowallpaper WebView 爬虫：基于 pageLabel 的 switch 流程
// 运行环境：闭包内注入的 Kabegame（不挂 window）。功能相似的接口与 V8 后端同名。
// 差异：真实 document（$/$$/waitForSelector）、按页重跑的生命周期、pageState/state
// 需按调用经 invoke 获取（异步方法：await Kabegame.pageLabel()/pageState()/state()）。

/**
 * 在页面内派发一段随机鼠标移动事件（mousemove），可指定次数或时长。
 * @param {Object} opts - 可选
 * @param {number} opts.count - 移动次数，默认 15
 * @param {number} opts.intervalMs - 每次间隔 ms，默认 80
 * @param {HTMLElement|Document} opts.target - 派发目标，默认 document
 */
async function emitRandomMouseMoves(opts = {}) {
  const count = opts.count ?? 15;
  const intervalMs = opts.intervalMs ?? 80;
  const target = opts.target ?? document;
  const doc = target.ownerDocument ?? document;
  const w = doc.documentElement.clientWidth;
  const h = doc.documentElement.clientHeight;
  for (let i = 0; i < count; i++) {
    const x = Math.max(0, Math.min(w, w * 0.2 + Math.random() * w * 0.6));
    const y = Math.max(0, Math.min(h, h * 0.2 + Math.random() * h * 0.6));
    target.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        view: doc.defaultView,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: 0,
      })
    );
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function triggerMouseUp(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0,  // mouseup 时通常为 0
  };
  el.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
}

async function run() {
  const step = await Kabegame.pageLabel();
  const state = await Kabegame.state();
  if (!state.dataCleared) {
    await Kabegame.updateState({ dataCleared: true });
    await Kabegame.clearData();
  }

  switch (step) {
    case "initial":
      // 首次进入（pageLabel 由 Rust 在创建任务时设为 initial）
      await handleInitial();
      break;
    case "posts":
      // 列表页：解析条目，可 to 到详情或下一页
      await handlePosts();
      break;
    case "detail":
      // 详情页：下载图片，再 to 下一项或 exit
      await handleDetail();
      break;
    case "exit":
    default:
      // 脚本结束退出。
      await Kabegame.exit();
  }
}

async function handleInitial() {
  let state = await Kabegame.state();
  const formats = Kabegame.vars?.formats ?? {
    image: true,
    video: true
  };
  if (Object.keys(formats).length === 0) {
    await Kabegame.log("没有勾选任何格式，退出");
    await Kabegame.exit();
    return;
  }

  // 获得开始页面设置，1为默认值
  const startPage = Kabegame.vars?.startPage ?? 1;
  // 执行初始化动作
  if (!state.page) {
    // updateState 返回合并后的 state，直接复用，无需再取一次。
    state = await Kabegame.updateState({ page: startPage, formats, startPage });
    const endPage = Kabegame.vars?.endPage ?? startPage;
    if (endPage >= startPage + 100) {
      throw "在一次之内不允许爬取超过100页，咱二次元人要保持文明礼仪";
    } else if (endPage < startPage) {
      throw "结束页面需要比开始页面大";
    }
  }

  // 获取当前页面
  const page = state.page;

  // 获得结束页面，第一次来到initial可能没有设置
  const endPage = state.endPage;

  if (endPage) {
    if (page > endPage) {
      await Kabegame.exit();
      return;
    }
  }

  // 准备进入下一页
  await Kabegame.updateState({ page: page + 1 });

  const wallpaperType = Kabegame.vars?.wallpaperType?.trim() ?? "";
  await Kabegame.sleep(2000);
  Kabegame.log(`当前页面: ${page}, 种类: ${wallpaperType}, 标签: ${Kabegame.vars?.tags}, 格式: ${Object.keys(Kabegame.vars?.formats)}`);
  await Kabegame.to(`/${wallpaperType}?page=${page}`, {
    pageLabel: "posts",
    pageState: { nth: 1, lastSearched: -1 },
  });
}

async function handlePosts() {
  await Kabegame.waitForDom();
  await Kabegame.sleep(5000);
  let state = await Kabegame.state();

  // 不知道最后一页是多少
  if (state.endPage === undefined) {
    const endPageConfig = Kabegame.vars?.endPage ?? state.startPage;
    let totalPages = NaN;
    try {
      const lastNum = await Kabegame.waitForSelector(".page-content > div:last-of-type", {
        timeout: 20000,
        interval: 500,
      });
      totalPages = parseInt(lastNum.textContent, 10);
    } catch (e) {
      Kabegame.log(`无法获取总页数: ${e?.message ?? e}`);
    }
    if (!Number.isFinite(totalPages)) totalPages = endPageConfig;
    const endPage = Math.min(endPageConfig, totalPages);
    const totalPage = endPage - state.startPage + 1;
    state = await Kabegame.updateState({ endPage, percentPerPage: 100 / totalPage });
    Kabegame.log(`最大页数: ${endPage}，总页数: ${totalPage}`);
  }

  const pageState = await Kabegame.pageState();
  const lastSearched = pageState.lastSearched;
  const nth = pageState.nth;

  const items = Kabegame.$$(".card");

  if (lastSearched === -1) {
    Kabegame.log(`本页图片数量: ${items.length}`);
  }

  for (let i = lastSearched + 1; i < items.length; ++i) {
    const item = items[i];
    const formats = state.formats;
    const wantImage = formats['image'];
    const wantVideo = formats['video'];
    let isImage = false;
    let isVideo = false;

    if (item.querySelector('.resource-container > img')) {
      isImage = true;
      if (wantVideo && !wantImage) {
        Kabegame.log(`${i} 不是视频，跳过`)
        continue;
      }
    } else {
      isVideo = true;
      if (wantImage && !wantVideo) {
        Kabegame.log(`${i} 不是视频，跳过`)
        continue;
      }
    }

    if (!isImage && !isVideo) {
      await Kabegame.exit()
      return;
    }

    const itemTags = Array.from(
      item.querySelectorAll(".labelDiv > span"),
    ).map((span) => span.textContent);

    const wantsTags = (Kabegame.vars?.tags ?? []).map((t) => t.trim());
    let wantDownload = wantsTags.length === 0;
    if (!wantDownload) {
      for (const tag in wantsTags) {
        if (itemTags.some((t) => t.includes(tag))) {
          wantDownload = true;
        }
      }
    }
    if (wantDownload) {
      const percentPerPage = state.percentPerPage;
      await Kabegame.addProgress(percentPerPage * (i - lastSearched) / items.length);


      await Kabegame.updatePageState({ nth: nth + 1, lastSearched: i });
      const button = item.querySelector('.card--button a');
      Kabegame.log(`下载第${nth}个资源 ${button.href}，为${isImage ? '图片' : '视频' }`);
      await Kabegame.to(button.href, { pageLabel: "detail" });
      return;
    }
  }

  await Kabegame.addProgress((items.length - lastSearched) / items.length * state.percentPerPage)
  await Kabegame.back();
  return;
}

async function handleDetail() {
  await Kabegame.waitForDom();
  await emitRandomMouseMoves();
  await Kabegame.sleep(3000);

  const downloadButton = await Kabegame.waitForSelector(".DownButtom", {
    interval: 1000,
    timeout: 30000,
  });
  // 模拟点击
  triggerMouseUp(downloadButton);
  Kabegame.sleep(2000);
  // 模拟点击
  (await Kabegame.waitForSelector('.altcha input')).click();
  for (let i = 0; i < 15; ++i) {
    await emitRandomMouseMoves({ count: 30, intervalMs: 100 });
    const num = Kabegame.$('#progressBar .num').textContent;
    if (num === '100') {
      Kabegame.log(`触发下载: ${location.href}`);
      break;
    }
  }
  await Kabegame.updateState({
    dataCleared: false
  })
  await Kabegame.back();
}

await run();
