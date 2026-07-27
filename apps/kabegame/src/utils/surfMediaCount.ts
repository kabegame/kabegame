import { pathqlEntry } from "@/services/pathql";
import { withGalleryPrefix } from "@/utils/path";

export function buildGallerySurfPath(host: string, hide: boolean): string {
  const prefix = hide ? "hide/" : "";
  return `${prefix}surf/${encodeURIComponent(host)}`;
}

export async function fetchSurfImageCount(host: string, hide: boolean): Promise<number> {
  const res = await pathqlEntry(withGalleryPrefix(buildGallerySurfPath(host, hide)));
  const total = res?.total;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(0, total) : 0;
}

export async function fetchSurfImageCounts(
  hosts: Iterable<string>,
  hide: boolean,
): Promise<Record<string, number>> {
  const uniqueHosts = Array.from(new Set(Array.from(hosts).filter(Boolean)));
  const pairs = await Promise.all(
    uniqueHosts.map(
      async (host) => {
        try {
          return [host, await fetchSurfImageCount(host, hide)] as const;
        } catch (error) {
          console.warn("fetch surf image count failed:", host, error);
          return [host, 0] as const;
        }
      },
    ),
  );
  return Object.fromEntries(pairs);
}
