import { readFile as tauriReadFile } from "@tauri-apps/plugin-fs";
import { IS_LINUX } from "../env";
import { invoke } from "@tauri-apps/api/core";

// linux tauri workaround
export const readFile: typeof tauriReadFile = !IS_LINUX ? tauriReadFile : async (path, _options) => {
  return invoke('read_file', {
    path: path,
  })
}
