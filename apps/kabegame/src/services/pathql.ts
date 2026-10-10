import { invoke } from "@/api/rpc";
import type { RowsSnapshot, TotalSnapshot } from "@/services/liveQuery";

export interface ProviderNote {
  title: string;
  content: string;
}

export interface ProviderEntry {
  name: string;
  meta: unknown | null;
  note: ProviderNote | null;
  total: number | null;
}

export interface ProviderListChild {
  name: string;
  meta: unknown | null;
  total: number | null;
}

export function pathqlEntry(path: string): Promise<ProviderEntry> {
  return invoke<ProviderEntry>("pathql_entry", { path });
}

export function pathqlList(path: string, withCount = false): Promise<ProviderListChild[]> {
  return invoke<ProviderListChild[]>("pathql_list", { path, withCount });
}

export function pathqlFetch<T = Record<string, unknown>>(path: string): Promise<T[]> {
  return invoke<T[]>("pathql_fetch", { path });
}

export function pathqlView(path: string): Promise<RowsSnapshot> {
  return invoke<RowsSnapshot>("pathql_view", { path });
}

export function pathqlCount(path: string): Promise<TotalSnapshot> {
  return invoke<TotalSnapshot>("pathql_count", { path });
}
