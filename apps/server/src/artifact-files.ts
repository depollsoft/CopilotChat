import fs from "node:fs";
import path from "node:path";
import type { ArtifactKind, Chat } from "@copilotchat/shared";
import type { AppDatabase } from "./db.js";
import { assertNoSymlink, isPathInside } from "./path-guards.js";

const artifactDirName = "artifacts";
const maxArtifactExtensionLength = 32;

export interface FileArtifactInput { title: string; kind: ArtifactKind; content: string; language?: string | null }

export async function writeFileArtifact(input: { db: AppDatabase; ownerId: string; chat: Chat; messageId: string | null; workspaceDir: string; artifact: FileArtifactInput }): Promise<{ artifact: ReturnType<AppDatabase["upsertArtifactFile"]>; relativePath: string }> {
  const fileName = artifactFileName(input.artifact);
  if (path.basename(fileName) !== fileName) throw new Error("Artifact file name must not include path separators.");
  await fs.promises.mkdir(input.workspaceDir, { recursive: true });
  const workspaceDir = await fs.promises.realpath(input.workspaceDir);
  const artifactDir = path.resolve(workspaceDir, artifactDirName);
  const filePath = path.resolve(artifactDir, fileName);
  if (!isPathInside(artifactDir, filePath)) throw new Error("Artifact file path must stay inside the workspace artifacts directory.");
  const relativePath = path.join(artifactDirName, fileName);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await writeExistingArtifactFile({ workspaceDir, filePath, content: input.artifact.content });
  const artifact = input.db.upsertArtifactFile(input.ownerId, { chatId: input.chat.id, projectId: input.chat.projectId, messageId: input.messageId, filePath, title: input.artifact.title, kind: input.artifact.kind, language: input.artifact.language ?? null, content: input.artifact.content });
  return { artifact, relativePath };
}

export async function writeExistingArtifactFile(input: { workspaceDir: string; filePath: string; content: string }): Promise<void> {
  await fs.promises.mkdir(input.workspaceDir, { recursive: true });
  const workspaceDir = await fs.promises.realpath(input.workspaceDir);
  const artifactDir = path.resolve(workspaceDir, artifactDirName);
  const filePath = path.resolve(input.filePath);
  if (!isPathInside(artifactDir, filePath)) throw new Error("Artifact file path must stay inside the workspace artifacts directory.");
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await validateArtifactDir(workspaceDir, artifactDir);
  await assertNoSymlink(filePath, "Artifact file path must not be a symlink.");
  await fs.promises.writeFile(filePath, input.content, "utf8");
}

export async function syncArtifactFiles(input: { db: AppDatabase; ownerId: string; chat: Chat; workspaceDir: string }): Promise<string[]> {
  const workspaceDir = await fs.promises.realpath(input.workspaceDir);
  const dir = path.resolve(workspaceDir, artifactDirName);
  let entries: string[];
  try { entries = await fs.promises.readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const dirStat = await fs.promises.lstat(dir);
  if (dirStat.isSymbolicLink()) return [];
  const realDir = await fs.promises.realpath(dir);
  if (!isPathInside(workspaceDir, realDir)) return [];
  const relativePaths: string[] = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const real = await fs.promises.realpath(filePath);
    if (!isPathInside(realDir, real)) continue;
    const content = await fs.promises.readFile(filePath, "utf8");
    const kind = artifactKindFromPath(filePath);
    const title = titleFromFileName(entry);
    input.db.upsertArtifactFile(input.ownerId, { chatId: input.chat.id, projectId: input.chat.projectId, messageId: null, filePath, title, kind, language: languageFromPath(filePath), content });
    relativePaths.push(path.join(artifactDirName, entry));
  }
  return relativePaths.sort();
}

async function validateArtifactDir(workspaceDir: string, artifactDir: string): Promise<void> {
  const stat = await fs.promises.lstat(artifactDir);
  if (stat.isSymbolicLink()) throw new Error("Artifact directory must not be a symlink.");
  if (!isPathInside(workspaceDir, await fs.promises.realpath(artifactDir))) throw new Error("Artifact directory must stay inside the workspace.");
}

export function artifactSystemContext(paths: string[]): string | null {
  if (paths.length === 0) return null;
  return ["Editable artifact files in this workspace:", ...paths.map((filePath) => `- ${filePath}`), "When updating an artifact, edit the existing file instead of creating a duplicate."].join("\n");
}

function artifactFileName(input: FileArtifactInput): string { return `${slugify(input.title)}.${extensionForArtifact(input)}`; }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "artifact"; }
function extensionForArtifact(input: FileArtifactInput): string { if (input.kind === "markdown") return "md"; if (input.kind === "json") return "json"; if (input.kind === "html") return "html"; if (input.kind === "mermaid") return "mmd"; if (input.kind === "code") return safeArtifactExtension(input.language) ?? "txt"; return "txt"; }
function safeArtifactExtension(language?: string | null): string | null { const normalized = (language ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, maxArtifactExtensionLength); return normalized || null; }
function artifactKindFromPath(filePath: string): ArtifactKind { const extension = path.extname(filePath).slice(1).toLowerCase(); if (extension === "md" || extension === "markdown") return "markdown"; if (extension === "json") return "json"; if (extension === "html" || extension === "htm") return "html"; if (extension === "mmd" || extension === "mermaid") return "mermaid"; return "text"; }
function languageFromPath(filePath: string): string | null { const kind = artifactKindFromPath(filePath); if (kind !== "text") return null; return path.extname(filePath).slice(1) || null; }
function titleFromFileName(fileName: string): string { return path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
