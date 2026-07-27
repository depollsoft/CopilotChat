import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const envBooleanSchema = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean().default(true));

const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65535).default(4317),
  dataDir: z.string().default(".data"),
  workspaceRoot: z.string(),
  bodyLimitBytes: z.coerce.number().int().min(1).default(50 * 1024 * 1024),
  uploadLimitBytes: z.coerce.number().int().min(1).default(1024 * 1024 * 1024),
  // The minimum matches MIN_UPLOAD_CHUNK_BYTES in the web client, which never sends chunks below its own floor.
  uploadChunkBytes: z.coerce.number().int().min(64 * 1024).max(64 * 1024 * 1024).default(512 * 1024),
  stagedUploadLimitBytes: z.coerce.number().int().min(1).default(1024 * 1024 * 1024),
  stagedUploadLimitFiles: z.coerce.number().int().min(1).default(100),
  importLimitBytes: z.coerce.number().int().min(1).default(128 * 1024 * 1024),
  importDraftLimitBytes: z.coerce.number().int().min(1).default(1024 * 1024 * 1024),
  authMode: z.enum(["local", "github"]).default("local"),
  apiToken: z.string().optional(),
  githubClientId: z.string().optional(),
  githubClientSecret: z.string().optional(),
  sessionSecret: z.string().optional(),
  publicUrl: z.string().url().optional(),
  copilotProvider: z.enum(["auto", "sdk", "http", "cli", "echo"]).default("auto"),
  copilotApiBaseUrl: z.string().optional(),
  copilotApiToken: z.string().optional(),
  copilotModel: z.string().default("gpt-4.1"),
  copilotCliCommand: z.string().optional(),
  copilotSdkCliPath: z.string().optional(),
  copilotGitHubToken: z.string().optional(),
  copilotGitHubTokenSource: z.string().optional(),
  allowedGitHubLogins: z.array(z.string()).default([]),
  allowedOrigins: z.array(z.string()).default([]),
  requireCsrf: envBooleanSchema,
});
export type AppConfig = z.infer<typeof configSchema>;
export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.env.COPILOTCHAT_DATA_DIR ?? ".data");
  const copilotToken = [
    ["COPILOT_GITHUB_TOKEN", optionalEnv(process.env.COPILOT_GITHUB_TOKEN)],
    ["GITHUB_COPILOT_TOKEN", optionalEnv(process.env.GITHUB_COPILOT_TOKEN)],
    ["GH_TOKEN", optionalEnv(process.env.GH_TOKEN)],
    ["GITHUB_TOKEN", optionalEnv(process.env.GITHUB_TOKEN)],
  ] as const;
  const configuredToken = copilotToken.find((entry) => entry[1]);
  return configSchema.parse({
    host: process.env.COPILOTCHAT_HOST,
    port: process.env.COPILOTCHAT_PORT,
    dataDir,
    workspaceRoot: path.resolve(process.env.COPILOTCHAT_WORKSPACE_ROOT || path.join(dataDir, "registered-workspaces")),
    bodyLimitBytes: process.env.COPILOTCHAT_BODY_LIMIT_BYTES,
    uploadLimitBytes: process.env.COPILOTCHAT_UPLOAD_LIMIT_BYTES,
    uploadChunkBytes: process.env.COPILOTCHAT_UPLOAD_CHUNK_BYTES,
    stagedUploadLimitBytes: process.env.COPILOTCHAT_STAGED_UPLOAD_LIMIT_BYTES,
    stagedUploadLimitFiles: process.env.COPILOTCHAT_STAGED_UPLOAD_LIMIT_FILES,
    importLimitBytes: process.env.COPILOTCHAT_IMPORT_LIMIT_BYTES,
    importDraftLimitBytes: process.env.COPILOTCHAT_IMPORT_DRAFT_LIMIT_BYTES,
    authMode: process.env.COPILOTCHAT_AUTH_MODE,
    apiToken: optionalEnv(process.env.COPILOTCHAT_API_TOKEN),
    githubClientId: optionalEnv(process.env.GITHUB_CLIENT_ID),
    githubClientSecret: optionalEnv(process.env.GITHUB_CLIENT_SECRET),
    sessionSecret: optionalEnv(process.env.COPILOTCHAT_SESSION_SECRET),
    publicUrl: optionalEnv(process.env.COPILOTCHAT_PUBLIC_URL),
    copilotProvider: process.env.COPILOT_PROVIDER,
    copilotApiBaseUrl: optionalEnv(process.env.COPILOT_API_BASE_URL),
    copilotApiToken: optionalEnv(process.env.COPILOT_API_TOKEN),
    copilotModel: process.env.COPILOT_MODEL,
    copilotCliCommand: optionalEnv(process.env.COPILOT_CLI_COMMAND),
    copilotSdkCliPath: resolveCopilotCliPath(),
    copilotGitHubToken: configuredToken?.[1],
    copilotGitHubTokenSource: configuredToken?.[0],
    allowedGitHubLogins: parseAllowedGitHubLogins(process.env.COPILOTCHAT_ALLOWED_GITHUB_LOGINS),
    allowedOrigins: (process.env.COPILOTCHAT_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
    requireCsrf: process.env.COPILOTCHAT_REQUIRE_CSRF,
  });
}

export function isGitHubLoginAllowed(allowedLogins: readonly string[], login: string): boolean {
  if (allowedLogins.length === 0) return true;
  const normalized = normalizeGitHubLogin(login);
  return allowedLogins.some((allowed) => normalizeGitHubLogin(allowed) === normalized);
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseAllowedGitHubLogins(value: string | undefined): string[] {
  return Array.from(new Set((value ?? "").split(",").map(normalizeGitHubLogin).filter(Boolean)));
}

function normalizeGitHubLogin(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function resolveCopilotCliPath(): string | undefined {
  const explicit = process.env.COPILOTCHAT_COPILOT_CLI_PATH ?? process.env.COPILOT_CLI_PATH;
  if (explicit) return explicit;
  return findExecutableOnPath("copilot");
}

function findExecutableOnPath(command: string): string | undefined {
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = os.platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const entry of paths) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension.toLowerCase()}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}
