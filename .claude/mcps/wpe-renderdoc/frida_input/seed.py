"""
给 WPE 下一个新建的场景渲染器换掉 MT19937 的种子（一次性）。由 wpe-renderdoc MCP 经 uv 拉起，也可以手动跑。

原理：渲染器构造函数在 wallpaper64.exe+0x17D6BC 执行 `mov dword ptr [rdi+0x1cd4], edx`，edx 是按时间算出的种子，
之后的递推循环从 edx 接着算 x[1..623]。在这条指令上把 rdx 换成约定种子，整个场景的随机数就是 std::mt19937(种子)。
只改挂钩之后第一个构造的渲染器。读回核对在**同一线程**的循环出口 +0x17D6F3（`lea rdx, [rsp+0x60]`，紧接着才把
下标 `+0x1cd0` 设成 624）当场读 x[0] / x[1]：这时一次数都还没取。不能「命中后过一会儿再读」：带 `starttime` 预热的
场景加载时一口气取几千次，取满 1248 次 x[0] 就被 twist 重写（3465215190 的 Snow 实测 100 ms 后读到的已不是种子）。
核对完直接 os._exit（Frida 随进程退出卸掉脚本与钩子；命中后在 unload / detach 里卡住过一次，所以不调它们）。
桌面壁纸与已经开着的窗口不受影响。两处挂钩前都核对指令字节，对不上就报错不挂。

协议：stdout 一行一个 JSON。
  {"event": "armed", "at": "<地址>", "seed": <u32>}
  {"event": "hit", "tid", "ctx", "old", "x0", "x1", "seed", "expect_x1", "seed_ok"}
  {"event": "error", "message" | "detail"}
退出码：0 = 命中且读回核对通过，1 = 其它。

用法：uv --directory frida_input run python -X utf8 seed.py --pid <WPE pid> --seed <u32> [--timeout 120]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading

RVA = 0x17D6BC
EXPECT = [0x89, 0x97, 0xD4, 0x1C, 0x00, 0x00]  # mov dword ptr [rdi + 0x1cd4], edx
# 初始化循环（`cmp rsi, 0x270; jb`）的出口：x[0..623] 已算完，下一条才把下标设成 624，此前没有取数
LOOP_END_RVA = 0x17D6F3
LOOP_END_EXPECT = [0x48, 0x8D, 0x54, 0x24, 0x60]  # lea rdx, [rsp + 0x60]
MODULE = "wallpaper64.exe"

JS = r"""
const m = Process.getModuleByName('%MODULE%');
const at = m.base.add(%RVA%);
const end = m.base.add(%LOOP_END_RVA%);
const bytes = (p, n) => Array.from(new Uint8Array(p.readByteArray(n)));
const expect = %EXPECT%;
const expectEnd = %LOOP_END_EXPECT%;
const got = bytes(at, expect.length);
const gotEnd = bytes(end, expectEnd.length);
if (got.some((b, i) => b !== expect[i]) || gotEnd.some((b, i) => b !== expectEnd[i])) {
  send({ error: 'bytes', got, gotEnd });
} else {
  let hit = null;
  let reported = false;
  Interceptor.attach(at, {
    onEnter() {
      if (hit) return;
      hit = { tid: this.threadId, ctx: this.context.rdi, old: this.context.rdx.toUInt32() };
      this.context.rdx = ptr('%SEED%');
    }
  });
  // 同一线程、同一个 ctx 走到循环出口时当场读回（这时还没有取数，预热也冲不掉）
  Interceptor.attach(end, {
    onEnter() {
      if (!hit || reported || this.threadId !== hit.tid || !this.context.rdi.equals(hit.ctx)) return;
      reported = true;
      const ctx = hit.ctx;
      send({ hit: { tid: hit.tid, ctx: ctx.toString(), old: hit.old,
                    x0: ctx.add(0x1cd4).readU32(), x1: ctx.add(0x1cd8).readU32() } });
    }
  });
  send({ armed: at.toString() });
}
"""


def u32(value: int) -> int:
    return value & 0xFFFFFFFF


def expected_x1(seed: int) -> int:
    """std::mt19937 初始化的 x[1] = 1812433253 · (x0 ^ (x0 >> 30)) + 1 (mod 2^32)。"""
    seed = u32(seed)
    return u32(1812433253 * (seed ^ (seed >> 30)) + 1)


def hit_event(payload: dict, seed: int) -> dict:
    """agent 的 hit 载荷 → 协议里的 hit 事件（含核对）。"""
    seed = u32(seed)
    x1 = expected_x1(seed)
    ok = payload.get("x0") == seed and payload.get("x1") == x1
    return {"event": "hit", **payload, "seed": seed, "expect_x1": x1, "seed_ok": ok}


def build_source(seed: int) -> str:
    """agent 脚本：填入模块名、两处地址与期望字节、种子。长的占位符先换，免得 `%RVA%` 碰到 `%LOOP_END_RVA%`。"""
    return (JS.replace("%LOOP_END_RVA%", hex(LOOP_END_RVA)).replace("%LOOP_END_EXPECT%", json.dumps(LOOP_END_EXPECT))
            .replace("%MODULE%", MODULE).replace("%RVA%", hex(RVA)).replace("%EXPECT%", json.dumps(EXPECT))
            .replace("%SEED%", hex(u32(seed))))


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    import frida  # 延迟导入：纯函数部分不需要 Frida，测试可以直接导入本文件

    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--seed", type=lambda s: int(s, 0), required=True)
    ap.add_argument("--timeout", type=float, default=120.0)
    args = ap.parse_args()
    seed = u32(args.seed)

    session = frida.attach(args.pid)
    done = threading.Event()
    status = {"code": 1}

    def finish(obj: dict, code: int) -> None:
        emit(obj)
        status["code"] = code
        done.set()

    def on_message(message, data):
        if message.get("type") == "send":
            payload = message.get("payload") or {}
            if "error" in payload:
                finish({"event": "error", "message": "挂钩前的字节核对失败，不挂（WPE 版本变了？）", "detail": payload}, 1)
            elif "armed" in payload:
                emit({"event": "armed", "at": payload["armed"], "seed": seed})
            elif "hit" in payload:
                event = hit_event(payload["hit"], seed)
                finish(event, 0 if event["seed_ok"] else 1)
        elif message.get("type") == "error":
            finish({"event": "error", "message": message.get("description", str(message))}, 1)

    script = session.create_script(build_source(seed))
    script.on("message", on_message)
    script.load()
    if not done.wait(args.timeout):
        emit({"event": "error", "message": f"{args.timeout:g} s 内没有新建场景渲染器"})
        os._exit(1)
    # 不 unload / detach：进程一退出 Frida 的 agent 就卸掉脚本与钩子
    os._exit(status["code"])


if __name__ == "__main__":
    sys.exit(main())
