"""
MSuite Nexus Official Client SDK (Python)
Zero-dependency, standalone client for MSuite Python applications and CLI workers.
Connects securely to MSuite Nexus for releases, binary assets, and updates.
"""

import os
import hashlib
import json
import urllib.request
import urllib.error
import urllib.parse
from typing import Optional, Dict, Any, Callable

class NexusClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: int = 30
    ):
        self.base_url = (base_url or os.getenv("MSUITE_NEXUS_URL", "http://localhost:8080")).rstrip("/")
        self.api_key = (api_key or os.getenv("MSUITE_NEXUS_KEY", "")).strip()
        self.timeout = timeout

    @property
    def headers(self) -> Dict[str, str]:
        h = {
            "User-Agent": "MSuite-Nexus-Client/2.0 (Python)",
            "Accept": "application/json"
        }
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _request(self, path: str, method: str = "GET", data: Optional[bytes] = None) -> Any:
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, data=data, headers=self.headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                content_type = resp.headers.get("Content-Type", "")
                body = resp.read()
                if "application/json" in content_type:
                    return json.loads(body.decode("utf-8"))
                return body.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            err_msg = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Nexus HTTP {e.code}: {err_msg}") from e

    def verify_auth(self) -> Dict[str, Any]:
        """Test API key authentication and permissions."""
        return self._request("/v1/me")

    def check_for_update(self, repo: str, current_version: str, channel: str = "stable") -> Dict[str, Any]:
        """Check if an update is available on a given channel."""
        owner, name = repo.split("/")
        qs = urllib.parse.urlencode({"current": current_version, "channel": channel})
        return self._request(f"/v1/repos/{owner}/{name}/update?{qs}")

    def get_latest_release(self, repo: str, channel: str = "stable") -> Dict[str, Any]:
        """Retrieve latest release metadata."""
        owner, name = repo.split("/")
        return self._request(f"/v1/repos/{owner}/{name}/releases/latest?channel={channel}")

    def download_asset(
        self,
        repo: str,
        asset_id: int,
        dest_path: str,
        verify_sha256: bool = True,
        on_progress: Optional[Callable[[int, int], None]] = None
    ) -> Dict[str, Any]:
        """Download binary asset with real-time SHA-256 integrity verification."""
        owner, name = repo.split("/")
        url = f"{self.base_url}/v1/repos/{owner}/{name}/releases/assets/{asset_id}"
        req = urllib.request.Request(url, headers=self.headers)

        os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
        temp_path = f"{dest_path}.tmp"

        hasher = hashlib.sha256()
        bytes_downloaded = 0

        with urllib.request.urlopen(req, timeout=self.timeout) as resp, open(temp_path, "wb") as f:
            total_bytes = int(resp.headers.get("Content-Length", 0))
            expected_sha256 = resp.headers.get("X-Checksum-Sha256", "").strip()

            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                hasher.update(chunk)
                bytes_downloaded += len(chunk)
                if on_progress:
                    on_progress(bytes_downloaded, total_bytes)

        actual_sha256 = hasher.hexdigest()

        if verify_sha256 and expected_sha256 and actual_sha256.lower() != expected_sha256.lower():
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise ValueError(f"SHA-256 Checksum Mismatch! Expected {expected_sha256}, got {actual_sha256}")

        os.replace(temp_path, dest_path)
        return {
            "path": dest_path,
            "size": bytes_downloaded,
            "sha256": actual_sha256,
            "verified": bool(expected_sha256 and actual_sha256.lower() == expected_sha256.lower())
        }

    def fetch_raw_file(self, repo: str, file_path: str, ref: str = "main") -> str:
        """Fetch raw private text file."""
        owner, name = repo.split("/")
        clean_path = file_path.lstrip("/")
        return self._request(f"/v1/repos/{owner}/{name}/raw/{clean_path}?ref={ref}")

    def call_service(self, service_id: str, sub_path: str = "", method: str = "GET", payload: Optional[Any] = None) -> Any:
        """Route request through Nexus Service Gateway to upstream backend."""
        clean_sub = f"/{sub_path.lstrip('/')}" if sub_path else ""
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        return self._request(f"/v1/services/{service_id}{clean_sub}", method=method, data=data)

    def publish_message(self, topic: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Publish event to MSuite Real-Time Message Bus."""
        data = json.dumps({"topic": topic, "payload": payload or {}}).encode("utf-8")
        return self._request("/v1/bus/publish", method="POST", data=data)

    def get_message_history(self, topic: Optional[str] = None, limit: int = 50) -> Any:
        """Fetch message history for topic."""
        params = {"limit": limit}
        if topic:
            params["topic"] = topic
        qs = urllib.parse.urlencode(params)
        return self._request(f"/v1/bus/history?{qs}")
