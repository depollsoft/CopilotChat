import { describe, expect, it } from "vitest";
import { formatAic, nanoAiuPerAic } from "./index.js";

describe("formatAic", () => {
  it("formats nano-AI units as AI credits", () => {
    expect(formatAic(0)).toBe("0");
    expect(formatAic(1_000_000)).toBe("<0.01");
    expect(formatAic(12_000_000)).toBe("0.01");
    expect(formatAic(430_000_000)).toBe("0.43");
    expect(formatAic(1.5 * nanoAiuPerAic)).toBe("1.5");
    expect(formatAic(2 * nanoAiuPerAic)).toBe("2");
    expect(formatAic(12.34 * nanoAiuPerAic)).toBe("12.3");
    expect(formatAic(150 * nanoAiuPerAic)).toBe("150");
  });
  it("treats missing or invalid usage as zero", () => {
    expect(formatAic(-5)).toBe("0");
    expect(formatAic(Number.NaN)).toBe("0");
  });
});
