import { describe, expect, it } from "vitest";
import { formatAic, formatMemoryContext, nanoAiuPerAic, titleFromContent } from "./index.js";

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

describe("titleFromContent", () => {
  it("strips markdown so derived chat titles read as plain text", () => {
    expect(titleFromContent("Show me a **markdown** sample")).toBe("Show me a markdown sample");
    expect(titleFromContent("## Plan the _next_ release")).toBe("Plan the next release");
    expect(titleFromContent("- Fix `parseArgs` in the CLI")).toBe("Fix parseArgs in the CLI");
    expect(titleFromContent("Read [the guide](https://example.com) first")).toBe("Read the guide first");
    expect(titleFromContent("~~Drop~~ Keep the cache")).toBe("Drop Keep the cache");
  });
  it("falls back when a message carries no prose", () => {
    expect(titleFromContent("```ts\nconst a = 1;\n```")).toBe("New chat");
    expect(titleFromContent("   ")).toBe("New chat");
  });
  it("keeps the six-word bound", () => {
    expect(titleFromContent("one two three four five six seven eight")).toBe("one two three four five six");
  });
  it("leaves developer identifiers intact", () => {
    expect(titleFromContent("Why does my_var_name crash?")).toBe("Why does my_var_name crash?");
    expect(titleFromContent("What is __init__ for?")).toBe("What is __init__ for?");
    expect(titleFromContent("Open _file_name.txt")).toBe("Open _file_name.txt");
    expect(titleFromContent("value is 5_000_000")).toBe("value is 5_000_000");
    expect(titleFromContent("Fix snake_case in the parser")).toBe("Fix snake_case in the parser");
  });
  it("still strips genuine underscore emphasis", () => {
    expect(titleFromContent("Plan the _next_ release")).toBe("Plan the next release");
    expect(titleFromContent("__really important__ fix")).toBe("really important fix");
  });
  it("stays fast on adversarial input", () => {
    const started = Date.now();
    titleFromContent("[".repeat(80_000) + "]x");
    titleFromContent("*".repeat(80_000));
    titleFromContent("`".repeat(80_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
