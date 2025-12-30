// 轻量级版本比较（不依赖 semver 包）
// - 支持：1.2.3 / v1.2 / 1.2.3-beta.1
// - 规则：先比较主版本号数组（缺省补 0），再比较预发布（无预发布 > 有预发布）

type ParsedVersion = {
  nums: number[];
  pre: string | null;
};

const parseVersion = (input: string): ParsedVersion => {
  const raw = (input || "").trim();
  const v = raw.startsWith("v") || raw.startsWith("V") ? raw.slice(1) : raw;
  // 拆分主版本与预发布：1.2.3-beta.1 => main=1.2.3, pre=beta.1
  const [main, preRaw] = v.split("-", 2);
  const nums = (main || "")
    .split(".")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : 0;
    });
  return { nums: nums.length ? nums : [0], pre: preRaw ? preRaw.trim() : null };
};

// 返回：1 表示 a > b，0 表示相等，-1 表示 a < b
export const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  // 主版本一致：比较预发布（无预发布 > 有预发布）
  if (pa.pre === pb.pre) return 0;
  if (pa.pre == null && pb.pre != null) return 1;
  if (pa.pre != null && pb.pre == null) return -1;

  // 两者都有预发布：做一个稳定的字典序比较（足够用于“是否可更新”）
  return String(pa.pre).localeCompare(String(pb.pre));
};

export const isUpdateAvailable = (installedVersion: string | null | undefined, storeVersion: string): boolean => {
  if (!installedVersion) return false;
  // 只有商店版本更高才算“可更新”
  return compareVersions(storeVersion, installedVersion) > 0;
};


