import { describe, expect, it } from "vitest";
import { formatAic, formatMemoryContext, nanoAiuPerAic } from "./index.js";

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

describe("formatMemoryContext", () => {
  it("orders, truncates, and reports entries outside the bounded slice", () => {
    const memories = Array.from({ length: 105 }, (_, index) => ({
      id: `memory-${String(index).padStart(3, "0")}`,
      ownerId: "owner",
      projectId: null,
      title: `Memory ${index}`,
      content: `${index}`.repeat(200),
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));

    const context = formatMemoryContext("User memories:", memories, memories.length);

    expect(context.length).toBeLessThanOrEqual(16_000);
    expect(context).toContain("memories omitted");
  });
});
