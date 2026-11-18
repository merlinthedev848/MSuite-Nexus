# MSuite Nexus 2.0

> **GitHub Private Proxy & Artifact Hub for the MSuite Product Family**

MSuite Nexus securely bridges client applications (SIP, Sentinel, HoneyPot, MStream, etc.) with private GitHub repositories. It centralizes repository access, stores GitHub access tokens server-side, and serves private **release binaries, update checks, raw files, and source archives** using scoped, per-app API keys.

---

## ⚡ What's New in v2.0

- 🖥️ **Full Web UI / Admin Dashboard**: Modern, responsive dark-themed dashboard at `/` with real-time telemetry, interactive repository explorer, client key manager, and live request streaming.
- 📡 **Real-Time Traffic Terminal (SSE)**: Live streaming of incoming proxy requests with status codes, latency, client identity, bandwidth, and pause/auto-scroll controls.
- 🔀 **Multi-Token Failover & Rotation**: Configure a pool of GitHub PATs (`GITHUB_TOKENS=t1,t2`); Nexus automatically switches tokens if one approaches rate limits or hits 403.
- 🪝 **GitHub Webhook Receiver**: `/v1/webhook` endpoint with HMAC-SHA256 signature verification that automatically purges memory caches when releases are published or commits are pushed.
- 🛠️ **Upstream Diagnostics & Cache Manager**: Built-in latency ping tool, token permission inspector, and pattern-based cache purger.
- 📋 **Interactive Code Snippet Generator**: Copy-paste integration snippets in **cURL**, **PowerShell**, **Node.js**, and **Python** for any release asset.
- ⏱️ **Zero-Downtime Hot Reloading**: Add, update, rotate, or disable client keys on the fly without server restarts.

---

## Architecture

```
                                   ┌──▶ Upstream GitHub API (api.github.com)
                                   │    (Token pool + ETag/TTL cache + Failover)
MSuite App ──(API Key)──▶ Nexus    ┼──▶ Signed Storage URLs (AWS S3/Azure)
                       (Proxy Core)│    (Streaming binary pipeline, token never forwarded)
                                   └──▶ Admin Dashboard / Web UI
                                        (SSE Live Traffic, Metrics, Key Manager)
```

---

## Quick Start

### 1. Installation
```bash
git clone https://github.com/merlinthedev848/MSuite-CodeHandler.git
cd MSuite-CodeHandler
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` to set:
```ini
GITHUB_TOKEN=ghp_your_fine_grained_pat
ADMIN_TOKEN=msuite_secret_admin_token
PUBLIC_BASE_URL=https://code.example.com
```

### 3. Generate a Client API Key
You can generate keys via the **Web UI** or via CLI:
```bash
npm run new-key -- msuite-sip merlinthedev848/MSuite-SIP --perms releases
```

### 4. Start the Service
```bash
npm start
```

Access the dashboard at `http://localhost:8080/`.

---

## Docker Deployment

```bash
docker compose up -d --build
```

- Web UI & Proxy exposed on port `8080`
- `clients.json` mounted at `/config/clients.json` (hot reloads automatically)
- Container includes Alpine health checks

---

## Client API Reference (`/v1`)

All `/v1` endpoints require authentication via:
`Authorization: Bearer <client-api-key>` or `X-API-Key: <client-api-key>`

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/health` | *none* | Service health and liveness check |
| `GET` | `/v1/me` | *any* | Verifies key and returns allowed repos & permissions |
| `GET` | `/v1/repos/:owner/:repo/update?current=1.2.0` | `releases` | Checks if a newer release exists; returns download URLs |
| `GET` | `/v1/repos/:owner/:repo/releases/latest` | `releases` | Fetches the latest published release and rewritten assets |
| `GET` | `/v1/repos/:owner/:repo/releases` | `releases` | Lists releases (drafts excluded, supports `?per_page=N`) |
| `GET` | `/v1/repos/:owner/:repo/releases/tags/:tag` | `releases` | Fetches release by tag name |
| `GET` | `/v1/repos/:owner/:repo/releases/assets/:id` | `releases` | Streams the binary asset (supports HTTP `Range` / resume) |
| `GET` | `/v1/repos/:owner/:repo/raw/*path?ref=main` | `raw` | Streams raw file content with safe Content-Type |
| `GET` | `/v1/repos/:owner/:repo/archive?ref=main&format=zip` | `archive` | Streams repo source archive (`zip` or `tar`) |
| `POST` | `/v1/webhook` | *none / HMAC* | GitHub webhook receiver for instant cache invalidation |

---

## Admin API Reference (`/api/admin`)

Requires `Authorization: Bearer <ADMIN_TOKEN>`.

- `POST /api/admin/login` – Validate admin credentials
- `GET /api/admin/overview` – Real-time metrics snapshot, rate limits, uptime, and client stats
- `GET /api/admin/stream` – Server-Sent Events (SSE) live traffic and event stream
- `GET /api/admin/clients` – List all configured client applications
- `POST /api/admin/clients` – Create a new client and generate an API key
- `PUT /api/admin/clients/:name` – Update repos, permissions, description, or disable client
- `POST /api/admin/clients/:name/rotate-key` – Invalidate previous key and issue a new one
- `DELETE /api/admin/clients/:name` – Remove client
- `GET /api/admin/repos` – List repositories accessible via upstream GitHub token
- `GET /api/admin/repos/:owner/:repo/releases` – Explore releases and binary assets
- `GET /api/admin/cache` – Inspect cached endpoints and TTLs
- `POST /api/admin/cache/clear` – Purge memory cache (all or by pattern)
- `GET /api/admin/diagnostics` – Upstream GitHub latency ping and scope verification

---

## Security Model

1. **Credential Isolation**: GitHub personal access tokens are stored strictly server-side in memory and environment variables. Client applications receive only cryptographically random `msk_...` keys.
2. **One-Way Hashing**: Client keys are hashed with `SHA-256` prior to storage in `clients.json`. Plaintext keys are never stored on disk.
3. **Token-Leak Prevention on Storage Redirects**: GitHub redirects asset downloads to temporary pre-signed Amazon S3 / Azure storage URLs. Nexus intercepts redirects manually and strips the `Authorization` header before fetching from storage.
4. **Content-Type Sniffing Protection**: Raw files are served with `X-Content-Type-Options: nosniff` and sanitised types to prevent XSS.
5. **Path Traversal Protection**: Directory traversal (`..`), null bytes, and malicious ref names are blocked before reaching upstream.

---

## Testing

```bash
npm test
```

Runs the automated test suite with a mock upstream GitHub server covering auth, access control, URL rewriting, streaming pipelines, token leak protection, admin CRUD, rate limiting, and webhooks.
