import type { PathqlQuery, PathqlResults } from "@/services/pathql";
import type { EventTrigger } from "./events";
import { pathqlAllKey } from "./pathqlSource";
import { usePathqlLooker } from "./usePathqlLooker";

/** 一组查询作为一个 key 观察；发请求仍由用户操作与核心事件窗口负责。 */
export function useLookAll<const Qs extends readonly PathqlQuery[]>(opts: {
  queries: () => Qs | null;
  refreshOn: readonly EventTrigger[];
  onResult: (results: PathqlResults<Qs>) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}) {
  const key = () => {
    const queries = opts.queries();
    return queries?.length ? pathqlAllKey(queries) : null;
  };
  const looker = usePathqlLooker({
    kind: "all",
    key,
    refreshOn: opts.refreshOn,
    onResult: (snapshot) => opts.onResult(snapshot.results as PathqlResults<Qs>),
    onError: opts.onError,
  });
  return { ...looker, key };
}
