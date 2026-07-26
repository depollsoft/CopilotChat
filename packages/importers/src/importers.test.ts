import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { previewImport, previewImportPayload } from "./index.js";

describe("previewImport", () => {
  it("parses ChatGPT conversations", () => {
    const preview = previewImport("chatgpt", "conversations.json", JSON.stringify([{ id: "chat-1", title: "Hello", current_node: "b", mapping: { a: { message: { author: { role: "user" }, content: { parts: ["Hi"] }, create_time: 1, metadata: {} } }, b: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["Hello!"] }, create_time: 2, metadata: {} } } } }]));
    expect(preview.conversations[0]?.messages).toHaveLength(2);
  });
  it("parses Claude conversations", () => {
    const preview = previewImport("claude", "claude.json", JSON.stringify([{ uuid: "claude-1", name: "Claude chat", chat_messages: [{ sender: "human", text: "Question" }] }]));
    expect(preview.conversations[0]?.messages[0]?.content).toBe("Question");
  });
  it("preserves Claude thinking, tool use, and file references", () => {
    const preview = previewImport("claude", "conversations.json", JSON.stringify([{ uuid: "claude-1", name: "Claude chat", chat_messages: [
      { uuid: "m1", sender: "human", text: "Review this", created_at: "2026-01-01T00:00:00Z", files: [{ file_uuid: "file-1", file_name: "notes.pdf" }] },
      { uuid: "m2", sender: "assistant", text: "Done", content: [
        { type: "thinking", thinking: "I should inspect the file." },
        { type: "tool_use", id: "tool-1", name: "search", input: { query: "notes" } },
        { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "Found notes" }], is_error: false },
        { type: "text", text: "Done" },
      ] },
    ] }]));
    const messages = preview.conversations[0]?.messages ?? [];
    expect(messages[0]?.content).toContain("notes.pdf");
    expect(messages[1]?.metadata.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", content: "I should inspect the file." }),
      expect.objectContaining({ type: "tool", title: "search", status: "succeeded" }),
    ]));
  });
  it("parses Claude ZIP projects, memories, and conversations", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify([{ uuid: "chat-1", name: "Research chat", chat_messages: [{ uuid: "m1", sender: "human", text: "Question about the Research project" }] }]));
    zip.file("projects/project-1.json", JSON.stringify({ uuid: "project-1", name: "Research", description: "Project notes", prompt_template: "Use project instructions.", docs: [{ uuid: "doc-1", filename: "Brief.md", content: "# Brief" }] }));
    zip.file("memories.json", JSON.stringify([{ conversations_memory: "Remember imported context." }]));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    const preview = await previewImportPayload("auto", "claude-export.zip", bytes, "base64");

    expect(preview.source).toBe("claude");
    expect(preview.conversations).toHaveLength(1);
    expect(preview.conversations[0]?.projectSourceId).toBe("project-1");
    expect(preview.projects.map((project) => project.name)).toEqual(expect.arrayContaining(["Research", "Claude memory"]));
    expect(preview.projects.find((project) => project.name === "Research")?.references[0]).toMatchObject({ title: "Brief.md", content: "# Brief" });
    expect(preview.projects.find((project) => project.name === "Research")?.memory).toContain("Remember imported context.");
    expect(preview.projects.find((project) => project.name === "Research")?.references.some((reference) => reference.title.includes("Claude memory"))).toBe(true);
    expect(preview.projects.find((project) => project.name === "Claude memory")?.memory).toContain("Remember imported context.");
    expect(preview.warnings.some((warning) => warning.includes("project-name/path inference"))).toBe(true);
  });
  it("infers Claude ZIP projects from project-derived phrases", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify([{ uuid: "chat-1", name: "Investigate chargebacks", chat_messages: [{ uuid: "m1", sender: "human", text: "How should we handle payment reconciliation for chargeback disputes?" }] }]));
    zip.file("projects/project-1.json", JSON.stringify({ uuid: "project-1", name: "Payments", description: "Payment reconciliation and chargeback dispute tracking.", prompt_template: "Help with billing workflows.", docs: [] }));
    const content = Buffer.from(await zip.generateAsync({ type: "uint8array" })).toString("base64");

    const preview = await previewImportPayload("auto", "claude-export.zip", content, "base64");

    expect(preview.conversations[0]?.projectSourceId).toBe("project-1");
    expect(preview.conversations[0]?.metadata.inferredProject).toMatchObject({ name: "Payments" });
  });
  it("rejects ZIP archives above the entry-count limit", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", "[]");
    zip.file("memories.json", "[]");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(previewImportPayload("auto", "claude-export.zip", bytes, "base64", { archiveEntryLimit: 1 })).rejects.toThrow("too many files");
  });
  it("ignores EOCD signatures embedded in ZIP comments", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", "[]");
    zip.file("memories.json", "[]");
    const bytes = forgeEocdInComment(await zip.generateAsync({ type: "uint8array", comment: "\0".repeat(22) }), 1);

    await expect(previewImportPayload("auto", "claude-export.zip", bytes, "base64", { archiveEntryLimit: 1 })).rejects.toThrow("too many files");
  });
  it("counts actual central-directory records instead of trusting EOCD totals", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", "[]");
    zip.file("memories.json", "[]");
    const bytes = forgeDeclaredEntryCount(await zip.generateAsync({ type: "uint8array" }), 1);

    await expect(previewImportPayload("auto", "claude-export.zip", bytes, "base64", { archiveEntryLimit: 1 })).rejects.toThrow("too many files");
  });
  it("rejects ZIP archives above the aggregate expansion limit", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify([{ padding: "x".repeat(80) }]));
    zip.file("memories.json", JSON.stringify([{ padding: "y".repeat(80) }]));
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(previewImportPayload("auto", "claude-export.zip", bytes, "base64", { archiveUncompressedLimit: 100 })).rejects.toThrow("expands beyond");
  });
  it("enforces the runtime expansion limit when ZIP metadata understates the size", async () => {
    const zip = new JSZip();
    zip.file("conversations.json", "x".repeat(1024));
    const bytes = forgeCentralUncompressedSize(await zip.generateAsync({ type: "uint8array" }), 1);

    await expect(previewImportPayload("auto", "claude-export.zip", bytes, "base64", { archiveUncompressedLimit: 64 })).rejects.toThrow("expands beyond");
  });
});

function forgeCentralUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const buffer = Buffer.from(bytes);
  for (let offset = 0; offset <= buffer.length - 46; offset += 1) {
    if (buffer.readUInt32LE(offset) === 0x02014b50) buffer.writeUInt32LE(size, offset + 24);
  }
  return Uint8Array.from(buffer);
}

function forgeEocdInComment(bytes: Uint8Array, entries: number): Uint8Array {
  const buffer = Buffer.from(bytes);
  const offset = buffer.length - 22;
  buffer.writeUInt32LE(0x06054b50, offset);
  buffer.writeUInt16LE(entries, offset + 8);
  buffer.writeUInt16LE(entries, offset + 10);
  buffer.writeUInt16LE(0, offset + 20);
  return Uint8Array.from(buffer);
}

function forgeDeclaredEntryCount(bytes: Uint8Array, entries: number): Uint8Array {
  const buffer = Buffer.from(bytes);
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + buffer.readUInt16LE(offset + 20) !== buffer.length) continue;
    buffer.writeUInt16LE(entries, offset + 8);
    buffer.writeUInt16LE(entries, offset + 10);
    return Uint8Array.from(buffer);
  }
  throw new Error("EOCD not found.");
}
