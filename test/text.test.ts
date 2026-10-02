import { describe, expect, it } from "vitest";
import { parseAmount, splitDateParts } from "../src/domain/text";

describe("parseAmount（金額文字列 → 整数。曖昧なら null）", () => {
  it.each([
    ["65,320", 65320],
    ["*65,000", 65000],
    ["¥123,456", 123456],
    ["￥１２，３４５", 12345],
    ["300円", 300],
    ["*815", 815],
    ["-1,078", -1078],
    ["0", 0],
  ])("%s → %d", (s, v) => expect(parseAmount(s)).toBe(v));

  it.each(["", "65,32", "6S,320", "65.320", "65,3200", "1,0000", "012", "abc", "65 320円?", "*"])("%s は null（推測しない）", (s) =>
    expect(parseAmount(s)).toBeNull(),
  );
});

describe("splitDateParts", () => {
  it.each([
    ["08.09.24", ["08", "09", "24"]],
    ["08-09-29", ["08", "09", "29"]],
    ["2026/9/28 (月)", ["2026", "9", "28"]],
    ["26年 9月 22日", ["26", "9", "22"]],
  ])("%s", (s, v) => expect(splitDateParts(s)).toEqual(v));
  it("数字が3つでなければ null", () => {
    expect(splitDateParts("9/28")).toBeNull();
    expect(splitDateParts("2026/9/28 01:55")).toBeNull();
  });
});
