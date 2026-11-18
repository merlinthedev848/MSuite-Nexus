# MSuite Nexus 2.0

> **Enterprise GitHub Private Proxy, Binary Artifact Hub & Developer Portal for the MSuite Product Family**

MSuite Nexus securely bridges client applications (SIP, Sentinel, HoneyPot, MStream, etc.) with private GitHub repositories. It centralizes repository access, stores GitHub access tokens server-side, and delivers private **release binaries, update checks, raw files, and source archives** using scoped, per-app API keys.

---

## ⚡ What's New in v2.0 Enterprise

- 🖥️ **Full Web UI / Admin Portal**: Modern obsidian & neon dashboard at `/` featuring live telemetry, interactive repository explorer, key governance, and real-time request streaming.
- 💾 **Local NVMe/SSD Binary Asset Cache**: Intelligent local disk cache for large release installers (e.g. `.exe`, `.dmg`, `.zip`). Serves repeat requests at LAN speeds with full **HTTP 206 Partial Content (Range)** support for resumable downloads, saving massive GitHub bandwidth.
- 🚦 **Release Channels (Stable / Beta / Canary)**: Built-in semantic version channel routing for auto-updaters (`/update?current=1.2.0&channel=stable`).
- 🛡️ **IP Subnet Restrictions & Key Expiration**: Lock client keys to specific corporate CIDR ranges (e.g. `10.0.0.0/8`) and set optional expiration deadlines (30d, 90d, 1y).
- 📜 **Security Audit Ledger**: Immutable record of all key creations, rotations, deletions, and cache purges stored in `audit.jsonl` and viewable in the dashboard.
- 🧪 **Interactive API Request Sandbox**: Test endpoints, query parameters, and client keys directly in your browser with live response headers and JSON inspectors.
- 📈 **Prometheus Metrics (`/metrics`)**: OpenMetrics endpoint ready for Prometheus, Grafana, and Datadog monitoring.
- 📊 **Real-Time Throughput Sparklines**: 15-minute rolling request rate rendered via zero-dependency HTML5 canvas.
- 🔀 **Multi-Token Failover Pool**: Configure multiple GitHub PATs (`GITHUB_TOKENS=t1,t2`) with automatic rate limit rotation and 403 failover.
- 🪝 **GitHub Webhooks**: `/v1/webhook` endpoint with HMAC-SHA256 signature verification for instant metadata cache invalidation on release publish or code push.

---

## Architecture

```
                                      ┌──▶ Upstream GitHub API (api.github.com)
                                      │    (Token pool + ETag/TTL cache + Failover)
MSuite App ──(API Key)──▶ Nexus       ┼──▶ Local NVMe Asset Cache (Range / HTTP 206)
                       (Proxy Core)   │    (Instant LAN speeds, zero duplicate GitHub egress)
                                      ├──▶ Prometheus (/metrics) & Audit Ledger
                                      └──▶ Web UI / Admin Portal (SSE Live Traffic)
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
Edit `.env` to configure your tokens:
```ini
GITHUB_TOKEN=ghp_your_fine_grained_pat
ADMIN_TOKEN=msuite_secret_admin_token
PUBLIC_BASE_URL=https://code.example.com
```

### 3. Generate a Client API Key
Generate keys via the **Web UI** or via CLI:
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
- Asset cache and audit ledger persisted in `./cache`

---

## Client API Reference (`/v1`)

All `/v1` endpoints require authentication via:
`Authorization: Bearer <client-api-key>` or `X-API-Key: <client-api-key>`

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/health` | *none* | Service health and liveness check |
| `GET` | `/metrics` | *none* | Prometheus metrics export |
| `GET` | `/openapi.json` | *none* | OpenAPI 3.1 Specification for typed SDKs and Postman import |
| `GET` | `/v1/me` | *any* | Verifies key and returns allowed repos, CIDRs, permissions & rate limit |
| `GET` | `/v1/repos/:owner/:repo/update?current=1.2.0[&channel=stable]` | `releases` | Checks if a newer release exists; returns download URLs |
| `GET` | `/v1/repos/:owner/:repo/releases/latest[?channel=beta]` | `releases` | Fetches the latest published release and rewritten assets |
| `GET` | `/v1/repos/:owner/:repo/releases` | `releases` | Lists releases (drafts excluded, supports `?per_page=N`) |
| `GET` | `/v1/repos/:owner/:repo/releases/tags/:tag` | `releases` | Fetches release by tag name |
| `GET` | `/v1/repos/:owner/:repo/releases/assets/:id` | `releases` | Streams the binary asset (supports HTTP `Range` / resume, disk cache & `Digest` / `X-Checksum-Sha256` headers) |
| `GET` | `/v1/repos/:owner/:repo/releases/assets/:id/digest` | `releases` | Returns cryptographic SHA-256 digest and file metadata |
| `GET` | `/v1/repos/:owner/:repo/raw/*path?ref=main` | `raw` | Streams raw file content with safe Content-Type |
| `GET` | `/v1/repos/:owner/:repo/archive?ref=main&format=zip` | `archive` | Streams repo source archive (`zip` or `tar`) |
| `POST` | `/v1/webhook` | *none / HMAC* | GitHub webhook receiver for instant cache invalidation |

---

## Admin API Reference (`/api/admin`)

Requires `Authorization: Bearer <ADMIN_TOKEN>`.

- `POST /api/admin/login` – Validate admin credentials
- `GET /api/admin/overview` – Real-time metrics snapshot, rate limits, uptime, and throughput history
- `GET /api/admin/stream` – Server-Sent Events (SSE) live traffic and event stream
- `GET /api/admin/clients` – List all configured client applications
- `POST /api/admin/clients` – Create a new client (with optional IP allowlist and expiration)
- `PUT /api/admin/clients/:name` – Update repos, permissions, description, or disable client
- `POST /api/admin/clients/:name/rotate-key` – Invalidate previous key and issue a new one
- `DELETE /api/admin/clients/:name` – Remove client
- `GET /api/admin/repos` – List repositories accessible via upstream GitHub token
- `GET /api/admin/repos/:owner/:repo/releases` – Explore releases, assets, and cache status
- `GET /api/admin/asset-cache` – Inspect local disk cache statistics and files
- `POST /api/admin/asset-cache/prefetch` – Warm-up an asset directly to local disk cache
- `DELETE /api/admin/asset-cache/:id` – Purge an asset from disk cache
- `GET /api/admin/audit` – Query security and administrative audit log
- `POST /api/admin/tester` – Interactive API Sandbox execution proxy
- `GET /api/admin/diagnostics` – Upstream GitHub latency ping and scope verification

---

## Security Model

1. **Token Shielding**: GitHub access tokens exist strictly server-side. Client applications receive only cryptographically random `msk_...` keys.
2. **One-Way Hashing**: Client keys are hashed with `SHA-256` prior to storage. Plaintext keys are never stored on disk.
3. **Subnet Enforcement**: Client keys can be restricted to specific IPv4 CIDRs (e.g. `10.0.0.0/8`, `192.168.1.0/24`), blocking stolen credentials from outside networks.
4. **Token-Leak Prevention on Storage Redirects**: GitHub redirects downloads to Amazon S3 / Azure pre-signed URLs. Nexus intercepts redirects manually and strips credentials before following.
5. **Content-Type Sniffing Protection**: Raw files are served with `X-Content-Type-Options: nosniff` and sanitised types to prevent browser execution.

---

## Testing

```bash
npm test
```

Runs the 18 automated integration tests against a mock upstream server covering auth, access control, URL rewriting, streaming pipelines, token leak protection, admin CRUD, rate limiting, disk caching, range requests, and webhooks.
