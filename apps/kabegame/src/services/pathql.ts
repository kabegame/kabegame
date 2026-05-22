import { invoke } from "@/api/rpc";

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

export function pathqlList(
  path: string,
  withCount = false,
): Promise<ProviderListChild[]> {
  return invoke<ProviderListChild[]>("pathql_list", { path, withCount });
}

export function pathqlFetch<T = Record<string, unknown>>(path: string): Promise<T[]> {
  return invoke<T[]>("pathql_fetch", { path });
}
