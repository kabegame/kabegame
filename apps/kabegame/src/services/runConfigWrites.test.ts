import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/api";
import { writeRunConfig } from "./runConfigWrites";

vi.mock("@/api", () => ({ invoke: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("运行配置写命令", () => {
  it.each(["add_run_config", "update_run_config", "copy_run_config", "delete_run_config"] as const)(
    "%s 只传业务参数，直接返回配置行或 null",
    async (method) => {
      const params =
        method === "add_run_config" || method === "update_run_config"
          ? { config: { id: "a", name: "配置" } }
          : { configId: "a" };
      const config = method === "delete_run_config" ? null : { id: "a", name: "已保存配置" };
      vi.mocked(invoke).mockResolvedValueOnce(config);
      expect(await writeRunConfig(method, params)).toEqual(config);
      expect(invoke).toHaveBeenCalledExactlyOnceWith(method, params);
      expect(vi.mocked(invoke).mock.calls[0][1]).not.toHaveProperty("view");
    },
  );
});
