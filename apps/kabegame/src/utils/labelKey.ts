/** 与 Rust `storage::labels::LABEL_KEY_MAX_BYTES` 一致。 */
export const LABEL_KEY_MAX_BYTES = 64;

const LABEL_KEY_RE = /^[A-Za-z0-9_\-() ]+$/;

/**
 * 标签 key 的即时校验：与 Rust `is_label_key` 同规则（`[a-zA-Z0-9_\-() ]+`，
 * 空格不在首尾、不连续，不超过 64 字节）。后端仍会再校验一次，这里只为输入框给出即时反馈。
 */
export function isLabelKey(value: string): boolean {
  // 字符集限定为 ASCII，字符数即字节数
  return (
    value.length > 0 &&
    value.length <= LABEL_KEY_MAX_BYTES &&
    LABEL_KEY_RE.test(value) &&
    value.trim() === value &&
    !value.includes("  ")
  );
}
