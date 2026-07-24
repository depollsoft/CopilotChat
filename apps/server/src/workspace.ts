import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "@copilotchat/shared";
import { isPathInside, safePathSegment } from "./path-guards.js";

const blockedExecutablePatterns = [/^rm$/i, /^sudo$/i, /^su$/i, /^shutdown$/i, /^reboot$/i, /^mkfs/i, /^dd$/i, /^killall$/i, /^pkill$/i];
const allowedExecutables = new Set(["ls", "pwd", "cat", "grep", "head", "tail", "wc", "echo"]);
const pathArgumentExecutables = new Set(["cat", "head", "tail", "wc", "ls"]);
const shellMeta = /[;&|`$<>\n\r]/;

export async function runWorkspaceCommand(input: { workspace: Workspace; command: string; cwd: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const root = await fs.promises.realpath(input.workspace.rootPath);
  const cwd = await resolveWithinWorkspace(root, input.cwd);
  await fs.promises.access(cwd, fs.constants.R_OK);
  const argv = splitCommand(input.command);
  const executable = argv[0];
  if (!executable) throw new Error("Command is empty.");
  if (blockedExecutablePatterns.some((pattern) => pattern.test(executable))) throw new Error("Command blocked by workspace guardrails.");
  if (!allowedExecutables.has(executable)) throw new Error(`Command '${executable}' is not in the workspace allowlist.`);
  await validateCommandPaths(argv, root, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv.slice(1), { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); }, input.timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += redact(chunk); });
    child.stderr.on("data", (chunk: string) => { stderr += redact(chunk); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (exitCode) => { clearTimeout(timeout); resolve({ stdout, stderr, exitCode }); });
  });
}
export async function validateRegisteredWorkspaceRoot(input: { authMode: "local" | "github"; ownerId: string; rootPath: string; workspaceRoot: string }): Promise<string> {
  const rootPath = await fs.promises.realpath(input.rootPath);
  const stat = await fs.promises.stat(rootPath);
  if (!stat.isDirectory()) throw new Error("Workspace rootPath must be a directory.");
  if (input.authMode !== "github") return rootPath;
  const ownerRoot = ownerWorkspaceRoot(input.workspaceRoot, input.ownerId);
  await fs.promises.mkdir(ownerRoot, { recursive: true });
  const allowedRoot = await fs.promises.realpath(ownerRoot);
  if (!isPathInside(allowedRoot, rootPath)) throw new Error("Workspace rootPath must stay inside your configured workspace root.");
  return rootPath;
}
export function ownerWorkspaceDirectory(ownerId: string): string { return safePathSegment(ownerId.replace(/^github:/, "")); }
export function ownerWorkspaceRoot(workspaceRoot: string, ownerId: string): string { return path.join(workspaceRoot, ownerWorkspaceDirectory(ownerId)); }
function splitCommand(command: string): string[] { if (shellMeta.test(command)) throw new Error("Shell metacharacters are not allowed in workspace commands."); const tokens = command.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? []; return tokens.map((t) => t.replace(/^['"]|['"]$/g, "")); }
async function resolveWithinWorkspace(rootPath: string, relativeCwd: string): Promise<string> { const root = path.resolve(rootPath); const resolved = path.resolve(root, relativeCwd); if (!isPathInside(root, resolved)) throw new Error("Workspace command cwd must stay inside the registered workspace."); const real = await fs.promises.realpath(resolved); if (!isPathInside(root, real)) throw new Error("Workspace command cwd must not resolve outside the registered workspace."); return real; }
async function validateCommandPaths(argv: string[], root: string, cwd: string): Promise<void> { const executable = argv[0] ?? ""; let positional = 0; for (const arg of argv.slice(1)) { const isOption = arg.startsWith("-"); const mustBePath = pathArgumentExecutables.has(executable) && !isOption || executable === "grep" && !isOption && positional > 0; const violation = await commandArgPathViolation(arg, root, cwd, mustBePath); if (violation) throw new Error(`Workspace command path '${violation}' must stay inside the registered workspace.`); if (!isOption) positional += 1; } }
async function commandArgPathViolation(arg: string, root: string, cwd: string, mustBePath: boolean): Promise<string | null> { const values = arg.startsWith("-") && arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1)] : [arg]; for (const value of values) { if (!mustBePath && !looksLikePath(value)) continue; if (!await isCandidatePathInsideRoot(value, root, cwd)) return value; } return null; }
function looksLikePath(value: string): boolean { return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("~") || value.includes("/../") || value.includes(path.sep); }
async function isCandidatePathInsideRoot(candidate: string, root: string, cwd: string): Promise<boolean> { if (candidate.startsWith("~")) return false; const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate); if (!isPathInside(root, resolved)) return false; try { return isPathInside(root, await fs.promises.realpath(resolved)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; } }
function redact(value: string): string { return value.replaceAll(/gh[pousr]_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]").replaceAll(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]").replaceAll(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_API_KEY]"); }
