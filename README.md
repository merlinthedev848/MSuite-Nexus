# MSuite CodeHandler

GitHub private proxy for the MSuite product family. It holds a **single GitHub token** server-side and lets MSuite apps (SIP, Sentinel, HoneyPot, MStream, …) download private **release assets, update metadata, raw files and source archives** using their own **per-app API keys**. No GitHub credentials ever ship inside a client.

```
MSuite app ──(API key)──▶ CodeHandler ──(GitHub token)──▶ api.github.com
                                     ◀── streams asset ── signed storage URL (token never forwarded)
```

## Features

- Per-client API keys, stored only as SHA-256 hashes
- Per-client repo allow-list (`owner/repo`, `owner/*`, `*`) and permissions (`releases`, `raw`, `archive`)
- Release metadata rewritten so download URLs point at the proxy; GitHub URLs are stripped out
- Streaming downloads with `Range` support (resumable)
- Built-in update check (`/update?current=1.2.3`)
- Redirects followed manually so the GitHub token is **only** sent to the GitHub API
- In-memory metadata cache (TTL + ETag), per-client rate limiting, path/ref validation
- Hot reloads `clients.json` with no restart; a bad edit keeps the previous config
- JSON request logs, Docker image with healthcheck

## Quick start

```bash
npm install
cp .env.example .env          # set GITHUB_TOKEN and PUBLIC_BASE_URL
npm run new-key -- msuite-sip merlinthedev848/MSuite-SIP --perms releases
npm start
```

`new-key` writes the hashed key into `clients.json` and prints the plaintext key **once**.

On Windows PowerShell, set env vars instead of using `.env` (the server reads `process.env`):

```powershell
$env:GITHUB_TOKEN="github_pat_..."; npm start
```

### Docker

```bash
docker compose up -d --build
```

`clients.json` is mounted read-only at `/config/clients.json`.

### GitHub token

Use a **fine-grained personal access token** (or GitHub App token) scoped to only the repos you expose, with read-only **Contents** and **Metadata** permissions.

## API

Every `/v1` request needs `Authorization: Bearer <api-key>` (or `X-API-Key: <api-key>`).

| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness check (no auth) |
| GET | `/v1/me` | any | Shows the calling client's name, repos and permissions |
| GET | `/v1/repos/:owner/:repo/releases?per_page=10` | releases | Lists releases (drafts excluded) |
| GET | `/v1/repos/:owner/:repo/releases/latest[?prerelease=true]` | releases | Latest release |
| GET | `/v1/repos/:owner/:repo/releases/tags/:tag` | releases | Release by tag |
| GET | `/v1/repos/:owner/:repo/releases/assets/:id` | releases | Streams the asset binary (supports `Range`) |
| GET | `/v1/repos/:owner/:repo/update?current=1.2.3[&prerelease=true]` | releases | Update check |
| GET | `/v1/repos/:owner/:repo/raw/<path>?ref=main` | raw | Raw file contents |
| GET | `/v1/repos/:owner/:repo/archive?ref=main&format=zip\|tar` | archive | Source archive |

### Update check example

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://code.example.com/v1/repos/merlinthedev848/MSuite-SIP/update?current=1.4.0"
```

```json
{
  "current": "1.4.0",
  "latest_version": "v1.5.0",
  "update_available": true,
  "release": {
    "tag_name": "v1.5.0",
    "assets": [
      { "id": 123, "name": "MSuite-SIP-Setup.exe", "size": 48211234,
        "download_url": "https://code.example.com/v1/repos/merlinthedev848/MSuite-SIP/releases/assets/123" }
    ]
  }
}
```

Download the asset with the same API key header on `download_url`.

### Errors

JSON `{ "error": "<code>", "message": "..." }`:
`401 unauthorized`, `403 forbidden`, `400 bad_request`, `404 not_found`, `429 rate_limited`, `502 upstream_auth | upstream_error`.

## clients.json

```json
{
  "clients": [
    {
      "name": "msuite-sip",
      "keyHash": "<sha256 of the api key>",
      "repos": ["merlinthedev848/MSuite-SIP"],
      "permissions": ["releases"],
      "disabled": false
    }
  ]
}
```

To rotate a key, delete the client entry and run `new-key` again. To revoke one, set `"disabled": true`. Both changes are picked up within about 5 seconds.

## Configuration

See [.env.example](.env.example). Key settings: `GITHUB_TOKEN` (required), `PUBLIC_BASE_URL`, `TRUST_PROXY`, `CACHE_TTL_SECONDS`, `RATE_LIMIT_PER_MINUTE`, `GITHUB_API_URL` (GitHub Enterprise).

## Deployment notes

- Run behind TLS (Caddy, nginx or Cloudflare) and set `TRUST_PROXY=true`.
- Never commit `.env` or `clients.json`; both are git-ignored.
- Rate limiting and caching are in-memory per instance.

## Tests

```bash
npm test
```

The tests run against a fake GitHub server and cover auth, allow-lists, URL rewriting, token-leak protection on redirects, update checks, traversal rejection and rate limiting.
