(function () {
  "use strict";

  const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args || {});
  window.__kb_media_submit__ = (vfsPath, sourceUrl, opts) => {
    const o = typeof opts === "object" && opts !== null ? opts : {};
    return invoke("surf_import_media", {
      path: vfsPath,
      sourceUrl,
      name: o.name ?? undefined,
      metadata: o.metadata ?? undefined,
      pageUrl: o.url ?? undefined,
    });
  };

  function reportErr(error) {
    window.__kabegame_toast?.(String(error && error.message ? error.message : error), "failed");
  }

  // 用于计算下载url所用的名称
  function nameFromUrl(url) {
    try {
      const u = new URL(String(url || ""), location.href);
      if (/^(data|blob):$/i.test(u.protocol)) return "";
      const segment = u.pathname.split("/").filter(Boolean).pop() || "";
      return decodeURIComponent(segment).trim();
    } catch (_) {
      return "";
    }
  }

  // 将title和url名称拼接，用来计算最终所用的名称
  function downloadName(url) {
    const title = String(document.title || "").trim();
    const segment = nameFromUrl(url) || nameFromUrl(location.href);
    if (title && segment) return title + " / " + segment;
    return title || segment || "";
  }

  // 下载选项用 name: downloadName()
  function downloadOptions(url, opts) {
    const out = opts && typeof opts === "object" ? { ...opts } : {};
    if (!out.name) {
      out.name = downloadName(url) || undefined;
    }
    if (!out.url) out.url = location.href;
    return out;
  }

  function archiveKind(name) {
    const lower = String(name || "").toLowerCase();
    if (lower.endsWith(".zip")) return { command: "crawl_archive_zip" };
    if (
      [".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz"].some((extension) =>
        lower.endsWith(extension)
      )
    ) {
      return { command: "crawl_archive_tar" };
    }
    if (lower.endsWith(".7z")) return { command: "crawl_archive_7z" };
    return null;
  }

  async function listFilesRecursive(directory) {
    const entries = await invoke("crawl_fs_read_dir", { path: directory });
    const files = [];
    const base = directory.replace(/\/+$/, "");
    for (const entry of entries) {
      const path = `${base}/${entry.name}`;
      if (entry.isDirectory && !entry.isSymlink) {
        files.push(...(await listFilesRecursive(path)));
      } else if (entry.isFile) {
        files.push({ path, name: entry.name });
      }
    }
    return files;
  }

  // 页面自发原生下载成功后统一导入；压缩包先尝试解压并逐项导入。
  window.__kb_native_download_finished__ = async (payload) => {
    if (!payload.success) {
      window.__kabegame_toast?.(payload.error || "下载失败", "failed");
      return;
    }

    const options = downloadOptions(payload.url, {
      name: payload.name || undefined,
    });
    const archive = archiveKind(payload.name);
    if (!archive) {
      window.__kb_media_submit__(payload.path, payload.url, options).catch(reportErr);
      return;
    }

    try {
      const destDir = payload.path + ".extract";
      await invoke(archive.command, {
        src: payload.path,
        destDir,
        opts: null,
      });
      const files = await listFilesRecursive(destDir);
      const results = await Promise.allSettled(
        files.map((file) =>
          window.__kb_media_submit__(file.path, payload.url, {
            ...options,
            name: file.name,
          })
        ),
      );
      const imported = results.filter((result) => result.status === "fulfilled").length;
      window.__kabegame_toast?.(
        `已导入 ${imported}/${files.length} 项`,
        imported ? "success" : "failed",
      );
      await invoke("crawl_fs_remove", {
        path: destDir,
        options: { recursive: true },
      }).catch(() => {});
      await invoke("crawl_fs_remove", {
        path: payload.path,
        options: { recursive: false },
      }).catch(() => {});
    } catch (_) {
      // 无法解压时按普通文件导入，由后处理给出最终类型错误。
      window.__kb_media_submit__(payload.path, payload.url, options).catch(reportErr);
    }
  };

  function triggerDownload(url, opts) {
    const options = downloadOptions(url, opts);
    if (/^(data|blob):/i.test(String(url || ""))) {
      return window.__kb_media_download__(url, options).catch(reportErr);
    }
    console.log('surf download', url, opts);
    return invoke("surf_download_image", {
      url: String(url),
      name: options.name ?? undefined,
      sourceUrl: options.url ?? undefined,
    })
      .then(() => window.__kabegame_toast?.("已加入下载列表", "start"))
      .catch(reportErr);
  }

  window.__kabegame_surf_triggerDownload = triggerDownload;
})();
