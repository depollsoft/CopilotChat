import path from "node:path";
import fs from "node:fs";

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-") || "owner";
}

export async function assertNoSymlink(filePath: string, message: string): Promise<void> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
