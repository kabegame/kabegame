import { open } from "@tauri-apps/plugin-dialog";
import { IS_WEB } from "@kabegame/core/env";

export interface FilePickerOptions {
  directory?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

export interface FilePickerResult {
  paths?: string[];
  files?: File[];
}

export async function openFilePicker(opts: FilePickerOptions = {}): Promise<FilePickerResult | null> {
  if (IS_WEB) {
    return openWebPicker(opts);
  }
  const selected = await open({
    directory: opts.directory ?? false,
    multiple: opts.multiple ?? false,
    filters: opts.filters,
  });
  if (!selected) return null;
  const paths = Array.isArray(selected) ? selected : [selected];
  return { paths };
}

function openWebPicker(opts: FilePickerOptions): Promise<FilePickerResult | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (opts.multiple) input.multiple = true;
    if (opts.directory) {
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    } else if (opts.filters && opts.filters.length > 0) {
      input.accept = opts.filters
        .flatMap((f) => f.extensions.map((ext) => `.${ext.replace(/^\./, "")}`))
        .join(",");
    }
    input.style.display = "none";
    let settled = false;
    input.addEventListener("change", () => {
      if (settled) return;
      settled = true;
      const files = input.files ? Array.from(input.files) : [];
      document.body.removeChild(input);
      resolve(files.length > 0 ? { files } : null);
    });
    input.addEventListener("cancel", () => {
      if (settled) return;
      settled = true;
      document.body.removeChild(input);
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}
