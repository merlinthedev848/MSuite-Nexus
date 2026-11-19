// MSuite Nexus - Frontend Application Architecture
const state = {
  adminToken: localStorage.getItem('msuite_admin_token') || '',
  activeTab: 'overview',
  overviewData: null,
  clients: [],
  repos: [],
  selectedRepo: null,
  releases: [],
  selectedChannel: 'all',
  logs: [],
  logCounter: 0,
  isLogPaused: false,
  autoScrollLogs: true,
  snippetLang: 'curl',
  eventSource: null,
  assetStats: null,
};

// Utilities
const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

function flashCopyButton(btn) {
  const original = btn.textContent;
  btn.textContent = '✓ Copied!';
  btn.classList.add('btn-primary');
  setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('btn-primary');
  }, 1500);
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
  el('inputAdminToken').focus();
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
    case 'sandbox':
      populateSandboxClientSelect();
      break;
    case 'services':
      loadServices();
      break;
    case 'bus':
      loadBus();
      break;
    case 'live-logs':
      renderLogsTable();
      break;
    case 'audit':
      loadAuditLogs();
      break;
    case 'diagnostics':
      loadCacheStats();
      loadAssetCacheStats();
      break;
    case 'settings':
      loadSettings();
      break;
  }
}

// 1. OVERVIEW & SPARKLINE
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
    const saved = data.assetCache?.bytesSaved || 0;
    el('statAssetSavedSub').textContent = `${formatBytes(saved)} saved by disk cache`;

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

    // Sparkline Canvas Rendering
    if (data.throughput) {
      renderThroughputSparkline(data.throughput);
    }

    // Top client usage table
    const tbody = el('topClientsTableBody');
    if (!data.clients || !data.clients.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No client traffic recorded yet</td></tr>';
    } else {
      tbody.innerHTML = data.clients.map((c) => `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${c.requests.toLocaleString()}</td>
          <td>${formatBytes(c.bytes)}</td>
          <td>${c.lastSeen ? new Date(c.lastSeen).toLocaleTimeString() : 'Never'}</td>
        </tr>
      `).join('');
    }

    const origin = data.publicBaseUrl || window.location.origin;
    el('webhookUrlInput').value = `${origin}/v1/webhook`;
  } catch (e) {
    console.error('Failed to load overview:', e);
  }
}

function renderThroughputSparkline(data) {
  const canvas = el('throughputCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);

  const values = data.map((d) => d.count);
  const maxVal = Math.max(...values, 5);
  const current = values[values.length - 1] || 0;
  el('currentThroughputBadge').textContent = `${current} req/min`;

  const paddingX = 20;
  const paddingY = 15;
  const plotW = w - paddingX * 2;
  const plotH = h - paddingY * 2;
  const stepX = plotW / (values.length - 1);

  // Gradient area
  ctx.beginPath();
  values.forEach((v, idx) => {
    const x = paddingX + idx * stepX;
    const y = h - paddingY - (v / maxVal) * plotH;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(paddingX + (values.length - 1) * stepX, h - paddingY);
  ctx.lineTo(paddingX, h - paddingY);
  ctx.closePath();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(56, 189, 248, 0.3)');
  grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  values.forEach((v, idx) => {
    const x = paddingX + idx * stepX;
    const y = h - paddingY - (v / maxVal) * plotH;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Dots
  values.forEach((v, idx) => {
    const x = paddingX + idx * stepX;
    const y = h - paddingY - (v / maxVal) * plotH;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = idx === values.length - 1 ? '#00f0ff' : '#0284c7';
    ctx.fill();
  });
}

// 2. CLIENTS
async function loadClients() {
  try {
    const list = await api('/api/admin/clients');
    state.clients = list;
    renderClientsTable(list);
    populateSnippetClientSelect(list);
    populateSandboxClientSelect();
  } catch (e) {
    toast(e.message, 'danger');
  }
}

function renderClientsTable(list) {
  const hero = el('onboardingHeroCard');
  if (hero) {
    if (!list || !list.length) hero.classList.remove('hidden');
    else hero.classList.add('hidden');
  }

  const tbody = el('clientsTableBody');
  const filter = (el('clientSearchInput').value || '').toLowerCase();
  const filtered = list.filter((c) =>
    c.name.toLowerCase().includes(filter) ||
    c.repos.some((r) => r.includes(filter)) ||
    (c.allowedIps && c.allowedIps.some((ip) => ip.includes(filter)))
  );

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">No matching clients found</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    let statusBadge = '<span class="badge badge-success">Active</span>';
    if (c.disabled) {
      statusBadge = '<span class="badge badge-danger">Disabled</span>';
    } else if (c.isExpired) {
      statusBadge = '<span class="badge badge-warning">Expired</span>';
    }

    const expStr = c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : 'Never';
    const ipsStr = c.allowedIps?.length ? c.allowedIps.join(', ') : '*';

    return `
      <tr>
        <td>${statusBadge}</td>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td class="text-secondary text-xs">${escapeHtml(c.description || '—')}</td>
        <td>${c.repos.map((r) => `<span class="badge badge-outline text-xs">${escapeHtml(r)}</span>`).join(' ')}</td>
        <td>${c.permissions.map((p) => `<span class="badge text-xs">${escapeHtml(p)}</span>`).join(' ')}</td>
        <td><code>${escapeHtml(ipsStr)}</code></td>
        <td class="text-xs text-muted">${expStr}</td>
        <td>${(c.requests || 0).toLocaleString()}</td>
        <td class="text-muted text-xs">${c.lastSeen ? new Date(c.lastSeen).toLocaleTimeString() : 'Never'}</td>
        <td class="text-right">
          <button class="btn-sm btn-outline btn-rotate" data-name="${escapeHtml(c.name)}">Rotate</button>
          <button class="btn-sm ${c.disabled ? 'btn-outline' : 'btn-ghost'} btn-toggle" data-name="${escapeHtml(c.name)}" data-disabled="${c.disabled}">
            ${c.disabled ? 'Enable' : 'Disable'}
          </button>
          <button class="btn-sm btn-danger btn-delete" data-name="${escapeHtml(c.name)}">Delete</button>
        </td>
      </tr>
    `;
  }).join('');

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
  if (!confirm(`Rotate API key for client "${name}"? Previous key will stop working immediately.`)) return;
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
    container.innerHTML = `<div class="text-center text-danger p-4">Failed: ${escapeHtml(e.message)}</div>`;
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
    <div class="repo-item ${state.selectedRepo?.full_name === r.full_name ? 'selected' : ''}" data-repo="${escapeHtml(r.full_name)}">
      <div class="repo-name">${escapeHtml(r.full_name)}</div>
      <div class="repo-desc">${escapeHtml(r.description || 'No description')}</div>
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
    container.innerHTML = `<div class="text-center text-danger p-4">Failed: ${escapeHtml(e.message)}</div>`;
  }
}

function renderReleases(list) {
  const container = el('releasesContainer');
  let filtered = list;
  if (state.selectedChannel === 'stable') {
    filtered = list.filter((r) => !r.prerelease && !/-alpha|-beta|-rc/i.test(r.tag_name));
  } else if (state.selectedChannel === 'beta') {
    filtered = list.filter((r) => r.prerelease || /-alpha|-beta|-rc/i.test(r.tag_name));
  }

  if (!filtered.length) {
    container.innerHTML = '<div class="text-center text-muted p-4">No releases found matching this channel</div>';
    return;
  }

  container.innerHTML = filtered.map((rel) => `
    <div class="release-card">
      <div class="release-title-row">
        <span class="release-tag">${escapeHtml(rel.tag_name)}</span>
        <strong>${escapeHtml(rel.name || rel.tag_name)}</strong>
        ${rel.prerelease ? '<span class="badge badge-warning">Pre-release</span>' : '<span class="badge badge-success">Stable</span>'}
        <span class="text-muted text-xs" style="margin-left: auto;">
          Published: ${new Date(rel.published_at).toLocaleDateString()}
        </span>
      </div>
      ${rel.body ? `<p class="text-secondary text-sm">${escapeHtml(rel.body.slice(0, 300))}</p>` : ''}

      ${rel.assets && rel.assets.length ? `
        <table class="asset-table">
          <thead>
            <tr>
              <th>Asset File</th>
              <th>Size</th>
              <th>Disk Cache</th>
              <th class="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rel.assets.map((a) => `
              <tr>
                <td><code>${escapeHtml(a.name)}</code></td>
                <td class="text-muted">${formatBytes(a.size)}</td>
                <td>
                  ${a.cachedLocally
                    ? '<span class="cached-indicator">💾 Cached Locally</span>'
                    : '<span class="text-muted text-xs">☁️ On GitHub</span>'}
                </td>
                <td class="text-right">
                  ${!a.cachedLocally ? `
                    <button class="btn-sm btn-outline btn-prewarm" data-id="${a.id}" data-name="${escapeHtml(a.name)}">Pre-warm to Disk</button>
                  ` : ''}
                  <a href="${a.download_url}" target="_blank" class="btn-sm btn-outline">Direct URL</a>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : '<div class="text-muted text-xs mt-3">No binary assets attached</div>'}
    </div>
  `).join('');

  container.querySelectorAll('.btn-prewarm').forEach((btn) => {
    btn.onclick = async () => {
      btn.textContent = 'Caching...';
      btn.disabled = true;
      try {
        const [owner, repo] = state.selectedRepo.full_name.split('/');
        await api('/api/admin/asset-cache/prefetch', {
          method: 'POST',
          body: { owner, repo, assetId: btn.dataset.id, name: btn.dataset.name },
        });
        toast(`Pre-warming initiated for ${btn.dataset.name}`, 'info');
      } catch (e) {
        toast(e.message, 'danger');
        btn.disabled = false;
        btn.textContent = 'Pre-warm to Disk';
      }
    };
  });
}

function populateSnippetClientSelect(clients) {
  const sel = el('snippetClientSelect');
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">&lt;YOUR_API_KEY&gt;</option>' +
    clients.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${c.keyMasked})</option>`).join('');
  if (currentVal) sel.value = currentVal;
}

function updateSnippet() {
  if (!state.selectedRepo) return;
  const repo = state.selectedRepo.full_name;
  const host = state.overviewData?.publicBaseUrl || window.location.origin;
  const selectedClient = el('snippetClientSelect')?.value;
  const key = selectedClient ? `process.env.${selectedClient.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY` : '<YOUR_API_KEY>';
  const lang = state.snippetLang;

  let code = '';
  switch (lang) {
    case 'curl':
      code = `# Check for stable updates\ncurl -H "Authorization: Bearer ${selectedClient ? `$${selectedClient.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY` : '<YOUR_API_KEY>'}" \\\n  "${host}/v1/repos/${repo}/update?current=1.0.0&channel=stable"\n\n# Download latest release asset (with resume/range support)\ncurl -H "Authorization: Bearer ${selectedClient ? `$${selectedClient.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY` : '<YOUR_API_KEY>'}" \\\n  -C - -OJ "${host}/v1/repos/${repo}/releases/assets/<ASSET_ID>"`;
      break;
    case 'ps':
      code = `# Check for updates\n$key = ${selectedClient ? `$env:${selectedClient.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY` : '"<YOUR_API_KEY>"'}\n$headers = @{ "Authorization" = "Bearer $key" }\n$update = Invoke-RestMethod -Uri "${host}/v1/repos/${repo}/update?current=1.0.0" -Headers $headers\n\nif ($update.update_available) {\n    $asset = $update.release.assets[0]\n    Invoke-WebRequest -Uri $asset.download_url -Headers $headers -OutFile $asset.name\n}`;
      break;
    case 'node':
      code = `// Fetch latest release and assets\nconst key = ${key};\nconst res = await fetch('${host}/v1/repos/${repo}/releases/latest', {\n  headers: { 'Authorization': \`Bearer \${key}\` }\n});\nconst release = await res.json();\nconsole.log('Latest tag:', release.tag_name);\nconsole.log('Assets:', release.assets);`;
      break;
    case 'python':
      code = `import os, requests\n\nkey = os.getenv("${selectedClient ? selectedClient.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_KEY' : 'NEXUS_API_KEY'}", "<YOUR_API_KEY>")\nheaders = {"Authorization": f"Bearer {key}"}\nr = requests.get("${host}/v1/repos/${repo}/update?current=1.0.0", headers=headers)\ndata = r.json()\n\nif data.get("update_available"):\n    print(f"New version available: {data['latest_version']}")\n    asset_url = data["release"]["assets"][0]["download_url"]\n    with requests.get(asset_url, headers=headers, stream=True) as resp:\n        with open("update.bin", "wb") as f:\n            for chunk in resp.iter_content(chunk_size=8192):\n                f.write(chunk)`;
      break;
  }
  el('snippetCode').textContent = code;
}

// 4. API SANDBOX
function populateSandboxClientSelect() {
  const sel = el('sandboxClientSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">(No API Key - Anonymous)</option>' +
    state.clients.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`).join('');
  if (cur) sel.value = cur;
}

async function executeSandboxRequest() {
  const path = el('sandboxPathInput').value.trim();
  const method = el('sandboxMethod').value;
  const clientName = el('sandboxClientSelect').value;
  const rawBody = el('sandboxBodyInput')?.value.trim();

  if (!path) return toast('Request path cannot be empty', 'warning');

  const card = el('sandboxResultCard');
  card.classList.remove('hidden');
  el('sandboxResponseBody').textContent = 'Executing request...';

  let parsedBody = undefined;
  if (method !== 'GET' && rawBody) {
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = rawBody;
    }
  }

  try {
    const res = await api('/api/admin/tester', {
      method: 'POST',
      body: { path, method, clientName: clientName || null, body: parsedBody },
    });

    const statusTag = el('sandboxStatusTag');
    statusTag.textContent = `${res.status} ${res.ok ? 'OK' : 'Error'}`;
    statusTag.className = `status-tag ${res.ok ? 'tag-2xx' : 'tag-4xx'}`;

    el('sandboxLatency').textContent = `⏱️ ${res.latencyMs} ms`;
    el('sandboxResponseBody').textContent = typeof res.body === 'object'
      ? JSON.stringify(res.body, null, 2)
      : String(res.body);
  } catch (e) {
    el('sandboxResponseBody').textContent = `Request failed: ${e.message}`;
  }
}

// 5. LIVE LOGS (SSE & REAL-TIME FILTERING)
function handleIncomingLog(log) {
  state.logCounter++;
  el('logCounter').textContent = state.logCounter;

  state.logs.unshift(log);
  if (state.logs.length > 200) state.logs.pop();

  if (state.activeTab === 'live-logs') {
    renderLogsTable();
  }
}

function renderLogsTable() {
  if (state.isLogPaused) return;

  const tbody = el('terminalTableBody');
  const filter = (el('logFilterInput').value || '').toLowerCase().trim();

  const filtered = state.logs.filter((log) => {
    if (!filter) return true;
    return (
      (log.path && log.path.toLowerCase().includes(filter)) ||
      (log.client && log.client.toLowerCase().includes(filter)) ||
      (log.method && log.method.toLowerCase().includes(filter)) ||
      (log.ip && log.ip.toLowerCase().includes(filter)) ||
      String(log.status).includes(filter)
    );
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr class="log-empty-row"><td colspan="8" class="text-center text-muted">Awaiting matching proxy requests...</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((log) => {
    const statusCategory = log.status >= 500 ? '5xx' : log.status >= 400 ? '4xx' : log.status >= 300 ? '3xx' : '2xx';
    return `
      <tr>
        <td class="text-muted text-xs">${new Date(log.time).toLocaleTimeString()}</td>
        <td><span class="status-tag tag-${statusCategory}">${log.status}</span></td>
        <td><span class="method ${log.method.toLowerCase()}">${escapeHtml(log.method)}</span></td>
        <td><code>${escapeHtml(log.path)}</code></td>
        <td><strong>${escapeHtml(log.client || 'anonymous')}</strong></td>
        <td class="text-muted">${escapeHtml(log.ip || '—')}</td>
        <td>${log.ms} ms</td>
        <td class="text-muted">${formatBytes(log.bytes)}</td>
      </tr>
    `;
  }).join('');

  if (state.autoScrollLogs && el('terminalContainer')) {
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

  es.addEventListener('asset_cached', (e) => {
    try {
      const d = JSON.parse(e.data);
      toast(`Asset "${d.name}" cached locally on disk`, 'success');
      loadOverview();
      if (state.selectedRepo) loadReleases(state.selectedRepo.full_name);
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

// 6. AUDIT TRAIL
async function loadAuditLogs() {
  const tbody = el('auditTableBody');
  tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Loading audit entries...</td></tr>';
  try {
    const list = await api('/api/admin/audit?limit=100');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No audit events recorded yet</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((a) => `
      <tr>
        <td class="text-muted text-xs">${new Date(a.timestamp).toLocaleString()}</td>
        <td><strong>${escapeHtml(a.actor)}</strong></td>
        <td><span class="badge badge-outline">${escapeHtml(a.action)}</span></td>
        <td><code>${escapeHtml(a.target || '—')}</code></td>
        <td class="text-muted text-xs">${escapeHtml(a.ip)}</td>
        <td class="text-secondary text-xs">${escapeHtml(JSON.stringify(a.details || {}))}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">${escapeHtml(e.message)}</td></tr>`;
  }
}

// 7. DIAGNOSTICS & CACHE
async function runDiagnostics() {
  const container = el('diagOutput');
  container.innerHTML = '<span class="text-muted">Running diagnostic probe to GitHub upstream...</span>';
  try {
    const diag = await api('/api/admin/diagnostics');
    container.innerHTML = `<pre>${escapeHtml(JSON.stringify(diag, null, 2))}</pre>`;
    toast(`Diagnostics completed: ${diag.ok ? 'Healthy' : 'Degraded'} (${diag.latencyMs}ms)`, diag.ok ? 'success' : 'warning');
  } catch (e) {
    container.innerHTML = `<span class="text-danger">Failed: ${escapeHtml(e.message)}</span>`;
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
          <code>${escapeHtml(e.path)}</code>
          <span class="text-muted">expires: ${new Date(e.expires).toLocaleTimeString()}</span>
        </div>
      `).join('');
    }
  } catch (e) {
    toast(e.message, 'danger');
  }
}

async function loadAssetCacheStats() {
  try {
    const data = await api('/api/admin/asset-cache');
    state.assetStats = data;
    el('diskCacheBandwidthSaved').textContent = `${formatBytes(data.bytesSaved || 0)} saved`;

    const tbody = el('assetCacheTableBody');
    if (!data.items || !data.items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No release binaries cached on disk yet</td></tr>';
      return;
    }

    tbody.innerHTML = data.items.map((item) => `
      <tr>
        <td><code>${escapeHtml(item.assetId)}</code></td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td>${formatBytes(item.size)}</td>
        <td>${(item.hitCount || 0).toLocaleString()}</td>
        <td class="text-muted text-xs">${new Date(item.cachedAt).toLocaleDateString()}</td>
        <td class="text-muted text-xs">${item.lastAccessed ? new Date(item.lastAccessed).toLocaleTimeString() : '—'}</td>
        <td class="text-right">
          <button class="btn-sm btn-danger btn-purge-asset" data-id="${escapeHtml(item.assetId)}">Purge</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-purge-asset').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/api/admin/asset-cache/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
          toast(`Asset ${btn.dataset.id} purged from disk`, 'success');
          loadAssetCacheStats();
          loadOverview();
        } catch (e) {
          toast(e.message, 'danger');
        }
      };
    });
  } catch (e) {
    console.error('Failed to load asset cache:', e);
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

// 8. SERVICE GATEWAY
async function loadServices() {
  const tbody = el('servicesTableBody');
  tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Loading registered services...</td></tr>';
  try {
    const list = await api('/api/admin/services');
    state.services = list;
    renderServicesTable(list);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderServicesTable(list) {
  const tbody = el('servicesTableBody');
  const filter = (el('serviceSearchInput')?.value || '').toLowerCase();
  const filtered = list.filter((s) => s.id.toLowerCase().includes(filter) || s.name.toLowerCase().includes(filter) || s.target.toLowerCase().includes(filter));

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">No upstream services registered yet</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((s) => `
    <tr>
      <td>${s.enabled ? '<span class="badge badge-success">Online</span>' : '<span class="badge badge-danger">Disabled</span>'}</td>
      <td><code>${escapeHtml(s.id)}</code></td>
      <td><strong>${escapeHtml(s.name)}</strong><br><span class="text-secondary text-xs">${escapeHtml(s.description || '—')}</span></td>
      <td><code>${escapeHtml(s.target)}</code></td>
      <td><span class="badge badge-outline">/v1/services/${escapeHtml(s.id)}/*</span></td>
      <td><code>${escapeHtml(s.allowedClients.join(', '))}</code></td>
      <td><span class="text-xs text-muted">${s.authHeaderMasked ? '🔑 Injected' : 'None'}</span></td>
      <td class="text-right">
        <button class="btn-sm btn-outline btn-test-service" data-id="${escapeHtml(s.id)}">Test Ping</button>
        <button class="btn-sm btn-danger btn-delete-service" data-id="${escapeHtml(s.id)}">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-test-service').forEach((btn) => {
    btn.onclick = async () => {
      btn.textContent = 'Testing...';
      try {
        const res = await api(`/api/admin/services/${encodeURIComponent(btn.dataset.id)}/test`, { method: 'POST' });
        toast(`Service ${btn.dataset.id}: HTTP ${res.status} (${res.latencyMs}ms)`, res.ok ? 'success' : 'warning');
      } catch (e) {
        toast(`Ping failed: ${e.message}`, 'danger');
      } finally {
        btn.textContent = 'Test Ping';
      }
    };
  });

  tbody.querySelectorAll('.btn-delete-service').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Delete upstream service "${btn.dataset.id}"?`)) return;
      try {
        await api(`/api/admin/services/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
        toast(`Service ${btn.dataset.id} deleted`, 'success');
        loadServices();
      } catch (e) {
        toast(e.message, 'danger');
      }
    };
  });
}

// 9. MESSAGE BUS
async function loadBus() {
  const tbody = el('busHistoryTableBody');
  tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Loading message stream...</td></tr>';
  try {
    const data = await api('/api/admin/bus');
    if (!data.recent || !data.recent.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No message bus events recorded yet</td></tr>';
      return;
    }

    tbody.innerHTML = data.recent.map((m) => `
      <tr>
        <td class="text-muted text-xs">${new Date(m.timestamp).toLocaleTimeString()}</td>
        <td><span class="badge">${escapeHtml(m.topic)}</span></td>
        <td><strong>${escapeHtml(m.sender)}</strong></td>
        <td><code>${escapeHtml(m.id.slice(0, 8))}...</code></td>
        <td class="text-xs"><code>${escapeHtml(JSON.stringify(m.payload))}</code></td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">${escapeHtml(e.message)}</td></tr>`;
  }
}

async function publishBusEvent() {
  const topic = el('busTopicInput').value.trim();
  const rawPayload = el('busPayloadInput').value.trim();
  if (!topic) return toast('Event topic is required', 'warning');

  let payload = {};
  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = { text: rawPayload };
    }
  }

  try {
    await api('/api/admin/bus/publish', {
      method: 'POST',
      body: { topic, payload },
    });
    toast(`Event published to topic "${topic}"`, 'success');
    el('busTopicInput').value = '';
    el('busPayloadInput').value = '';
    loadBus();
  } catch (e) {
    toast(e.message, 'danger');
  }
}

// 9. SETTINGS & FLEET PROVISIONING
async function loadSettings() {
  try {
    const s = await api('/api/admin/settings');
    el('settingPublicBaseUrl').value = s.publicBaseUrl || '';
    el('settingRateLimit').value = s.rateLimitPerMinute || 120;
    el('settingCacheTtl').value = s.cacheTtlSeconds || 60;
    el('settingLogRequests').value = s.logRequests ? 'true' : 'false';

    el('settingClientsFile').textContent = s.clientsFile || './clients.json';
    el('settingServicesFile').textContent = s.servicesFile || './services.json';
    el('settingAssetCacheDir').textContent = s.assetCacheDir || './.cache/assets';
    el('settingAuditLogFile').textContent = s.auditLogFile || './.cache/audit.jsonl';

    el('settingTokensCount').textContent = `${s.githubTokensCount} Token${s.githubTokensCount > 1 ? 's' : ''} Active`;
    el('settingGithubApiUrl').textContent = s.githubApiUrl;
    el('settingWebhookStatus').textContent = s.webhookConfigured ? 'Configured (Active)' : 'Not Set (Optional)';
  } catch (e) {
    toast(e.message, 'danger');
  }
}

async function saveSettings() {
  const publicBaseUrl = el('settingPublicBaseUrl').value.trim();
  const rateLimitPerMinute = parseInt(el('settingRateLimit').value, 10);
  const cacheTtlSeconds = parseInt(el('settingCacheTtl').value, 10);
  const logRequests = el('settingLogRequests').value === 'true';

  try {
    await api('/api/admin/settings', {
      method: 'PUT',
      body: { publicBaseUrl, rateLimitPerMinute, cacheTtlSeconds, logRequests },
    });
    toast('Settings saved successfully!', 'success');
  } catch (e) {
    toast(e.message, 'danger');
  }
}

// Fleet Provisioning Modal
function openProvisionFleetModal() {
  el('fleetResultsContainer').classList.add('hidden');
  el('modalProvisionFleet').classList.remove('hidden');
  el('fleetOrgInput').focus();
}

function closeProvisionFleetModal() {
  el('modalProvisionFleet').classList.add('hidden');
}

let lastFleetEnv = '';

async function executeFleetProvision() {
  const org = el('fleetOrgInput').value.trim() || 'merlinthedev848';
  const overwrite = el('chkFleetOverwrite').checked;

  const btn = el('btnExecuteFleetProvision');
  btn.disabled = true;
  btn.textContent = 'Provisioning...';

  try {
    const res = await api('/api/admin/fleet/provision', {
      method: 'POST',
      body: { org, overwrite },
    });

    lastFleetEnv = res.envText;
    el('fleetEnvCode').textContent = res.envText;

    const tbody = el('fleetProvisionTableBody');
    tbody.innerHTML = res.provisioned.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong><br><span class="text-secondary text-xs">${escapeHtml(p.description)}</span></td>
        <td>${p.permissions.map((perm) => `<span class="badge text-xs">${escapeHtml(perm)}</span>`).join(' ')}</td>
        <td><code>${escapeHtml(p.repos.join(', '))}</code></td>
        <td><code>${p.key.startsWith('(') ? `<span class="text-muted">${escapeHtml(p.key)}</span>` : escapeHtml(p.key.slice(0, 16) + '...')}</code></td>
        <td>
          ${p.key.startsWith('(') ? '—' : `<button class="btn-sm btn-outline btn-copy-single-key" data-key="${escapeHtml(p.key)}">Copy</button>`}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-copy-single-key').forEach((b) => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.key);
        flashCopyButton(b);
        toast('Key copied!', 'success');
      };
    });

    el('fleetResultsContainer').classList.remove('hidden');
    toast(`Provisioned ${res.provisioned.length} MSuite products successfully!`, 'success');
    loadClients();
  } catch (e) {
    toast(e.message, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>⚡</span> Provision Entire Fleet';
  }
}

function downloadFleetEnv() {
  if (!lastFleetEnv) return;
  const blob = new Blob([lastFleetEnv], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '.env.msuite';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Downloaded .env.msuite!', 'success');
}

// 10. INTERACTIVE SETUP WIZARD
let wizardCurrentStep = 1;
let lastWizardEnv = '';

async function openSetupWizard() {
  wizardCurrentStep = 1;
  updateWizardUI();
  if (el('wizardGithubTestResult')) el('wizardGithubTestResult').innerHTML = '';
  el('modalSetupWizard').classList.remove('hidden');

  try {
    const s = await api('/api/admin/settings');
    if (s.publicBaseUrl) el('wizardPublicUrl').value = s.publicBaseUrl;
    else if (!el('wizardPublicUrl').value) el('wizardPublicUrl').value = window.location.origin;

    if (s.rateLimitPerMinute) el('wizardRateLimit').value = s.rateLimitPerMinute;
    el('wizardAdminToken').value = state.adminToken || '';
  } catch {}
}

function closeSetupWizard() {
  el('modalSetupWizard').classList.add('hidden');
}

function updateWizardUI() {
  for (let i = 1; i <= 5; i++) {
    const ind = el(`wizStepInd${i}`);
    const pane = el(`wizardPane${i}`);
    if (ind) {
      ind.classList.remove('active', 'completed');
      if (i === wizardCurrentStep) ind.classList.add('active');
      else if (i < wizardCurrentStep) ind.classList.add('completed');
    }
    if (pane) {
      if (i === wizardCurrentStep) pane.classList.add('active');
      else pane.classList.remove('active');
    }
  }

  const prevBtn = el('btnWizardPrev');
  const nextBtn = el('btnWizardNext');
  const finishBtn = el('btnWizardFinish');
  const skipBtn = el('btnWizardSkip');

  if (wizardCurrentStep === 1) {
    prevBtn.style.visibility = 'hidden';
    nextBtn.textContent = 'Next: GitHub Token →';
    nextBtn.classList.remove('hidden');
    finishBtn.classList.add('hidden');
    skipBtn.classList.remove('hidden');
  } else if (wizardCurrentStep === 2) {
    prevBtn.style.visibility = 'visible';
    nextBtn.textContent = 'Next: Fleet Keys →';
    nextBtn.classList.remove('hidden');
    finishBtn.classList.add('hidden');
    skipBtn.classList.remove('hidden');
  } else if (wizardCurrentStep === 3) {
    prevBtn.style.visibility = 'visible';
    nextBtn.textContent = 'Next: Service Gateway →';
    nextBtn.classList.remove('hidden');
    finishBtn.classList.add('hidden');
    skipBtn.classList.remove('hidden');
  } else if (wizardCurrentStep === 4) {
    prevBtn.style.visibility = 'visible';
    nextBtn.textContent = 'Finish & Initialize Fleet ⚡';
    nextBtn.classList.remove('hidden');
    finishBtn.classList.add('hidden');
    skipBtn.classList.remove('hidden');
  } else if (wizardCurrentStep === 5) {
    prevBtn.style.visibility = 'hidden';
    nextBtn.classList.add('hidden');
    finishBtn.classList.remove('hidden');
    skipBtn.classList.add('hidden');
  }
}

async function testWizardGithub() {
  const token = el('wizardGithubToken').value.trim();
  const resEl = el('wizardGithubTestResult');
  resEl.innerHTML = '<span class="text-secondary">Testing connection...</span>';

  try {
    const data = await api('/api/admin/wizard/test-github', {
      method: 'POST',
      body: { token },
    });

    if (data.ok) {
      resEl.innerHTML = `<span class="text-emerald">✓ Connected successfully to GitHub! Authenticated as <strong>${escapeHtml(data.user?.login || 'PAT User')}</strong> (Quota remaining: ${data.rateLimit?.remaining ?? '5000'})</span>`;
    } else {
      resEl.innerHTML = `<span class="text-danger">⚠️ ${escapeHtml(data.error || 'Connection failed')}</span>`;
    }
  } catch (e) {
    resEl.innerHTML = `<span class="text-danger">⚠️ ${escapeHtml(e.message)}</span>`;
  }
}

async function handleWizardNext() {
  if (wizardCurrentStep === 1) {
    const url = el('wizardPublicUrl').value.trim();
    if (!url) return toast('Public Base URL is required', 'warning');
    wizardCurrentStep = 2;
    updateWizardUI();
  } else if (wizardCurrentStep === 2) {
    const org = el('wizardGithubOrg').value.trim();
    if (!org) return toast('GitHub Organization / Owner is required', 'warning');
    wizardCurrentStep = 3;
    updateWizardUI();
  } else if (wizardCurrentStep === 3) {
    wizardCurrentStep = 4;
    updateWizardUI();
  } else if (wizardCurrentStep === 4) {
    await finishWizardSetup();
  }
}

function handleWizardPrev() {
  if (wizardCurrentStep > 1 && wizardCurrentStep < 5) {
    wizardCurrentStep--;
    updateWizardUI();
  }
}

async function finishWizardSetup() {
  const nextBtn = el('btnWizardNext');
  nextBtn.disabled = true;
  nextBtn.textContent = 'Configuring Nexus...';

  try {
    const publicBaseUrl = el('wizardPublicUrl').value.trim();
    const adminToken = el('wizardAdminToken').value.trim();
    const rateLimitPerMinute = parseInt(el('wizardRateLimit').value, 10);
    const org = el('wizardGithubOrg').value.trim() || 'merlinthedev848';
    const githubToken = el('wizardGithubToken').value.trim();

    const products = {
      universal: el('wizProdUniversal').checked,
      sip: el('wizProdSip').checked,
      sentinel: el('wizProdSentinel').checked,
      honeypot: el('wizProdHoneypot').checked,
      mstream: el('wizProdMstream').checked,
      nexus: el('wizProdNexus').checked,
    };

    const enableService = el('wizEnableTelemetryService').checked;
    const service = enableService ? {
      enabled: true,
      id: el('wizServiceId').value.trim(),
      target: el('wizServiceTarget').value.trim(),
      authHeader: el('wizServiceAuth').value.trim(),
    } : null;

    const res = await api('/api/admin/wizard/complete', {
      method: 'POST',
      body: {
        publicBaseUrl,
        adminToken,
        rateLimitPerMinute,
        org,
        githubToken,
        products,
        service,
      },
    });

    if (adminToken && adminToken !== state.adminToken) {
      state.adminToken = adminToken;
      localStorage.setItem('msuite_admin_token', adminToken);
    }

    lastWizardEnv = res.envText;
    el('wizardEnvCode').textContent = res.envText;

    const tbody = el('wizardResultsTableBody');
    tbody.innerHTML = res.provisioned.map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${p.permissions.map((perm) => `<span class="badge text-xs">${escapeHtml(perm)}</span>`).join(' ')}</td>
        <td><code>${escapeHtml(p.key.slice(0, 16) + '...')}</code></td>
        <td>
          <button class="btn-sm btn-outline btn-copy-wiz-key" data-key="${escapeHtml(p.key)}">Copy</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-copy-wiz-key').forEach((b) => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.key);
        flashCopyButton(b);
        toast('Key copied!', 'success');
      };
    });

    localStorage.setItem('msuite_wizard_completed', 'true');
    wizardCurrentStep = 5;
    updateWizardUI();
    toast('Setup completed successfully!', 'success');
    loadClients();
    loadOverview();
  } catch (e) {
    toast(e.message, 'danger');
  } finally {
    nextBtn.disabled = false;
  }
}

// Event Listeners setup
function setupEventListeners() {
  // Login
  el('btnLoginSubmit').onclick = handleLogin;
  el('btnCloseLoginModal').onclick = hideAdminLoginModal;
  el('btnCancelLogin').onclick = hideAdminLoginModal;
  el('inputAdminToken').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
    if (e.key === 'Escape') hideAdminLoginModal();
  });
  el('btnSwitchToken').onclick = () => showAdminLoginModal();
  el('btnRefreshOverview').onclick = loadOverview;

  // Global escape key to close modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      el('modalAddClient').classList.add('hidden');
      el('modalKeyDisplay').classList.add('hidden');
      el('modalAddService')?.classList.add('hidden');
      el('modalProvisionFleet')?.classList.add('hidden');
      el('modalSetupWizard')?.classList.add('hidden');
      if (state.adminToken) hideAdminLoginModal();
    }
  });

  // Clients
  el('btnOpenAddClientModal').onclick = () => {
    el('newClientName').value = '';
    el('newClientDesc').value = '';
    el('newClientRepos').value = '*';
    el('newClientIps').value = '*';
    el('newClientExpires').value = '90d';
    if (el('newClientRateLimit')) el('newClientRateLimit').value = '';
    el('modalAddClient').classList.remove('hidden');
    el('newClientName').focus();
  };
  el('btnCloseAddClientModal').onclick = () => el('modalAddClient').classList.add('hidden');
  el('btnCancelAddClient').onclick = () => el('modalAddClient').classList.add('hidden');

  el('btnSaveNewClient').onclick = async () => {
    const name = el('newClientName').value.trim();
    const description = el('newClientDesc').value.trim();
    const repos = el('newClientRepos').value.split(',').map((s) => s.trim()).filter(Boolean);
    const allowedIps = el('newClientIps').value.split(',').map((s) => s.trim()).filter(Boolean);
    const expChoice = el('newClientExpires').value;

    let expiresAt = null;
    if (expChoice === '30d') expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    else if (expChoice === '90d') expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
    else if (expChoice === '365d') expiresAt = new Date(Date.now() + 365 * 86400000).toISOString();

    const rateLimitVal = el('newClientRateLimit')?.value.trim();
    const rateLimit = rateLimitVal ? parseInt(rateLimitVal, 10) : undefined;

    const permissions = [];
    if (el('permReleases').checked) permissions.push('releases');
    if (el('permRaw').checked) permissions.push('raw');
    if (el('permArchive').checked) permissions.push('archive');
    if (el('permServices')?.checked) permissions.push('services');
    if (el('permBusPub')?.checked) permissions.push('bus:publish');
    if (el('permBusSub')?.checked) permissions.push('bus:subscribe');

    if (!name) return toast('Client name is required', 'warning');
    if (!repos.length) return toast('At least one repository pattern is required', 'warning');

    try {
      const res = await api('/api/admin/clients', {
        method: 'POST',
        body: { name, description, repos, allowedIps, expiresAt, permissions, rateLimit },
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
    flashCopyButton(el('btnCopyKey'));
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

  el('snippetClientSelect').onchange = () => {
    updateSnippet();
  };

  document.querySelectorAll('.channel-filter-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.channel-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectedChannel = btn.dataset.channel;
      renderReleases(state.releases);
    };
  });

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
    flashCopyButton(el('btnCopySnippet'));
    toast('Snippet copied to clipboard!', 'success');
  };

  // Sandbox
  el('sandboxMethod').onchange = (e) => {
    if (e.target.value === 'POST') {
      el('sandboxBodyRow').classList.remove('hidden');
    } else {
      el('sandboxBodyRow').classList.add('hidden');
    }
  };

  el('sandboxPresetSelect').onchange = (e) => {
    const val = e.target.value;
    const repo = state.selectedRepo?.full_name || 'merlinthedev848/MSuite-SIP';
    if (val === 'me') {
      el('sandboxPathInput').value = '/v1/me';
      el('sandboxMethod').value = 'GET';
      el('sandboxBodyRow').classList.add('hidden');
    } else if (val === 'update') {
      el('sandboxPathInput').value = `/v1/repos/${repo}/update?current=1.0.0`;
      el('sandboxMethod').value = 'GET';
      el('sandboxBodyRow').classList.add('hidden');
    } else if (val === 'latest') {
      el('sandboxPathInput').value = `/v1/repos/${repo}/releases/latest`;
      el('sandboxMethod').value = 'GET';
      el('sandboxBodyRow').classList.add('hidden');
    }
  };

  el('sandboxPathInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeSandboxRequest();
  });
  el('btnExecuteSandbox').onclick = executeSandboxRequest;

  // Live logs
  el('btnToggleLogPause').onclick = () => {
    state.isLogPaused = !state.isLogPaused;
    el('btnToggleLogPause').textContent = state.isLogPaused ? '▶️ Resume Stream' : '⏸️ Pause Stream';
    if (!state.isLogPaused) renderLogsTable();
  };
  el('btnClearLogs').onclick = () => {
    state.logs = [];
    state.logCounter = 0;
    el('logCounter').textContent = '0';
    renderLogsTable();
  };
  el('chkAutoScroll').onchange = (e) => {
    state.autoScrollLogs = e.target.checked;
  };
  el('logFilterInput').oninput = () => {
    renderLogsTable();
  };

  // Audit
  el('btnRefreshAudit').onclick = loadAuditLogs;

  // Services Gateway
  el('btnOpenAddServiceModal').onclick = () => {
    el('newServiceId').value = '';
    el('newServiceName').value = '';
    el('newServiceTarget').value = '';
    el('newServiceAuth').value = '';
    el('newServiceAllowedClients').value = '*';
    el('modalAddService').classList.remove('hidden');
    el('newServiceId').focus();
  };
  el('btnCloseAddServiceModal').onclick = () => el('modalAddService').classList.add('hidden');
  el('btnCancelAddService').onclick = () => el('modalAddService').classList.add('hidden');
  el('btnSaveNewService').onclick = async () => {
    const id = el('newServiceId').value.trim();
    const name = el('newServiceName').value.trim();
    const target = el('newServiceTarget').value.trim();
    const authHeader = el('newServiceAuth').value.trim();
    const allowedClients = el('newServiceAllowedClients').value.split(',').map((s) => s.trim()).filter(Boolean);

    if (!id || !target) return toast('Service ID and Target URL are required', 'warning');
    try {
      await api('/api/admin/services', {
        method: 'POST',
        body: { id, name, target, authHeader, allowedClients },
      });
      el('modalAddService').classList.add('hidden');
      toast(`Service "${id}" registered successfully`, 'success');
      loadServices();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  if (el('serviceSearchInput')) el('serviceSearchInput').oninput = () => renderServicesTable(state.services || []);

  // Message Bus
  el('btnPublishBusEvent').onclick = publishBusEvent;
  el('btnRefreshBus').onclick = loadBus;

  // Diagnostics
  el('btnRunDiagnostics').onclick = runDiagnostics;
  el('btnPurgeAllCache').onclick = () => purgeCache();
  el('cachePurgePatternInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const pattern = el('cachePurgePatternInput').value.trim();
      if (pattern) purgeCache(pattern);
    }
  });
  el('btnPurgePattern').onclick = () => {
    const pattern = el('cachePurgePatternInput').value.trim();
    if (pattern) purgeCache(pattern);
  };
  el('btnCopyWebhookUrl').onclick = () => {
    navigator.clipboard.writeText(el('webhookUrlInput').value);
    flashCopyButton(el('btnCopyWebhookUrl'));
    toast('Webhook URL copied!', 'success');
  };

  // Fleet Provisioning Modal & Onboarding
  if (el('btnOpenProvisionFleetModal')) el('btnOpenProvisionFleetModal').onclick = openProvisionFleetModal;
  if (el('btnHeroProvisionFleet')) el('btnHeroProvisionFleet').onclick = openProvisionFleetModal;
  if (el('btnHeroAddClient')) el('btnHeroAddClient').onclick = () => el('btnOpenAddClientModal').click();
  if (el('btnCloseProvisionFleetModal')) el('btnCloseProvisionFleetModal').onclick = closeProvisionFleetModal;
  if (el('btnCloseFleetModalBottom')) el('btnCloseFleetModalBottom').onclick = closeProvisionFleetModal;
  if (el('btnExecuteFleetProvision')) el('btnExecuteFleetProvision').onclick = executeFleetProvision;
  if (el('btnCopyFleetEnv')) {
    el('btnCopyFleetEnv').onclick = () => {
      if (!lastFleetEnv) return;
      navigator.clipboard.writeText(lastFleetEnv);
      flashCopyButton(el('btnCopyFleetEnv'));
      toast('Fleet keys copied (.env format)!', 'success');
    };
  }
  if (el('btnDownloadFleetEnv')) el('btnDownloadFleetEnv').onclick = downloadFleetEnv;

  // Settings
  if (el('btnSaveSettings')) el('btnSaveSettings').onclick = saveSettings;

  // Interactive Setup Wizard
  if (el('btnOpenSetupWizard')) el('btnOpenSetupWizard').onclick = openSetupWizard;
  if (el('btnHeroSetupWizard')) el('btnHeroSetupWizard').onclick = openSetupWizard;
  if (el('btnCloseSetupWizard')) el('btnCloseSetupWizard').onclick = closeSetupWizard;
  if (el('btnWizardSkip')) el('btnWizardSkip').onclick = closeSetupWizard;
  if (el('btnWizardNext')) el('btnWizardNext').onclick = handleWizardNext;
  if (el('btnWizardPrev')) el('btnWizardPrev').onclick = handleWizardPrev;
  if (el('btnWizardFinish')) el('btnWizardFinish').onclick = closeSetupWizard;
  if (el('btnWizardTestGithub')) el('btnWizardTestGithub').onclick = testWizardGithub;
  if (el('btnWizardCopyEnv')) {
    el('btnWizardCopyEnv').onclick = () => {
      if (!lastWizardEnv) return;
      navigator.clipboard.writeText(lastWizardEnv);
      flashCopyButton(el('btnWizardCopyEnv'));
      toast('All fleet keys copied to clipboard!', 'success');
    };
  }
  if (el('btnWizardDownloadEnv')) {
    el('btnWizardDownloadEnv').onclick = () => {
      if (!lastWizardEnv) return;
      const blob = new Blob([lastWizardEnv], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '.env.msuite';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('Downloaded .env.msuite!', 'success');
    };
  }
  if (el('wizEnableTelemetryService')) {
    el('wizEnableTelemetryService').onchange = (e) => {
      if (el('wizTelemetryConfigBox')) el('wizTelemetryConfigBox').classList.toggle('hidden', !e.target.checked);
    };
  }
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

    // Auto-launch Setup Wizard on first portal visit if unconfigured
    if (!localStorage.getItem('msuite_wizard_completed')) {
      setTimeout(() => {
        if (!state.clients || state.clients.length === 0) {
          openSetupWizard();
        }
      }, 500);
    }
  }

  setInterval(() => {
    if (state.activeTab === 'overview' && state.adminToken) {
      loadOverview();
    }
  }, 10000);
});
