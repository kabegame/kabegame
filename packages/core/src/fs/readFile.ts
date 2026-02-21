import { readFile as tauriReadFile } from "@tauri-apps/plugin-fs";
import { IS_LINUX, IS_ANDROID } from "../env";
import { invoke } from "@tauri-apps/api/core";

// linux tauri workaround; android 下 content:// 需走自定义 read_file 命令
export const readFile: typeof tauriReadFile =
  !IS_LINUX && !IS_ANDROID
    ? tauriReadFile
    : async (path, _options) => {
        return invoke("read_file", { path });
      };
