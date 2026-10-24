import { invoke } from "@/api";

/** 写操作只返回保存后的配置；观察方通过后端事件刷新。 */
export async function writeRunConfig(
  method: "add_run_config" | "update_run_config" | "delete_run_config" | "copy_run_config",
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown> | null>(method, params);
}
