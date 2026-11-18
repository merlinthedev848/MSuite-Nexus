// State management
const state = {
  adminToken: localStorage.getItem('msuite_admin_token') || '',
  activeTab: 'overview',
  overviewData: null,
  clients: [],
  repos: [],
  selectedRepo: null,
  releases: [],
  logs: [],
  logCounter: 0,
  isLogPaused: false,
  autoScrollLogs: true,
  snippetLang: 'curl',
  eventSource: null,
};

// Utilities
const el = (id) => document.getElementById(id);
const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatUptime = (seconds) => {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
};

function toast(msg, type = 'info') {
  const container = el('toastContainer');
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.textContent = msg;
  container.appendChild(div);
  setTimeout(() => div.remove(), 4000);
}

// API Helper
async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (state.adminToken) {
    headers['Authorization'] = `Bearer ${state.adminToken}`;
  }
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    showAdminLoginModal();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw new Error(err.message || `Request failed with status ${res.status}`);
  }
  return res.json();
}

// Admin Auth Modal
function showAdminLoginModal() {
  el('modalAdminLogin').classList.remove('hidden');
}

function hideAdminLoginModal() {
  el('modalAdminLogin').classList.add('hidden');
  el('loginErrorMsg').textContent = '';
}

async function handleLogin() {
  const token = el('inputAdminToken').value.trim();
  if (!token) return;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) throw new Error('Invalid admin token');

    state.adminToken = token;
    localStorage.setItem('msuite_admin_token', token);
    hideAdminLoginModal();
    toast('Authenticated as Admin', 'success');
    initSSE();
    loadActiveTabData();
  } catch (e) {
    el('loginErrorMsg').textContent = e.message;
  }
}

// Tab Switching
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      state.activeTab = tabId;
      el(`tab-${tabId}`).classList.add('active');
      loadActiveTabData();
    });
  });
}

function loadActiveTabData() {
  switch (state.activeTab) {
    case 'overview':
      loadOverview();
      break;
    case 'clients':
      loadClients();
      break;
    case 'explorer':
      loadRepos();
      break;
    case 'live-logs':
      // SSE keeps it updated
      break;
    case 'diagnostics':
      loadCacheStats();
      break;
  }
}

// 1. OVERVIEW
async function loadOverview() {
  try {
    const data = await api('/api/admin/overview');
    state.overviewData = data;

    el('statTotalRequests').textContent = data.totalRequests.toLocaleString();
    el('statStatusPills').innerHTML = `
      <span class="status-tag tag-2xx">2xx: ${data.statusCodes['2xx'] || 0}</span>
      <span class="status-tag tag-3xx">3xx: ${data.statusCodes['3xx'] || 0}</span>
      <span class="status-tag tag-4xx">4xx: ${data.statusCodes['4xx'] || 0}</span>
      <span class="status-tag tag-5xx">5xx: ${data.statusCodes['5xx'] || 0}</span>
    `;

    el('statBytesStreamed').textContent = formatBytes(data.bytesStreamed);
    el('statCacheHitRate').textContent = `${data.cache.hitRatePercent}%`;
    el('statCacheRatioSub').textContent = `${data.cache.hits} hits / ${data.cache.misses} misses`;

    el('statLatencyAvg').textContent = `${data.latency.avgMs} ms`;
    el('statLatencyP95').textContent = `p95: ${data.latency.p95Ms} ms`;

    el('statActiveClients').textContent = data.activeClientsCount;
    el('statTotalClientsSub').textContent = `${data.totalClientsCount} configured apps`;

    el('statUptime').textContent = formatUptime(data.uptimeSec);
    const heapMb = Math.round((data.memory?.heapUsed || 0) / (1024 * 1024));
    el('statMemorySub').textContent = `Heap: ${heapMb} MB`;

    // GitHub Rate limits
    if (data.githubRateLimits?.current) {
      const rl = data.githubRateLimits.current;
      el('ghRateRemaining').textContent = `${rl.remaining} / ${rl.limit}`;
      if (rl.reset) {
        const resetMins = Math.max(0, Math.round((rl.reset * 1000 - Date.now()) / 60000));
        el('ghRateReset').textContent = `(resets in ${resetMins}m)`;
      }
    }

    // Top client usage table
    const tbody = el('topClientsTableBody');
    if (!data.clients || !data.clients.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No client traffic recorded yet</td></tr>';
    } else {
      tbody.innerHTML = data.clients.map((c) => `
        <tr>
          <td><strong>${c.name}</strong></td>
          <td>${c.requests.toLocaleString()}</td>
          <td>${formatBytes(c.bytes)}</td>
          <td>${c.lastSeen ? new Date(c.lastSeen).toLocaleTimeString() : 'Never'}</td>
        </tr>
      `).join('');
    }

    // Set webhook default URL
    const origin = data.publicBaseUrl || window.location.origin;
    el('webhookUrlInput').value = `${origin}/v1/webhook`;
  } catch (e) {
    console.error('Failed to load overview:', e);
  }
}

// 2. CLIENTS
async function loadClients() {
  try {
    const list = await api('/api/admin/clients');
    state.clients = list;
    renderClientsTable(list);
    populateSnippetClientSelect(list);
  } catch (e) {
    toast(e.message, 'danger');
  }
}

function renderClientsTable(list) {
  const tbody = el('clientsTableBody');
  const filter = (el('clientSearchInput').value || '').toLowerCase();
  const filtered = list.filter((c) => c.name.toLowerCase().includes(filter) || c.repos.some((r) => r.includes(filter)));

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No matching clients found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((c) => `
    <tr>
      <td>
        <span class="badge ${c.disabled ? 'badge-danger' : 'badge-success'}">
          ${c.disabled ? 'Disabled' : 'Active'}
        </span>
      </td>
      <td><strong>${c.name}</strong></td>
      <td class="text-secondary text-xs">${c.description || '—'}</td>
      <td>${c.repos.map((r) => `<span class="badge badge-outline text-xs">${r}</span>`).join(' ')}</td>
      <td>${c.permissions.map((p) => `<span class="badge text-xs">${p}</span>`).join(' ')}</td>
      <td>${(c.requests || 0).toLocaleString()}</td>
      <td class="text-muted text-xs">${c.lastSeen ? new Date(c.lastSeen).toLocaleString() : 'Never'}</td>
      <td class="text-right">
        <button class="btn-sm btn-outline btn-rotate" data-name="${c.name}">Rotate Key</button>
        <button class="btn-sm ${c.disabled ? 'btn-outline' : 'btn-ghost'} btn-toggle" data-name="${c.name}" data-disabled="${c.disabled}">
          ${c.disabled ? 'Enable' : 'Disable'}
        </button>
        <button class="btn-sm btn-danger btn-delete" data-name="${c.name}">Delete</button>
      </td>
    </tr>
  `).join('');

  // Attach button events
  tbody.querySelectorAll('.btn-rotate').forEach((btn) => {
    btn.onclick = () => rotateClientKey(btn.dataset.name);
  });
  tbody.querySelectorAll('.btn-toggle').forEach((btn) => {
    btn.onclick = () => toggleClientDisabled(btn.dataset.name, btn.dataset.disabled === 'true');
  });
  tbody.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.onclick = () => deleteClient(btn.dataset.name);
  });
}

async function rotateClientKey(name) {
  if (!confirm(`Are you sure you want to rotate the API key for client "${name}"? The previous key will stop working immediately.`)) return;
  try {
    const res = await api(`/api/admin/clients/${encodeURIComponent(name)}/rotate-key`, { method: 'POST' });
    showKeyModal(name, res.key);
    loadClients();
  } catch (e) {
    toast(e.message, 'danger');
  }
}

async function toggleClientDisabled(name, currentlyDisabled) {
  try {
    await api(`/api/admin/clients/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { disabled: !currentlyDisabled },
    });
    toast(`Client ${name} ${currentlyDisabled ? 'enabled' : 'disabled'}`, 'success');
    loadClients();
  } catch (e) {
    toast(e.message, 'danger');
  }
}

async function deleteClient(name) {
  if (!confirm(`Delete client "${name}"? This action cannot be undone.`)) return;
  try {
    await api(`/api/admin/clients/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(`Client ${name} deleted`, 'success');
    loadClients();
  } catch (e) {
    toast(e.message, 'danger');
  }
}

function showKeyModal(clientName, key) {
  el('keyDisplayClientLabel').textContent = `API Key for ${clientName}:`;
  el('keyDisplayValue').textContent = key;
  el('modalKeyDisplay').classList.remove('hidden');
}

// 3. REPOSITORY EXPLORER
async function loadRepos() {
  const container = el('repoList');
  container.innerHTML = '<div class="text-center text-muted p-4">Loading repositories...</div>';
  try {
    const list = await api('/api/admin/repos');
    state.repos = list;
    renderRepoList(list);
  } catch (e) {
    container.innerHTML = `<div class="text-center text-danger p-4">Failed: ${e.message}</div>`;
  }
}

function renderRepoList(list) {
  const container = el('repoList');
  const filter = (el('repoSearchInput').value || '').toLowerCase();
  const filtered = list.filter((r) => r.full_name.toLowerCase().includes(filter));

  if (!filtered.length) {
    container.innerHTML = '<div class="text-center text-muted p-4">No matching repositories</div>';
    return;
  }

  container.innerHTML = filtered.map((r) => `
    <div class="repo-item ${state.selectedRepo?.full_name === r.full_name ? 'selected' : ''}" data-repo="${r.full_name}">
      <div class="repo-name">${r.full_name}</div>
      <div class="repo-desc">${r.description || 'No description'}</div>
    </div>
  `).join('');

  container.querySelectorAll('.repo-item').forEach((item) => {
    item.onclick = () => selectRepo(item.dataset.repo);
  });
}

async function selectRepo(fullName) {
  const repo = state.repos.find((r) => r.full_name === fullName);
  if (!repo) return;
  state.selectedRepo = repo;

  renderRepoList(state.repos);

  el('repoPlaceholder').classList.add('hidden');
  el('repoDetails').classList.remove('hidden');

  el('repoTitle').textContent = repo.full_name;
  el('repoDescription').textContent = repo.description || 'No repository description';
  el('repoVisibilityBadge').textContent = repo.private ? 'Private' : 'Public';
  el('repoBranchBadge').textContent = repo.default_branch || 'main';

  updateSnippet();
  loadReleases(repo.full_name);
}

async function loadReleases(fullName) {
  const container = el('releasesContainer');
  container.innerHTML = '<div class="text-center text-muted p-4">Loading releases...</div>';
  try {
    const list = await api(`/api/admin/repos/${fullName}/releases`);
    state.releases = list;
    renderReleases(list);
  } catch (e) {
    container.innerHTML = `<div class="text-center text-danger p-4">Failed: ${e.message}</div>`;
  }
}

function renderReleases(list) {
  const container = el('releasesContainer');
  if (!list.length) {
    container.innerHTML = '<div class="text-center text-muted p-4">No releases published for this repository yet</div>';
    return;
  }

  container.innerHTML = list.map((rel) => `
    <div class="release-card">
      <div class="release-title-row">
        <span class="release-tag">${rel.tag_name}</span>
        <strong>${rel.name || rel.tag_name}</strong>
        ${rel.prerelease ? '<span class="badge badge-warning">Pre-release</span>' : ''}
        <span class="text-muted text-xs" style="margin-left: auto;">
          Published: ${new Date(rel.published_at).toLocaleDateString()}
        </span>
      </div>
      ${rel.body ? `<p class="text-secondary text-sm">${rel.body.slice(0, 300)}</p>` : ''}

      ${rel.assets && rel.assets.length ? `
        <table class="asset-table">
          <thead>
            <tr>
              <th>Asset File</th>
              <th>Size</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${rel.assets.map((a) => `
              <tr>
                <td><code>${a.name}</code></td>
                <td class="text-muted">${formatBytes(a.size)}</td>
                <td>
                  <a href="${a.download_url}" target="_blank" class="btn-sm btn-outline">Direct URL</a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="text-muted text-xs mt-3">No binary assets attached</div>'}
    </div>
  `).join('');
}

function populateSnippetClientSelect(clients) {
  const sel = el('snippetClientSelect');
  sel.innerHTML = '<option value="">&lt;YOUR_API_KEY&gt;</option>' +
    clients.map((c) => `<option value="${c.name}">${c.name} (${c.keyMasked})</option>`).join('');
}

function updateSnippet() {
  if (!state.selectedRepo) return;
  const repo = state.selectedRepo.full_name;
  const host = state.overviewData?.publicBaseUrl || window.location.origin;
  const key = '<YOUR_API_KEY>';
  const lang = state.snippetLang;

  let code = '';
  switch (lang) {
    case 'curl':
      code = `# Check for updates\ncurl -H "Authorization: Bearer ${key}" \\\n  "${host}/v1/repos/${repo}/update?current=1.0.0"\n\n# Download latest release asset\ncurl -H "Authorization: Bearer ${key}" \\\n  -OJ "${host}/v1/repos/${repo}/releases/assets/<ASSET_ID>"`;
      break;
    case 'ps':
      code = `# Check for updates\n$headers = @{ "Authorization" = "Bearer ${key}" }\n$update = Invoke-RestMethod -Uri "${host}/v1/repos/${repo}/update?current=1.0.0" -Headers $headers\n\n# Download asset if available\nif ($update.update_available) {\n    $asset = $update.release.assets[0]\n    Invoke-WebRequest -Uri $asset.download_url -Headers $headers -OutFile $asset.name\n}`;
      break;
    case 'node':
      code = `// Fetch latest release and assets\nconst res = await fetch('${host}/v1/repos/${repo}/releases/latest', {\n  headers: { 'Authorization': 'Bearer ${key}' }\n});\nconst release = await res.json();\nconsole.log('Latest tag:', release.tag_name);\nconsole.log('Assets:', release.assets);`;
      break;
    case 'python':
      code = `import requests\n\nheaders = {"Authorization": "Bearer ${key}"}\nr = requests.get("${host}/v1/repos/${repo}/update?current=1.0.0", headers=headers)\ndata = r.json()\n\nif data.get("update_available"):\n    print(f"New version available: {data['latest_version']}")\n    asset_url = data["release"]["assets"][0]["download_url"]\n    with requests.get(asset_url, headers=headers, stream=True) as resp:\n        with open("update.bin", "wb") as f:\n            for chunk in resp.iter_content(chunk_size=8192):\n                f.write(chunk)`;
      break;
  }
  el('snippetCode').textContent = code;
}

// 4. LIVE LOGS (SSE)
function handleIncomingLog(log) {
  state.logCounter++;
  el('logCounter').textContent = state.logCounter;

  if (state.isLogPaused) return;

  const tbody = el('terminalTableBody');
  const emptyRow = tbody.querySelector('.log-empty-row');
  if (emptyRow) emptyRow.remove();

  const tr = document.createElement('tr');
  const statusCategory = log.status >= 500 ? '5xx' : log.status >= 400 ? '4xx' : log.status >= 300 ? '3xx' : '2xx';

  tr.innerHTML = `
    <td class="text-muted text-xs">${new Date(log.time).toLocaleTimeString()}</td>
    <td><span class="status-tag tag-${statusCategory}">${log.status}</span></td>
    <td><span class="method ${log.method.toLowerCase()}">${log.method}</span></td>
    <td><code>${log.path}</code></td>
    <td><strong>${log.client || 'anonymous'}</strong></td>
    <td class="text-muted">${log.ip || '—'}</td>
    <td>${log.ms} ms</td>
    <td class="text-muted">${formatBytes(log.bytes)}</td>
  `;

  tbody.insertBefore(tr, tbody.firstChild);

  // Keep max 200 rows in DOM
  while (tbody.children.length > 200) {
    tbody.lastChild.remove();
  }

  if (state.autoScrollLogs) {
    el('terminalContainer').scrollTop = 0;
  }
}

// SSE Connection
function initSSE() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const url = `/api/admin/stream?token=${encodeURIComponent(state.adminToken)}`;
  const es = new EventSource(url);
  state.eventSource = es;

  const statusEl = el('connectionStatus');
  const statusLabel = statusEl.querySelector('.status-label');

  es.onopen = () => {
    statusEl.classList.add('connected');
    statusLabel.textContent = 'Live SSE Connected';
  };

  es.addEventListener('log', (e) => {
    try {
      const log = JSON.parse(e.data);
      handleIncomingLog(log);
    } catch {}
  });

  es.addEventListener('webhook', (e) => {
    try {
      const data = JSON.parse(e.data);
      toast(`Webhook received: ${data.event} (${data.repository || ''})`, 'info');
      loadOverview();
    } catch {}
  });

  es.addEventListener('client_change', () => {
    loadClients();
    loadOverview();
  });

  es.addEventListener('cache_clear', () => {
    loadOverview();
  });

  es.onerror = () => {
    statusEl.classList.remove('connected');
    statusLabel.textContent = 'Reconnecting...';
  };
}

// 5. DIAGNOSTICS & CACHE
async function runDiagnostics() {
  const container = el('diagOutput');
  container.innerHTML = '<span class="text-muted">Running diagnostic probe to GitHub upstream...</span>';
  try {
    const diag = await api('/api/admin/diagnostics');
    container.innerHTML = `<pre>${JSON.stringify(diag, null, 2)}</pre>`;
    toast(`Diagnostics completed: ${diag.ok ? 'Healthy' : 'Degraded'} (${diag.latencyMs}ms)`, diag.ok ? 'success' : 'warning');
  } catch (e) {
    container.innerHTML = `<span class="text-danger">Failed: ${e.message}</span>`;
  }
}

async function loadCacheStats() {
  try {
    const stats = await api('/api/admin/cache');
    el('cacheEntriesCount').textContent = stats.size;
    const listEl = el('cacheEntriesList');
    if (!stats.entries || !stats.entries.length) {
      listEl.innerHTML = '<div class="text-muted text-xs p-2">No active cached entries in memory</div>';
    } else {
      listEl.innerHTML = stats.entries.map((e) => `
        <div class="p-2 border-b text-xs flex justify-between" style="border-bottom: 1px solid #1a253a;">
          <code>${e.path}</code>
          <span class="text-muted">expires: ${new Date(e.expires).toLocaleTimeString()}</span>
        </div>
      `).join('');
    }
  } catch (e) {
    toast(e.message, 'danger');
  }
}

async function purgeCache(pattern = null) {
  try {
    const res = await api('/api/admin/cache/clear', {
      method: 'POST',
      body: { pattern },
    });
    toast(`Purged ${res.clearedEntries} cached entries`, 'success');
    loadCacheStats();
    loadOverview();
  } catch (e) {
    toast(e.message, 'danger');
  }
}

// Event Listeners setup
function setupEventListeners() {
  // Login
  el('btnLoginSubmit').onclick = handleLogin;
  el('inputAdminToken').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  el('btnSwitchToken').onclick = () => showAdminLoginModal();

  // Overview refresh
  el('btnRefreshOverview').onclick = loadOverview;

  // Clients
  el('btnOpenAddClientModal').onclick = () => {
    el('newClientName').value = '';
    el('newClientDesc').value = '';
    el('newClientRepos').value = '*';
    el('modalAddClient').classList.remove('hidden');
  };
  el('btnCloseAddClientModal').onclick = () => el('modalAddClient').classList.add('hidden');
  el('btnCancelAddClient').onclick = () => el('modalAddClient').classList.add('hidden');

  el('btnSaveNewClient').onclick = async () => {
    const name = el('newClientName').value.trim();
    const description = el('newClientDesc').value.trim();
    const repos = el('newClientRepos').value.split(',').map((s) => s.trim()).filter(Boolean);
    const permissions = [];
    if (el('permReleases').checked) permissions.push('releases');
    if (el('permRaw').checked) permissions.push('raw');
    if (el('permArchive').checked) permissions.push('archive');

    if (!name) return toast('Client name is required', 'warning');
    if (!repos.length) return toast('At least one repository pattern is required', 'warning');

    try {
      const res = await api('/api/admin/clients', {
        method: 'POST',
        body: { name, description, repos, permissions },
      });
      el('modalAddClient').classList.add('hidden');
      showKeyModal(res.client.name, res.key);
      loadClients();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };

  el('btnCopyKey').onclick = () => {
    navigator.clipboard.writeText(el('keyDisplayValue').textContent);
    toast('API key copied to clipboard!', 'success');
  };
  el('btnCloseKeyModal').onclick = () => el('modalKeyDisplay').classList.add('hidden');
  el('btnDoneKeyDisplay').onclick = () => el('modalKeyDisplay').classList.add('hidden');

  el('clientSearchInput').oninput = () => renderClientsTable(state.clients);

  // Explorer
  el('btnRefreshRepos').onclick = loadRepos;
  el('repoSearchInput').oninput = () => renderRepoList(state.repos);
  el('btnRefreshReleases').onclick = () => {
    if (state.selectedRepo) loadReleases(state.selectedRepo.full_name);
  };

  document.querySelectorAll('.snippet-tab-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.snippet-tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.snippetLang = btn.dataset.lang;
      updateSnippet();
    };
  });

  el('btnCopySnippet').onclick = () => {
    navigator.clipboard.writeText(el('snippetCode').textContent);
    toast('Snippet copied to clipboard!', 'success');
  };

  // Live logs
  el('btnToggleLogPause').onclick = () => {
    state.isLogPaused = !state.isLogPaused;
    el('btnToggleLogPause').textContent = state.isLogPaused ? '▶️ Resume Stream' : '⏸️ Pause Stream';
  };
  el('btnClearLogs').onclick = () => {
    el('terminalTableBody').innerHTML = '<tr class="log-empty-row"><td colspan="8" class="text-center text-muted">Awaiting incoming proxy requests...</td></tr>';
    state.logCounter = 0;
    el('logCounter').textContent = '0';
  };
  el('chkAutoScroll').onchange = (e) => {
    state.autoScrollLogs = e.target.checked;
  };

  // Diagnostics
  el('btnRunDiagnostics').onclick = runDiagnostics;
  el('btnPurgeAllCache').onclick = () => purgeCache();
  el('btnPurgePattern').onclick = () => {
    const pattern = el('cachePurgePatternInput').value.trim();
    if (pattern) purgeCache(pattern);
  };
  el('btnCopyWebhookUrl').onclick = () => {
    navigator.clipboard.writeText(el('webhookUrlInput').value);
    toast('Webhook URL copied!', 'success');
  };
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupEventListeners();

  if (!state.adminToken) {
    showAdminLoginModal();
  } else {
    initSSE();
    loadOverview();
  }

  // Periodic overview refresh every 10 seconds
  setInterval(() => {
    if (state.activeTab === 'overview' && state.adminToken) {
      loadOverview();
    }
  }, 10000);
});
