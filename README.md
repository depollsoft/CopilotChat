# CopilotChat

CopilotChat is a local-first, installable web app for using GitHub Copilot in a ChatGPT/Claude-style interface. It runs on your machine, can be installed as a PWA, and supports chats, projects, skills, MCP servers, cowork/workspace mode, artifacts, imports, notifications, Docker, and CI.

## Quick start

```bash
corepack enable
pnpm install
pnpm dev
```

The web app runs at <http://localhost:5173> in development and proxies API calls to the local server at <http://localhost:4317>.

## Production

```bash
pnpm build
pnpm --filter @copilotchat/server start
```

By default data is stored in `.data/`. Set `COPILOTCHAT_DATA_DIR` to change it.

## Docker

```bash
docker compose up --build
```

Docker Compose publishes on `127.0.0.1:4317` by default and stores state in the `copilotchat-data` volume. Cowork/workspace mode needs host folders mounted into the container before they can be registered. In GitHub auth mode, registered workspaces must live under `COPILOTCHAT_WORKSPACE_ROOT/<github-login>/`. If exposing on a VPN/LAN interface, set `COPILOTCHAT_ALLOWED_ORIGINS` to the exact browser origins.

For self-hosted multi-user access, set `COPILOTCHAT_AUTH_MODE=github`, `COPILOTCHAT_PUBLIC_URL`, `COPILOTCHAT_SESSION_SECRET`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Configure the GitHub OAuth app callback URL as:

```text
https://your-host.example.com/api/auth/github/callback
```

Each signed-in GitHub login gets an isolated owner record, so chats, projects, skills, MCP servers, workspaces, imports, and artifacts are scoped by login. Published images are available from GitHub Container Registry after merges to `main`:

```bash
docker pull ghcr.io/OWNER/REPOSITORY:main
```

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `COPILOTCHAT_HOST` | `127.0.0.1` | Server bind host |
| `COPILOTCHAT_PORT` | `4317` | Server port |
| `COPILOTCHAT_DATA_DIR` | `.data` | SQLite database and runtime data |
| `COPILOTCHAT_WORKSPACE_ROOT` | `.data/registered-workspaces` | Base folder for GitHub-mode registered workspaces; each login is confined to a subfolder |
| `COPILOTCHAT_BODY_LIMIT_BYTES` | `52428800` | Maximum API request body size |
| `COPILOTCHAT_AUTH_MODE` | `local` | `local` or `github` |
| `COPILOTCHAT_API_TOKEN` | empty | Optional API bearer token for exposed installs |
| `COPILOTCHAT_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the API |
| `COPILOTCHAT_PUBLIC_URL` | request origin | Public base URL for OAuth redirects, e.g. `https://chat.example.com` |
| `COPILOTCHAT_SESSION_SECRET` | empty | Required when `COPILOTCHAT_AUTH_MODE=github`; signs session cookies |
| `COPILOT_GITHUB_TOKEN` | empty | Recommended token env var for Copilot SDK auth in `pnpm dev` |
| `GITHUB_COPILOT_TOKEN` | empty | Token injected by some Copilot launcher sessions; also supported |
| `COPILOTCHAT_COPILOT_CLI_PATH` | auto-detected from PATH | Copilot CLI executable for the SDK to use |
| `COPILOTCHAT_REQUIRE_CSRF` | `true` | Require `X-CopilotChat-CSRF: 1` for mutating API requests |
| `GITHUB_CLIENT_ID` | empty | GitHub OAuth app/device-flow client ID |
| `GITHUB_CLIENT_SECRET` | empty | GitHub OAuth app client secret for web login |
| `COPILOT_PROVIDER` | `auto` | `auto`, `sdk`, `http`, `cli`, or `echo` |
| `COPILOT_API_BASE_URL` | empty | OpenAI-compatible provider base URL |
| `COPILOT_API_TOKEN` | empty | Provider token for HTTP adapter |
| `COPILOT_MODEL` | `gpt-4.1` | Provider model name |
| `COPILOT_CLI_COMMAND` | empty | CLI bridge command |

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run web and server dev processes |
| `pnpm build` | Build all packages/apps |
| `pnpm typecheck` | Type-check all packages/apps |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run Vitest |
| `pnpm test:e2e` | Run Playwright e2e tests |

## Security model

The app is single-user and local-first by default. In GitHub auth mode, browser access requires a GitHub OAuth session and data is isolated by GitHub login. The API restricts browser origins, caps request body size, and requires a CSRF header for mutating requests. Optional `COPILOTCHAT_API_TOKEN` can be used for bearer-token API access. Workspace commands are parsed without a shell, reject shell metacharacters, require commands to run inside registered folders, block destructive commands, and redact common token patterns. GitHub-mode workspace registration is confined to the signed-in owner's configured workspace-root subfolder. Copilot SDK shell/write/MCP/custom-tool permission requests are denied until explicit in-app approvals exist; URL/read requests are allowed once so web search and local context can work.

## Auth troubleshooting

If the UI shows **Setup** under `pnpm dev`, the server process cannot see Copilot auth. From the same terminal, run:

```bash
pnpm auth:doctor
copilot -p "reply OK" --output-format text --stream off
gh auth status
env | grep -E 'COPILOTCHAT_COPILOT_CLI_PATH|COPILOT_CLI_PATH|COPILOT_GITHUB_TOKEN|GITHUB_COPILOT_TOKEN|GITHUB_TOKEN|GH_TOKEN'
```

Supported auth methods for the app are, in order: `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, stored GitHub OAuth created in the app, and SDK logged-in-user/`gh` auth. In development the server auto-detects the `copilot` executable on PATH so the SDK uses the same CLI install as your terminal; override it with `COPILOTCHAT_COPILOT_CLI_PATH` if needed.
