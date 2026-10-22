import { invoke } from "@/api/rpc";
import type { TotalSnapshot } from "@/services/liveQuery";

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

export function pathqlCount(path: string): Promise<TotalSnapshot> {
  return invoke<TotalSnapshot>("pathql_count", { path });
}

export type PathqlQuery =
  | { kind: "list"; path: string; withCount?: boolean }
  | { kind: "entry"; path: string }
  | { kind: "fetch"; path: string }
  | { kind: "count"; path: string };

export type PathqlResultOf<Q extends PathqlQuery> = Q extends { kind: "list" }
  ? ProviderListChild[]
  : Q extends { kind: "entry" }
    ? ProviderEntry
    : Q extends { kind: "fetch" }
      ? Record<string, unknown>[]
      : number;

export type PathqlResults<Qs extends readonly PathqlQuery[]> = { [I in keyof Qs]: PathqlResultOf<Qs[I]> };

export function pathqlAll<const Qs extends readonly PathqlQuery[]>(queries: Qs): Promise<PathqlResults<Qs>> {
  return invoke<PathqlResults<Qs>>("pathql_all", { queries });
}
