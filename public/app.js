const API = '/api';
let currentServer = null;
let currentFilePath = '';
let editingFile = null;
let autoRefreshInterval = null;

// Init
checkAuth();

// Toast
function toast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fas fa-${type === 'success' ? 'check' : type === 'error' ? 'exclamation' : 'info'}-circle"></i> ${msg}`;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

async function checkAuth() {
    try {
        const res = await fetch(`${API}/check-auth`);
        const data = await res.json();
        if (data.authenticated) showApp();
        else {
            document.getElementById('login-page').style.display = 'flex';
            document.getElementById('app').style.display = 'none';
        }
    } catch (e) {
        document.getElementById('login-page').style.display = 'flex';
    }
}

function showApp() {
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadServers();
}

// Login
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: document.getElementById('login-pass').value })
    });
    if (res.ok) { showApp(); toast('Welcome!', 'success'); }
    else toast('Invalid password', 'error');
});

async function logout() {
    await fetch(`${API}/logout`, { method: 'POST' });
    location.reload();
}

// Navigation
function showPage(page) {
    document.querySelectorAll('.app-nav a').forEach(el => el.classList.remove('active'));
    if (event?.currentTarget) event.currentTarget.classList.add('active');

    ['servers', 'detail', 'settings'].forEach(p => {
        const el = document.getElementById(`page-${p}`);
        if (el) el.classList.toggle('hidden', p !== page);
    });

    if (autoRefreshInterval) { clearInterval(autoRefreshInterval); autoRefreshInterval = null; }
    if (page === 'servers') loadServers();
}

// Servers
async function loadServers() {
    try {
        const res = await fetch(`${API}/servers`);
        const servers = await res.json();

        document.getElementById('server-list').innerHTML = servers.length === 0
            ? '<p style="color:var(--text-muted);">No servers deployed yet. Click Deploy to get started.</p>'
            : servers.map(s => `
                <div class="server-card" onclick="openServer('${s.id}')">
                    <div class="server-card-top">
                        <h3>${s.name}</h3>
                        <span class="status-badge ${s.status === 'online' ? 'status-online' : 'status-stopped'}">
                            ${s.status === 'online' ? 'Running' : 'Stopped'}
                        </span>
                    </div>
                    <div class="server-card-meta">
                        <span><i class="fas fa-code"></i> ${s.runtime}</span>
                        <span><i class="fas fa-network-wired"></i> :${s.port || '?'}</span>
                        ${s.ram ? `<span><i class="fas fa-memory"></i> ${s.ram}MB</span>` : ''}
                    </div>
                </div>
            `).join('');
    } catch (e) {
        console.error('Failed to load servers:', e);
    }
}

let serverData = null;

async function openServer(id) {
    currentServer = id;

    try {
        const res = await fetch(`${API}/servers/${id}`);
        serverData = await res.json();

        document.getElementById('detail-name').textContent = serverData.name;
        document.getElementById('detail-meta').innerHTML = `
            ${serverData.runtime} &middot; Port ${serverData.port || 'N/A'} 
            ${serverData.ram ? `&middot; ${serverData.ram}MB RAM` : ''}
        `;

        // Toggle start/stop/restart buttons based on status
        const isOnline = serverData.status === 'online';
        document.getElementById('btn-start').style.display = isOnline ? 'none' : 'inline-flex';
        document.getElementById('btn-stop').style.display = isOnline ? 'inline-flex' : 'none';
        document.getElementById('btn-restart').style.display = isOnline ? 'inline-flex' : 'none';

        // Fill config form
        document.getElementById('cfg-port').value = serverData.port || '';
        document.getElementById('cfg-ram').value = serverData.ram || '';
        document.getElementById('cfg-domain').value = serverData.domain || '';

        // DNS box - always show instructions
        const dnsBox = document.getElementById('dns-box');
        dnsBox.style.display = 'block';
        try {
            const ipRes = await fetch(`${API}/server-info`);
            const ipData = await ipRes.json();
            document.getElementById('dns-ip').textContent = ipData.ip;
        } catch (e) {
            document.getElementById('dns-ip').textContent = 'Could not get IP';
        }
        // Show domain name if set
        if (serverData.domain) {
            const parts = serverData.domain.split('.');
            document.getElementById('dns-name').textContent = parts.length > 2 ? parts[0] : '@';
        } else {
            document.getElementById('dns-name').textContent = 'your-subdomain';
        }

        showPage('detail');
        showTab('console');
        refreshLogs();
        loadEvents();
        startAutoRefresh();
    } catch (e) {
        toast('Failed to load server', 'error');
    }
}

function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(() => {
        const cb = document.getElementById('cfg-autorefresh');
        if (cb && cb.checked) refreshLogs();
    }, 5000);
}

function showTab(tab) {
    document.querySelectorAll('.tabs .tab').forEach(el => el.classList.remove('active'));
    if (event?.currentTarget) event.currentTarget.classList.add('active');

    ['console', 'files', 'events', 'config'].forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (el) el.classList.toggle('hidden', t !== tab);
    });

    if (tab === 'files') { currentFilePath = ''; loadFiles(); }
    if (tab === 'events') loadEvents();
}

async function refreshLogs() {
    try {
        const res = await fetch(`${API}/servers/${currentServer}/logs`);
        const data = await res.json();
        const box = document.getElementById('console-output');
        box.textContent = data.logs || 'No logs yet. Server may be starting...';
        box.scrollTop = box.scrollHeight;
    } catch (e) {
        document.getElementById('console-output').textContent = 'Failed to fetch logs.';
    }
}

async function loadEvents() {
    try {
        const res = await fetch(`${API}/servers/${currentServer}/events`);
        const events = await res.json();

        const el = document.getElementById('events-list');
        if (!events || events.length === 0) {
            el.innerHTML = '<div class="event-item"><span class="event-time">-</span><span class="event-msg">No events recorded yet.</span></div>';
        } else {
            el.innerHTML = events.map(e => `
                <div class="event-item">
                    <span class="event-time">${new Date(e.time).toLocaleTimeString()}</span>
                    <span class="event-msg">${e.message}</span>
                </div>
            `).join('');
        }
    } catch (e) {
        document.getElementById('events-list').innerHTML = '<div class="event-item"><span class="event-msg">Failed to load events.</span></div>';
    }
}

// Files
async function loadFiles(subPath = '') {
    currentFilePath = subPath;
    editingFile = null;

    try {
        const res = await fetch(`${API}/servers/${currentServer}/files${subPath ? '?path=' + encodeURIComponent(subPath) : ''}`);
        const data = await res.json();

        const parts = subPath.split('/').filter(Boolean);
        document.getElementById('file-breadcrumb').innerHTML =
            `<a href="#" onclick="loadFiles('')" style="color:var(--accent);">root</a>` +
            parts.map((p, i) => ` / <a href="#" onclick="loadFiles('${parts.slice(0, i + 1).join('/')}')" style="color:var(--accent);">${p}</a>`).join('');

        const content = document.getElementById('file-content');

        if (data.type === 'directory') {
            content.innerHTML = `<ul class="file-list">
                ${subPath ? `<li class="file-item" onclick="loadFiles('${parts.slice(0, -1).join('/')}')"><i class="fas fa-level-up-alt"></i><span class="name">..</span></li>` : ''}
                ${data.items.map(item => {
                const itemPath = subPath ? subPath + '/' + item.name : item.name;
                return `
                    <li class="file-item" onclick="loadFiles('${itemPath}')" oncontextmenu="showFileMenu(event, '${itemPath}', '${item.type}')">
                        <i class="fas ${item.type === 'directory' ? 'fa-folder' : 'fa-file'}"></i>
                        <span class="name">${item.name}</span>
                        <span class="size">${item.type === 'file' ? (item.size / 1024).toFixed(1) + 'KB' : ''}</span>
                    </li>`;
            }).join('')}
            </ul>`;
        } else {
            editingFile = subPath;
            content.innerHTML = `
                <div class="file-editor">
                    <div class="file-editor-header">
                        <span>${data.name}</span>
                        <div style="display:flex;gap:0.5rem;">
                            <button class="btn btn-primary btn-sm" onclick="saveFile()"><i class="fas fa-save"></i> Save</button>
                            <button class="btn btn-danger btn-sm" onclick="deleteFile('${subPath}')"><i class="fas fa-trash"></i></button>
                            <button class="btn btn-ghost btn-sm" onclick="loadFiles('${parts.slice(0, -1).join('/')}')"><i class="fas fa-times"></i></button>
                        </div>
                    </div>
                    <textarea id="file-editor-content">${escapeHtml(data.content)}</textarea>
                </div>
            `;
        }
    } catch (e) {
        document.getElementById('file-content').innerHTML = '<p style="color:var(--text-muted);">Failed to load files.</p>';
    }
}

// File context menu
function showFileMenu(event, filePath, fileType) {
    event.preventDefault();
    event.stopPropagation();

    // Remove existing menu
    const existing = document.getElementById('file-context-menu');
    if (existing) existing.remove();

    const menu = document.createElement('div');
    menu.id = 'file-context-menu';
    menu.style.cssText = `
        position: fixed;
        left: ${event.clientX}px;
        top: ${event.clientY}px;
        background: var(--bg-2);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.5rem 0;
        min-width: 150px;
        z-index: 9999;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;

    menu.innerHTML = `
        <div class="ctx-item" onclick="renameFile('${filePath}')"><i class="fas fa-edit"></i> Rename</div>
        <div class="ctx-item" onclick="deleteFile('${filePath}')"><i class="fas fa-trash"></i> Delete</div>
        ${fileType === 'directory' ? `<div class="ctx-item" onclick="createFileIn('${filePath}')"><i class="fas fa-plus"></i> New File</div>` : ''}
    `;

    document.body.appendChild(menu);

    // Close on click outside
    setTimeout(() => {
        document.addEventListener('click', function closeMenu() {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        });
    }, 10);
}

async function renameFile(filePath) {
    const oldName = filePath.split('/').pop();
    const newName = prompt('New name:', oldName);
    if (!newName || newName === oldName) return;

    const parts = filePath.split('/');
    parts.pop();
    const newPath = parts.length ? parts.join('/') + '/' + newName : newName;

    // Read file, delete old, create new
    try {
        const res = await fetch(`${API}/servers/${currentServer}/files?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();

        if (data.type === 'file') {
            await fetch(`${API}/servers/${currentServer}/files`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: newPath, content: data.content })
            });
            await fetch(`${API}/servers/${currentServer}/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
            toast('Renamed!', 'success');
            loadFiles(parts.join('/'));
        }
    } catch (e) { toast('Failed', 'error'); }
}

function createFileIn(folderPath) {
    const name = prompt('File name:');
    if (!name) return;
    const fullPath = folderPath ? folderPath + '/' + name : name;

    fetch(`${API}/servers/${currentServer}/files`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, content: '' })
    }).then(r => r.ok ? (toast('Created', 'success'), loadFiles(folderPath)) : toast('Failed', 'error'));
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function saveFile() {
    if (!editingFile) return;
    const res = await fetch(`${API}/servers/${currentServer}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: editingFile, content: document.getElementById('file-editor-content').value })
    });
    if (res.ok) toast('Saved!', 'success');
    else toast('Failed', 'error');
}

async function deleteFile(filePath) {
    if (!confirm('Delete this file?')) return;
    const res = await fetch(`${API}/servers/${currentServer}/files?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    if (res.ok) {
        toast('Deleted', 'success');
        loadFiles(filePath.split('/').slice(0, -1).join('/'));
    } else toast('Failed', 'error');
}

function createNewFile() {
    const name = prompt('File name:');
    if (!name) return;
    fetch(`${API}/servers/${currentServer}/files`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentFilePath ? currentFilePath + '/' + name : name, content: '' })
    }).then(r => r.ok ? (toast('Created', 'success'), loadFiles(currentFilePath)) : toast('Failed', 'error'));
}

// Server Actions
async function serverAction(action) {
    if (action === 'delete' && !confirm('Delete this server permanently?')) return;

    // For update, show the pull modal instead
    if (action === 'update') {
        openPullModal();
        return;
    }

    const msgs = {
        restart: 'Restarting...',
        stop: 'Stopping...',
        start: 'Starting...',
        delete: 'Deleting...'
    };
    toast(msgs[action] || 'Processing...', 'info');

    const method = action === 'delete' ? 'DELETE' : 'POST';
    const url = action === 'delete' ? `${API}/servers/${currentServer}` : `${API}/servers/${currentServer}/${action}`;

    try {
        const res = await fetch(url, { method });
        if (res.ok) {
            toast('Done!', 'success');
            if (action === 'delete') showPage('servers');
            else {
                setTimeout(() => openServer(currentServer), 1500);
                loadEvents();
            }
        } else {
            const err = await res.json();
            toast(err.error || 'Failed', 'error');
        }
    } catch (e) { toast('Error', 'error'); }
}

// Pull Modal
async function openPullModal() {
    document.getElementById('pull-modal').classList.remove('hidden');
    document.getElementById('pull-loading').style.display = 'block';
    document.getElementById('pull-info').style.display = 'none';

    try {
        const res = await fetch(`${API}/servers/${currentServer}/check-updates`);
        const data = await res.json();

        document.getElementById('pull-loading').style.display = 'none';
        document.getElementById('pull-info').style.display = 'block';

        if (data.hasUpdates) {
            document.getElementById('pull-status').innerHTML = `
                <div style="color:var(--success);font-weight:600;margin-bottom:0.5rem;">
                    <i class="fas fa-arrow-down"></i> ${data.behind || data.commits.length} new commits available
                </div>
                <div style="font-size:0.85rem;color:var(--text-muted);">Branch: ${data.branch}</div>
            `;

            if (data.commits.length > 0) {
                document.getElementById('pull-commits').innerHTML = data.commits.map(c => `
                    <div style="padding:0.5rem;border-bottom:1px solid var(--border);font-size:0.85rem;">
                        <code style="color:var(--accent);margin-right:0.5rem;">${c.hash}</code>
                        ${c.message}
                        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem;">${c.author || ''}</div>
                    </div>
                `).join('');
            } else {
                document.getElementById('pull-commits').innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">Commits available but details could not be loaded.</p>';
            }

            document.getElementById('pull-confirm-btn').disabled = false;
        } else {
            document.getElementById('pull-status').innerHTML = `
                <div style="color:var(--text-muted);">
                    <i class="fas fa-check-circle" style="color:var(--success);"></i> Already up to date
                </div>
            `;
            document.getElementById('pull-commits').innerHTML = '';
            document.getElementById('pull-confirm-btn').disabled = true;
        }
    } catch (e) {
        document.getElementById('pull-loading').style.display = 'none';
        document.getElementById('pull-info').style.display = 'block';
        document.getElementById('pull-status').innerHTML = `<div style="color:var(--danger);">Failed to check for updates: ${e.message}</div>`;
        document.getElementById('pull-commits').innerHTML = '';
    }
}

function closePullModal() {
    document.getElementById('pull-modal').classList.add('hidden');
}

async function confirmPull() {
    closePullModal();
    toast('Pulling changes...', 'info');

    try {
        const res = await fetch(`${API}/servers/${currentServer}/update`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            toast('Update complete!', 'success');
            loadFiles(currentFilePath);
            loadEvents();
            setTimeout(() => openServer(currentServer), 1500);
        } else {
            const err = await res.json();
            toast(err.error || 'Failed', 'error');
        }
    } catch (e) { toast('Error', 'error'); }
}

// Generate SSL
async function generateSSL() {
    const domain = document.getElementById('cfg-domain').value;
    if (!domain) return toast('Set a domain first', 'error');

    const status = document.getElementById('ssl-status');
    status.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';

    try {
        const res = await fetch(`${API}/generate-ssl`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain })
        });
        const data = await res.json();

        if (data.success) {
            status.innerHTML = '<span style="color:var(--success)"><i class="fas fa-check"></i> SSL Active</span>';
            toast('SSL certificate generated!', 'success');
        } else {
            status.innerHTML = '<span style="color:var(--danger)"><i class="fas fa-times"></i> Failed</span>';
            toast(data.error, 'error');
        }
    } catch (e) {
        status.innerHTML = '<span style="color:var(--danger)">Error</span>';
        toast('Failed to generate SSL', 'error');
    }
}

// Config Form
document.getElementById('server-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch(`${API}/servers/${currentServer}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            port: parseInt(document.getElementById('cfg-port').value) || null,
            ram: parseInt(document.getElementById('cfg-ram').value) || null,
            domain: document.getElementById('cfg-domain').value || null
        })
    });
    if (res.ok) { toast('Configuration saved', 'success'); openServer(currentServer); }
    else toast('Failed', 'error');
});

async function verifyDomain() {
    const domain = document.getElementById('cfg-domain').value;
    if (!domain) return toast('Enter a domain first', 'error');

    const status = document.getElementById('domain-status');
    status.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    try {
        const res = await fetch(`${API}/verify-domain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain })
        });
        const data = await res.json();

        status.innerHTML = data.verified
            ? '<span style="color:var(--success)"><i class="fas fa-check"></i> Verified</span>'
            : '<span style="color:var(--danger)"><i class="fas fa-times"></i> Not connected</span>';

        if (data.verified) toast('Domain verified!', 'success');
        else toast(data.message || data.error, 'error');
    } catch (e) { status.innerHTML = '<span style="color:var(--danger)">Error</span>'; }
}

// GitHub Repos
async function loadGitHubRepos() {
    const select = document.getElementById('create-repo-select');
    select.classList.remove('hidden');
    select.innerHTML = '<option>Loading...</option>';

    try {
        const res = await fetch(`${API}/github/repos`);
        const repos = await res.json();
        select.innerHTML = repos.length === 0
            ? '<option value="">No repos found</option>'
            : '<option value="">Choose repo...</option>' + repos.map(r => `<option value="${r.url}">${r.name}${r.private ? ' (private)' : ''}</option>`).join('');
    } catch (e) { select.innerHTML = '<option value="">Error</option>'; }
}

function selectRepo(url) {
    if (url) { document.getElementById('create-repo').value = url; toast('Selected', 'success'); }
}

// Create Modal
function openCreateModal() { document.getElementById('create-modal').classList.remove('hidden'); }
function closeCreateModal() { document.getElementById('create-modal').classList.add('hidden'); }

document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deploying...';

    try {
        const res = await fetch(`${API}/servers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: document.getElementById('create-name').value,
                repoUrl: document.getElementById('create-repo').value,
                runtime: document.getElementById('create-runtime').value,
                entryPoint: document.getElementById('create-entry').value,
                ram: parseInt(document.getElementById('create-ram').value) || 512
            })
        });

        if (res.ok) {
            closeCreateModal();
            loadServers();
            e.target.reset();
            toast('Deployed!', 'success');
        } else {
            const err = await res.json();
            toast(err.error, 'error');
        }
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-rocket"></i> Deploy';
    }
});

// Settings
document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await fetch(`${API}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ githubToken: document.getElementById('settings-token').value })
    });
    toast('Token saved', 'success');
});
