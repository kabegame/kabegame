import { IS_WEB } from "../env";

export function getIsSuper(): boolean {
  if (!IS_WEB) return true;
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("super") === "1";
}
