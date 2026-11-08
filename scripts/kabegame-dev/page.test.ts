import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { remoteText } from "./page.ts";

describe("控制台参数转文本", () => {
  test("字符串、数字、对象预览、数组预览、无预览", () => {
    assert.equal(remoteText({ type: "string", value: "你好" }), "你好");
    assert.equal(remoteText({ type: "number", value: 42 }), "42");
    assert.equal(remoteText({ type: "number", unserializableValue: "NaN", description: "NaN" }), "NaN");
    assert.equal(
      remoteText({
        type: "object",
        description: "Object",
        preview: {
          properties: [
            { name: "a", type: "number", value: "1" },
            { name: "b", type: "string", value: "x" },
          ],
        },
      }),
      '{a: 1, b: "x"}',
    );
    assert.equal(
      remoteText({
        type: "object",
        subtype: "array",
        description: "Array(3)",
        preview: {
          subtype: "array",
          overflow: true,
          properties: [
            { name: "0", type: "number", value: "1" },
            { name: "1", type: "number", value: "2" },
          ],
        },
      }),
      "[1, 2, …]",
    );
    assert.equal(remoteText({ type: "function", description: "function f() {}" }), "function f() {}");
  });
});
