import { IS_WEB } from "../env";
import * as tauri from "./tauri";
import * as web from "./web";

export type UnlistenFn = tauri.UnlistenFn;

export const invoke = IS_WEB ? web.invoke : tauri.invoke;
export const listen = IS_WEB ? web.listen : tauri.listen;
export const emit = IS_WEB ? web.emit : tauri.emit;

export { uploadImport } from "./web";
export type { ImportUploadParams, ImportUploadResult } from "./web";
