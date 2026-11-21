"""换种子的纯函数检查（不连 WPE、不需要 Frida）：python -X utf8 tests/test_seed.py"""

import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from mcp_server.wpe import seed as mseed  # noqa: E402
from mcp_server.wpe.common import WpeError  # noqa: E402

spec = importlib.util.spec_from_file_location("frida_seed", os.path.join(ROOT, "frida_input", "seed.py"))
dseed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dseed)  # frida 在 main() 里才导入


def mt19937_state(seed: int, n: int = 2) -> list[int]:
    x = [seed & 0xFFFFFFFF]
    for i in range(1, n):
        x.append((1812433253 * (x[-1] ^ (x[-1] >> 30)) + i) & 0xFFFFFFFF)
    return x


class SeedTests(unittest.TestCase):
    def test_parse_seed(self):
        self.assertEqual(mseed.parse_seed(1007), 1007)
        self.assertEqual(mseed.parse_seed(0), 0)
        self.assertEqual(mseed.parse_seed(0xFFFFFFFF), 0xFFFFFFFF)
        self.assertEqual(mseed.parse_seed("0x3EF"), 1007)
        self.assertEqual(mseed.parse_seed(" 1007 "), 1007)
        for bad in (-1, 2**32, True, 1.5, "abc", None, [1]):
            with self.assertRaises(WpeError, msg=repr(bad)):
                mseed.parse_seed(bad)

    def test_expected_x1(self):
        # std::mt19937(5489) 的 x[1] 是 1812433253·(5489 ^ (5489 >> 30)) + 1
        self.assertEqual(mseed.expected_x1(5489), mt19937_state(5489)[1])
        self.assertEqual(mseed.expected_x1(5489), 1301868182)
        for seed in (0, 1, 1007, 0x80000000, 0xFFFFFFFF):
            self.assertEqual(mseed.expected_x1(seed), mt19937_state(seed)[1])
            self.assertEqual(dseed.expected_x1(seed), mseed.expected_x1(seed))  # 两份实现一致

    def test_check_hit(self):
        seed = 1007
        good = {"x0": seed, "x1": mseed.expected_x1(seed)}
        self.assertTrue(mseed.check_hit(good, seed))
        self.assertFalse(mseed.check_hit({"x0": seed, "x1": 0}, seed))
        self.assertFalse(mseed.check_hit({"x0": 1, "x1": good["x1"]}, seed))
        self.assertFalse(mseed.check_hit({}, seed))

    def test_driver_hit_event(self):
        seed = 0xFFFFFFFF
        ev = dseed.hit_event({"x0": seed, "x1": dseed.expected_x1(seed), "tid": 5}, seed)
        self.assertTrue(ev["seed_ok"])
        self.assertEqual(ev["event"], "hit")
        self.assertFalse(dseed.hit_event({"x0": seed, "x1": 3}, seed)["seed_ok"])
        self.assertEqual(dseed.u32(-1), 0xFFFFFFFF)

    def test_parse_line(self):
        self.assertEqual(mseed.parse_line('{"event": "armed", "at": "0x1"}\n'), {"event": "armed", "at": "0x1"})
        for bad in ("", "  \n", "not json", "[1]", '{"x": 1}', '{"event": 3}'):
            self.assertIsNone(mseed.parse_line(bad), repr(bad))

    def test_summarize(self):
        seed = 7
        s = mseed.summarize({"tid": 9, "x0": seed, "x1": mseed.expected_x1(seed), "old": 123}, seed)
        self.assertEqual(s, {"value": 7, "tid": 9, "x0": 7, "x1": mseed.expected_x1(7), "ok": True, "old": 123})
        self.assertFalse(mseed.summarize({"x0": 7, "x1": 0}, seed)["ok"])


if __name__ == "__main__":
    unittest.main()
