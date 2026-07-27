# CopilotChat

CopilotChat is a local-first, installable web app for using GitHub Copilot in a ChatGPT/Claude-style interface. It runs on your machine, can be installed as a PWA, and supports chats, projects, skills, MCP servers, cowork/workspace mode, artifacts, imports, notifications, Docker, and CI.

When Copilot reports billing usage for a request, the chat header shows the AI credits (AIC) spent so far in that conversation and updates live while a response runs. Each assistant message also shows what it cost. Providers that do not report credit usage simply omit the readout.

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

The checked-in Compose file uses the published GHCR image by default, keeps all state in a named volume, and can also build the same image locally:

```bash
cp .env.example .env
docker compose pull
docker compose up -d
```

Use `docker compose up -d --build` instead to build from the current checkout. The service listens on `127.0.0.1:4317` by default; change `COPILOTCHAT_BIND_ADDRESS` and `COPILOTCHAT_PORT` in `.env` when placing it behind a reverse proxy or exposing it on a trusted network. Application state, OAuth tokens, imports, artifacts, and SQLite files persist in the `copilotchat-data` volume across container replacement.

Attachments larger than 512 KB upload in chunks, so a reverse proxy that caps request bodies (nginx defaults `client_max_body_size` to 1 MB) never sees an oversized request. The browser halves its chunk size and retries whenever a proxy still answers `413`, and the server reassembles the chunks into a single file inside the chat workspace under `.copilotchat/uploads/`, which is the path handed to the agent. Set `COPILOTCHAT_UPLOAD_CHUNK_BYTES` to tune the chunk size and `COPILOTCHAT_UPLOAD_LIMIT_BYTES` for the total per-file limit.

For direct GitHub login, create a GitHub OAuth App and set these values in `.env`:

```dotenv
COPILOTCHAT_AUTH_MODE=github
COPILOTCHAT_PUBLIC_URL=https://chat.example.com
COPILOTCHAT_SESSION_SECRET=replace-with-a-long-random-value
GITHUB_CLIENT_ID=your-oauth-client-id
GITHUB_CLIENT_SECRET=your-oauth-client-secret
COPILOTCHAT_ALLOWED_GITHUB_LOGINS=your-handle,teammate
```

Generate the session secret with `openssl rand -hex 32`. Configure the OAuth App homepage as the public URL and its callback URL as:

```text
https://chat.example.com/api/auth/github/callback
```

The OAuth token is stored in the persistent volume and passed to the Copilot SDK for that user, so each signed-in account uses its own Copilot subscription. Set `COPILOTCHAT_ALLOWED_GITHUB_LOGINS` to a comma-separated list to restrict access to specific GitHub handles; matching is case-insensitive, a leading `@` is optional, and an empty list allows every GitHub account. The allowlist is checked on every authenticated request, so removing a handle also invalidates its existing sessions.

Chats, projects, skills, MCP servers, workspaces, imports, artifacts, tokens, and provider status are isolated by GitHub account. Cowork/workspace mode requires host folders to be mounted into the container before registration. In GitHub auth mode, mount each account below `COPILOTCHAT_CONTAINER_WORKSPACE_ROOT/<workspace-directory>/`; the authenticated `/api/auth/status` response exposes the exact stable `workspaceDirectory`. New accounts use `github-id-<numeric-github-user-id>`, while safely migrated accounts retain their legacy directory name.

For a new account, calculate the directory before mounting it with `gh api users/YOUR_HANDLE --jq '"github-id-\(.id)"'`.

For a single-user local deployment, leave `COPILOTCHAT_AUTH_MODE=local` and set `COPILOT_GITHUB_TOKEN` instead. If exposing the app beyond localhost, use HTTPS and set `COPILOTCHAT_ALLOWED_ORIGINS` to the exact browser origins.

GitHub Actions publishes `latest`, `main`, `sha-*`, and version tags to GitHub Container Registry:

```bash
docker pull ghcr.io/depollsoft/copilotchat:latest
```

GHCR packages may need to be made public once after their first publication for anonymous pulls.

Dependabot checks for `@github/copilot-sdk` updates daily. Its SDK-only pull requests are squash-merged automatically after the full CI workflow succeeds for the exact commit being merged. The default branch requires the `build-test` and `docker` checks with strict up-to-date enforcement so a tested update cannot merge against a newer base.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `COPILOTCHAT_HOST` | `127.0.0.1` | Server bind host |
| `COPILOTCHAT_PORT` | `4317` | Server port |
| `COPILOTCHAT_BIND_ADDRESS` | `127.0.0.1` | Host interface used by Docker Compose |
| `COPILOTCHAT_IMAGE` | `ghcr.io/depollsoft/copilotchat:latest` | Image used by Docker Compose |
| `COPILOTCHAT_CONTAINER_WORKSPACE_ROOT` | `/data/registered-workspaces` | Container workspace root used by Docker Compose |
| `COPILOTCHAT_DATA_DIR` | `.data` | SQLite database and runtime data |
| `COPILOTCHAT_WORKSPACE_ROOT` | `.data/registered-workspaces` | Base folder for GitHub-mode registered workspaces; each account is confined to its stable workspace directory |
| `COPILOTCHAT_BODY_LIMIT_BYTES` | `52428800` | Maximum API request body size |
| `COPILOTCHAT_AUTH_MODE` | `local` | `local` or `github` |
| `COPILOTCHAT_API_TOKEN` | empty | Optional API bearer token for exposed local-auth installs |
| `COPILOTCHAT_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the API |
| `COPILOTCHAT_PUBLIC_URL` | request origin | Public base URL for OAuth redirects, e.g. `https://chat.example.com` |
| `COPILOTCHAT_SESSION_SECRET` | empty | Required when `COPILOTCHAT_AUTH_MODE=github`; signs session cookies |
| `COPILOT_GITHUB_TOKEN` | empty | Recommended token for Copilot SDK auth in local or non-interactive deployments; also enables the `web_search` tool |
| `GITHUB_COPILOT_TOKEN` | empty | Token injected by some Copilot launcher sessions; also supported |
| `COPILOTCHAT_COPILOT_CLI_PATH` | auto-detected from PATH | Copilot CLI executable for the SDK to use |
| `COPILOTCHAT_REQUIRE_CSRF` | `true` | Require `X-CopilotChat-CSRF: 1` for mutating API requests |
| `GITHUB_CLIENT_ID` | empty | GitHub OAuth app/device-flow client ID |
| `GITHUB_CLIENT_SECRET` | empty | GitHub OAuth app client secret for web login |
| `COPILOTCHAT_ALLOWED_GITHUB_LOGINS` | empty | Comma-separated GitHub handles allowed to sign in; empty allows all |
| `COPILOT_PROVIDER` | `auto` | `auto`, `sdk`, `http`, `cli`, or `echo` |
| `COPILOT_API_BASE_URL` | empty | OpenAI-compatible provider base URL |
| `COPILOT_API_TOKEN` | empty | Provider token for HTTP adapter |
| `COPILOT_MODEL` | `gpt-4.1` | Provider model name |
| `COPILOT_CLI_COMMAND` | empty | CLI bridge command |

## Web search

Chats can call GitHub's hosted `web_search` tool. The Copilot CLI runtime does not register it on its own, so the server attaches the GitHub-hosted `https://api.githubcopilot.com/mcp/x/web_search` MCP server to every SDK session that has a GitHub token, exposing only the `web_search` tool. `web_fetch` is built into the runtime and is always available.

- GitHub auth mode: enabled automatically from the signed-in user's token.
- Local auth mode: set `COPILOT_GITHUB_TOKEN` (or `GITHUB_COPILOT_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`). Copilot CLI logged-in-user auth alone cannot authenticate the remote MCP server.

If the token cannot authenticate, the server is simply reported as needing auth and the rest of the session continues to work. The tool appears in chats as `copilot-web_search`; a user-defined MCP server named `copilot` takes precedence over the built-in one.

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

The app is single-user and local-first by default. In GitHub auth mode, browser access requires a GitHub OAuth session, can be restricted with an optional login allowlist, and data is isolated by GitHub login. The API restricts browser origins, caps request body size, and requires a CSRF header for mutating requests. Optional `COPILOTCHAT_API_TOKEN` can be used for bearer-token API access. Workspace commands are parsed without a shell, reject shell metacharacters, require commands to run inside registered folders, block destructive commands, and redact common token patterns. GitHub-mode workspace registration is confined to the signed-in owner's configured workspace-root subfolder. Copilot SDK shell/write/MCP/custom-tool permission requests are denied until explicit in-app approvals exist; URL/read requests are allowed once so web search and local context can work. The built-in `web_search` MCP server sends the owner's GitHub token to GitHub's own `api.githubcopilot.com` endpoint and exposes no other tool.

## Auth troubleshooting

If the UI shows **Setup** under `pnpm dev`, the server process cannot see Copilot auth. From the same terminal, run:

```bash
pnpm auth:doctor
copilot -p "reply OK" --output-format text --stream off
gh auth status
env | grep -E 'COPILOTCHAT_COPILOT_CLI_PATH|COPILOT_CLI_PATH|COPILOT_GITHUB_TOKEN|GITHUB_COPILOT_TOKEN|GITHUB_TOKEN|GH_TOKEN'
```

Supported auth methods for the app are, in order: `COPILOT_GITHUB_TOKEN`, `GITHUB_COPILOT_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, stored GitHub OAuth created in the app, and SDK logged-in-user/`gh` auth. In development the server auto-detects the `copilot` executable on PATH so the SDK uses the same CLI install as your terminal; override it with `COPILOTCHAT_COPILOT_CLI_PATH` if needed.
