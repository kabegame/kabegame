// TypeScript surface for tauri-plugin-wemt.
import { invoke } from "@tauri-apps/api/core";

export type MountState = "detached" | "attached" | "hostLost" | "failed";

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MonitorInfo {
  index: number;
  primary: boolean;
  rect: Rect;
}

export interface AttachOptions {
  /** Zero-based monitor index; omit to use the monitor containing the host. */
  monitor?: number;
  /** Show the worker host after mounting (default true). */
  showHost?: boolean;
}

export interface AttachReport {
  windowHwnd: number;
  hostHwnd: number;
  monitor: MonitorInfo;
  targetRect: Rect;
  style: number;
  exStyle: number;
}

export interface MountStatus {
  state: MountState;
  windowHwnd: number;
  hostHwnd: number | null;
  monitor: MonitorInfo | null;
  targetRect: Rect | null;
  message: string | null;
}

export async function attach(options?: AttachOptions): Promise<AttachReport> {
  return invoke("plugin:wemt|wemt_attach", { options });
}

export async function detach(): Promise<MountStatus> {
  return invoke("plugin:wemt|wemt_detach");
}

export async function status(): Promise<MountStatus> {
  return invoke("plugin:wemt|wemt_status");
}

export async function refresh(options?: AttachOptions): Promise<AttachReport> {
  return invoke("plugin:wemt|wemt_refresh", { options });
}
