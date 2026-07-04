import { invoke, listen, type UnlistenFn } from "@/api/rpc";

const params = new URLSearchParams(location.search);
const host = params.get("host") ?? "";
const initialUrl = params.get("url") ?? (host ? `https://${host}` : "");

let currentUrl = initialUrl;
let unlistenUrlChanged: UnlistenFn | null = null;

function normalizeNavigateUrl(raw: string): string | null {
    let value = raw.trim();
    if (!value) return null;
    if (!/^[a-zA-Z][-a-zA-Z0-9+.]*:/.test(value)) {
        value = `https://${value}`;
    }
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.href;
    } catch {
        return null;
    }
}

function iconButton(title: string, svg: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.className = "surf-navbar__button";
    button.innerHTML = svg;
    button.addEventListener("click", onClick);
    return button;
}

function markInvalid(input: HTMLInputElement) {
    input.classList.add("surf-navbar__address--invalid");
    window.setTimeout(() => input.classList.remove("surf-navbar__address--invalid"), 900);
}

function setInputUrl(input: HTMLInputElement, url: string) {
    currentUrl = url;
    if (document.activeElement !== input) {
        input.value = url;
    }
}

function mount() {
    const root = document.getElementById("app");
    if (!root) return;

    const style = document.createElement("style");
    style.textContent = `
        :root {
            color-scheme: light dark;
            --kg-surf-bg: #f5f5f7;
            --kg-surf-fg: #1d1d1f;
            --kg-surf-border: #d2d2d7;
            --kg-surf-hover: #e5e5ea;
            --kg-surf-input-bg: rgba(0, 0, 0, 0.06);
            --kg-surf-invalid: #d92d20;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --kg-surf-bg: #1d1d1f;
                --kg-surf-fg: #f5f5f7;
                --kg-surf-border: #3a3a3c;
                --kg-surf-hover: #3a3a3c;
                --kg-surf-input-bg: rgba(255, 255, 255, 0.08);
                --kg-surf-invalid: #ff6b5f;
            }
        }

        .surf-navbar {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 8px;
            border-bottom: 1px solid var(--kg-surf-border);
            background: var(--kg-surf-bg);
            color: var(--kg-surf-fg);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            box-shadow: 0 1px 0 rgba(0, 0, 0, 0.06);
        }

        .surf-navbar__button {
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 32px;
            padding: 0;
            border: none;
            border-radius: 6px;
            background: transparent;
            color: var(--kg-surf-fg);
            cursor: pointer;
            line-height: 0;
            appearance: none;
        }

        .surf-navbar__button:hover {
            background: var(--kg-surf-hover);
        }

        .surf-navbar__button svg {
            width: 18px;
            height: 18px;
            display: block;
            flex: 0 0 18px;
        }

        .surf-navbar__address {
            min-width: 0;
            height: 28px;
            flex: 1 1 auto;
            padding: 0 8px;
            border: 1px solid var(--kg-surf-border);
            border-radius: 6px;
            outline: none;
            background: var(--kg-surf-input-bg);
            color: var(--kg-surf-fg);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
            font-size: 12px;
            line-height: 1.2;
        }

        .surf-navbar__address:focus {
            border-color: #3b82f6;
        }

        .surf-navbar__address--invalid {
            border-color: var(--kg-surf-invalid);
        }
    `;
    document.head.appendChild(style);

    const bar = document.createElement("nav");
    bar.className = "surf-navbar";
    bar.setAttribute("role", "navigation");

    const address = document.createElement("input");
    address.type = "text";
    address.className = "surf-navbar__address";
    address.setAttribute("aria-label", "Address");
    address.autocomplete = "off";
    address.spellcheck = false;
    address.inputMode = "url";
    address.value = currentUrl;

    // invoke 失败时把原因直接显示在地址栏里（导航栏 webview 的 devtools 需经
    // invoke 打开,静默吞错会让故障完全不可见）。
    let errorRestoreTimer: number | null = null;
    const showError = (error: unknown) => {
        const message = String((error as Error)?.message ?? error ?? "unknown error");
        console.error("[surf-navbar]", message);
        address.classList.add("surf-navbar__address--invalid");
        address.value = `⚠ ${message}`;
        if (errorRestoreTimer !== null) window.clearTimeout(errorRestoreTimer);
        errorRestoreTimer = window.setTimeout(() => {
            errorRestoreTimer = null;
            address.classList.remove("surf-navbar__address--invalid");
            if (document.activeElement !== address) address.value = currentUrl;
        }, 3000);
    };
    const runCommand = (cmd: string, args: Record<string, unknown>) => {
        if (!host) return;
        invoke(cmd, args).catch(showError);
    };

    const back = iconButton(
        "Back",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>',
        () => runCommand("surf_go_back", { host }),
    );
    const forward = iconButton(
        "Forward",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>',
        () => runCommand("surf_go_forward", { host }),
    );
    const reload = iconButton(
        "Reload",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><polyline points="21 3 21 9 15 9"></polyline></svg>',
        () => runCommand("surf_reload", { host }),
    );
    const devtools = iconButton(
        "Developer tools",
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>',
        () => runCommand("surf_open_devtools", { host }),
    );

    address.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const url = normalizeNavigateUrl(address.value);
        if (!url) {
            markInvalid(address);
            address.value = currentUrl;
            return;
        }
        currentUrl = url;
        runCommand("surf_navigate", { host, url });
    });
    address.addEventListener("blur", () => {
        address.value = currentUrl;
    });

    bar.append(back, forward, reload, address, devtools);
    root.appendChild(bar);

    listen<string>("surf-url-changed", (event) => {
        if (typeof event.payload === "string" && event.payload) {
            setInputUrl(address, event.payload);
        }
    }).then((unlisten) => {
        unlistenUrlChanged = unlisten;
    }, showError);
}

window.addEventListener("beforeunload", () => {
    if (unlistenUrlChanged) {
        unlistenUrlChanged();
        unlistenUrlChanged = null;
    }
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
    mount();
}
