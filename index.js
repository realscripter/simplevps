const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const configManager = require('./lib/config-manager');
const simpleGit = require('simple-git'); // Need this here or in git-manager for listing remote? 
// Actually, listing remote repos usually requires GitHub API (Octokit) or using `git ls-remote` but that implies we know the url.
// To list "all repos for a user", we need to fetch from GitHub API.
// Since we don't want to add big dependencies if possible, I'll use native fetch or simple https request. Node 18+ has fetch.
// The user has Node 22.14.0 (seen in logs). So global fetch is available.

const serverStore = require('./lib/server-store');
const gitManager = require('./lib/git-manager');
const pm2Manager = require('./lib/pm2-manager');
const domainProxy = require('./lib/domain-proxy');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 8000;

// Initialize Config
const config = configManager.getConfig();
const OTP = config.adminPassword;

console.log('\n==================================================');
console.log('   VPS DASHBOARD STARTED');
console.log(`   ADMIN PASSWORD: ${OTP}`);
console.log('==================================================\n');

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Auth Middleware
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Routes
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    // Reload config to ensure we check against latest if changed manually (though not expected)
    const currentConfig = configManager.getConfig();
    if (password === currentConfig.adminPassword) {
        req.session.authenticated = true;
        res.json({ success: true, token: currentConfig.githubToken });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.get('/api/check-auth', (req, res) => {
    res.json({ authenticated: !!req.session.authenticated });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Config Routes
app.get('/api/config', requireAuth, (req, res) => {
    const conf = configManager.getConfig();
    // Don't send password back to UI if not needed, but token helps
    res.json({ githubToken: conf.githubToken });
});

app.post('/api/config', requireAuth, (req, res) => {
    const { githubToken } = req.body;
    configManager.updateConfig({ githubToken });
    res.json({ success: true });
});

// Get server info including public IP
app.get('/api/server-info', requireAuth, async (req, res) => {
    try {
        // Fetch public IP from external service
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        res.json({ ip: data.ip });
    } catch (err) {
        // Fallback - try to get local IP
        const os = require('os');
        const interfaces = os.networkInterfaces();
        let ip = 'YOUR_VPS_IP';
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ip = iface.address;
                    break;
                }
            }
        }
        res.json({ ip });
    }
});

// Verify domain DNS
app.post('/api/verify-domain', requireAuth, async (req, res) => {
    const { domain } = req.body;
    const dns = require('dns').promises;

    if (!domain) {
        return res.status(400).json({ error: 'Domain required' });
    }

    try {
        // Get our public IP
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        const ourIp = ipData.ip;

        // Resolve domain
        const addresses = await dns.resolve4(domain);

        const verified = addresses.includes(ourIp);

        res.json({
            verified,
            ourIp,
            domainIps: addresses,
            message: verified
                ? 'Domain is correctly pointing to this server!'
                : `Domain points to ${addresses.join(', ')} but this server is ${ourIp}`
        });
    } catch (err) {
        res.json({
            verified: false,
            error: err.code === 'ENOTFOUND' ? 'Domain not found or DNS not propagated yet' : err.message
        });
    }
});

// GitHub Proxy
app.get('/api/github/repos', requireAuth, async (req, res) => {
    const conf = configManager.getConfig();
    const token = conf.githubToken;

    if (!token) {
        return res.json([]);
    }

    try {
        // Fetch user repos
        const response = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });

        if (!response.ok) {
            throw new Error(`GitHub API Error: ${response.statusText}`);
        }

        const data = await response.json();
        const simplified = data.map(repo => ({
            name: repo.name,
            full_name: repo.full_name,
            url: repo.clone_url,
            private: repo.private,
            description: repo.description
        }));

        res.json(simplified);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch repositories' });
    }
});

// Protected Routes
app.get('/api/servers', requireAuth, async (req, res) => {
    const servers = serverStore.getServers();

    // Enrich with PM2 status
    try {
        const processes = await pm2Manager.listProcesses();
        const enrichedServers = servers.map(srv => {
            const proc = processes.find(p => p.name === srv.id);
            return {
                ...srv,
                status: proc ? proc.pm2_env.status : 'stopped',
                uptime: proc ? proc.pm2_env.pm_uptime : 0
            };
        });
        res.json(enrichedServers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch process status' });
    }
});

// Helper for safe directory deletion
async function safeDelete(dirPath) {
    if (!fs.existsSync(dirPath)) return;

    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            return;
        } catch (err) {
            if (err.code === 'EBUSY' || err.code === 'EPERM') {
                console.log(`Directory locked, retrying deletion... (${i + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                console.error(`Failed to delete directory: ${err.message}`);
                break;
            }
        }
    }
}

app.post('/api/servers', requireAuth, async (req, res) => {
    const { repoUrl, runtime, name, entryPoint } = req.body;

    if (!repoUrl || !runtime || !name) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const conf = configManager.getConfig();

    try {
        // 1. Clone Repo
        console.log(`Cloning ${repoUrl} to ${id}...`);
        const targetDir = path.join(__dirname, 'repos', id);
        if (fs.existsSync(targetDir)) {
            await safeDelete(targetDir);
        }

        const repoPath = await gitManager.cloneRepo(repoUrl, id, conf.githubToken);

        // 2. Auto-install dependencies
        if (runtime === 'node' && fs.existsSync(path.join(repoPath, 'package.json'))) {
            console.log(`Installing npm dependencies for ${id}...`);
            await pm2Manager.runCommand('npm install', repoPath);
        }

        if (runtime === 'python' && fs.existsSync(path.join(repoPath, 'requirements.txt'))) {
            console.log(`Installing pip dependencies for ${id}...`);
            await pm2Manager.runCommand('pip install -r requirements.txt', repoPath);
        }

        // 3. Determine launch config
        let pm2Config = {
            cwd: repoPath,
            interpreter: runtime === 'python' ? 'python' : undefined,
            isNpm: false
        };

        if (entryPoint && entryPoint.trim().startsWith('npm')) {
            // NPM script mode
            if (!fs.existsSync(path.join(repoPath, 'package.json'))) {
                await safeDelete(repoPath);
                return res.status(400).json({ error: 'package.json not found' });
            }

            const parts = entryPoint.trim().split(' ');
            parts.shift(); // remove 'npm'
            pm2Config.isNpm = true;
            pm2Config.args = parts;
        } else {
            // File mode
            let scriptFile = entryPoint;
            if (!scriptFile) {
                // Auto-detect entry point
                if (runtime === 'node') {
                    if (fs.existsSync(path.join(repoPath, 'index.js'))) scriptFile = 'index.js';
                    else if (fs.existsSync(path.join(repoPath, 'server.js'))) scriptFile = 'server.js';
                    else if (fs.existsSync(path.join(repoPath, 'app.js'))) scriptFile = 'app.js';
                    else if (fs.existsSync(path.join(repoPath, 'src/index.js'))) scriptFile = 'src/index.js';
                    else scriptFile = 'index.js';
                } else {
                    if (fs.existsSync(path.join(repoPath, 'main.py'))) scriptFile = 'main.py';
                    else if (fs.existsSync(path.join(repoPath, 'app.py'))) scriptFile = 'app.py';
                    else if (fs.existsSync(path.join(repoPath, 'bot.py'))) scriptFile = 'bot.py';
                    else scriptFile = 'main.py';
                }
            }

            pm2Config.script = path.join(repoPath, scriptFile);

            if (!fs.existsSync(pm2Config.script)) {
                await safeDelete(repoPath);
                return res.status(400).json({ error: `Entry point not found: ${scriptFile}` });
            }
        }

        // 4. Start with PM2
        console.log(`Starting ${id}...`);
        await pm2Manager.startProcess(id, pm2Config);

        // 5. Assign port and save to store
        const port = serverStore.getNextPort();
        serverStore.addServer({
            id,
            name,
            repoUrl,
            runtime,
            entryPoint: entryPoint || 'auto-detected',
            port: port,
            ram: req.body.ram || 512,
            domain: ''
        });

        res.json({ success: true, port });

    } catch (err) {
        console.error(err);
        const targetDir = path.join(__dirname, 'repos', id);
        safeDelete(targetDir);
        res.status(500).json({ error: err.message });
    }
});

// Update server settings (port, domain, ram)
app.patch('/api/servers/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { port, domain, ram } = req.body;

    const updated = serverStore.updateServer(id, { port, domain, ram });
    if (updated) {
        res.json({ success: true, server: updated });
    } else {
        res.status(404).json({ error: 'Server not found' });
    }
});

app.post('/api/servers/:id/restart', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await pm2Manager.restartProcess(id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/servers/:id/stop', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await pm2Manager.stopProcess(id);
        serverStore.addEvent(id, 'Server stopped');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/servers/:id/start', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await pm2Manager.restartProcess(id);
        serverStore.addEvent(id, 'Server started');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check for updates (git fetch)
app.get('/api/servers/:id/check-updates', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const updates = await gitManager.fetchUpdates(id);
        res.json(updates);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/servers/:id/update', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        serverStore.addEvent(id, 'Pulling latest changes...');
        const result = await gitManager.pullRepo(id);
        await pm2Manager.restartProcess(id);
        serverStore.addEvent(id, `Update complete: ${result.summary?.changes || 0} changes, ${result.summary?.insertions || 0} insertions, ${result.summary?.deletions || 0} deletions`);
        res.json({ success: true, result });
    } catch (err) {
        serverStore.addEvent(id, `Update failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Generate SSL Certificate using Let's Encrypt
app.post('/api/generate-ssl', requireAuth, async (req, res) => {
    const { domain, email } = req.body;

    if (!domain) {
        return res.status(400).json({ error: 'Domain required' });
    }

    try {
        const acme = require('acme-client');
        const forge = require('node-forge');

        // Generate account key
        const accountKey = await acme.forge.createPrivateKey();

        // Create ACME client (Let's Encrypt)
        const client = new acme.Client({
            directoryUrl: acme.directory.letsencrypt.production,
            accountKey: accountKey
        });

        // Create account
        await client.createAccount({
            termsOfServiceAgreed: true,
            contact: [`mailto:${email || 'admin@' + domain}`]
        });

        // Create order for domain
        const order = await client.createOrder({
            identifiers: [{ type: 'dns', value: domain }]
        });

        // Get authorizations
        const authorizations = await client.getAuthorizations(order);

        for (const auth of authorizations) {
            const challenge = auth.challenges.find(c => c.type === 'http-01');
            if (!challenge) continue;

            const keyAuth = await client.getChallengeKeyAuthorization(challenge);

            // Save challenge file
            const challengeDir = path.join(__dirname, 'data/acme-challenge');
            if (!fs.existsSync(challengeDir)) {
                fs.mkdirSync(challengeDir, { recursive: true });
            }
            fs.writeFileSync(path.join(challengeDir, challenge.token), keyAuth);

            // Verify challenge
            await client.verifyChallenge(auth, challenge);
            await client.completeChallenge(challenge);
            await client.waitForValidStatus(challenge);
        }

        // Finalize order and get certificate
        const [key, csr] = await acme.forge.createCsr({
            commonName: domain
        });

        await client.finalizeOrder(order, csr);
        const cert = await client.getCertificate(order);

        // Save certificates
        const certsDir = path.join(__dirname, 'data/certs');
        if (!fs.existsSync(certsDir)) {
            fs.mkdirSync(certsDir, { recursive: true });
        }
        fs.writeFileSync(path.join(certsDir, 'privkey.pem'), key);
        fs.writeFileSync(path.join(certsDir, 'fullchain.pem'), cert);

        // Mark domain as having SSL
        const server = serverStore.getServers().find(s => s.domain === domain);
        if (server) {
            serverStore.updateServer(server.id, { ssl: true });
        }

        res.json({
            success: true,
            message: 'SSL certificate generated! Restart the server to enable HTTPS.'
        });
    } catch (err) {
        console.error('[SSL] Error:', err);
        res.json({
            success: false,
            error: err.message || 'Failed to generate certificate. Make sure the domain points to this server and port 80 is accessible.'
        });
    }
});

app.delete('/api/servers/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        await pm2Manager.deleteProcess(id);
        serverStore.removeServer(id);

        // Remove folder from disk
        const targetDir = path.join(__dirname, 'repos', id);
        console.log(`Removing directory: ${targetDir}`);
        await safeDelete(targetDir);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get single server details
app.get('/api/servers/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const server = serverStore.getServer(id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    try {
        const processes = await pm2Manager.listProcesses();
        const proc = processes.find(p => p.name === id);
        res.json({
            ...server,
            status: proc ? proc.pm2_env.status : 'stopped',
            uptime: proc ? proc.pm2_env.pm_uptime : 0,
            memory: proc ? proc.monit.memory : 0,
            cpu: proc ? proc.monit.cpu : 0
        });
    } catch (err) {
        res.json({ ...server, status: 'unknown' });
    }
});

// Get server events
app.get('/api/servers/:id/events', requireAuth, (req, res) => {
    const { id } = req.params;
    const events = serverStore.getEvents(id);
    res.json(events);
});

// Get PM2 logs
app.get('/api/servers/:id/logs', requireAuth, async (req, res) => {
    const { id } = req.params;
    const server = serverStore.getServer(id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    try {
        const homeDir = process.env.USERPROFILE || process.env.HOME;
        const outLogPath = path.join(homeDir, '.pm2', 'logs', `${id}-out.log`);
        const errLogPath = path.join(homeDir, '.pm2', 'logs', `${id}-error.log`);

        let allLogs = [];

        // Read output logs
        if (fs.existsSync(outLogPath)) {
            const content = fs.readFileSync(outLogPath, 'utf8');
            allLogs.push(...content.split('\n').filter(line => line.trim()));
        }

        // Read error logs (but don't add separator - just merge)
        if (fs.existsSync(errLogPath)) {
            const content = fs.readFileSync(errLogPath, 'utf8');
            allLogs.push(...content.split('\n').filter(line => line.trim()));
        }

        // Get last 1000 lines
        const logs = allLogs.slice(-1000).join('\n');

        res.json({ logs: logs || 'No logs available yet.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

// List files in repo
app.get('/api/servers/:id/files', requireAuth, (req, res) => {
    const { id } = req.params;
    const subPath = req.query.path || '';

    const server = serverStore.getServer(id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const repoPath = path.join(__dirname, 'repos', id);
    const targetPath = path.join(repoPath, subPath);

    // Security: ensure path is within repo
    if (!targetPath.startsWith(repoPath)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'Path not found' });
    }

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
        const items = fs.readdirSync(targetPath).map(name => {
            const itemPath = path.join(targetPath, name);
            const itemStat = fs.statSync(itemPath);
            return {
                name,
                type: itemStat.isDirectory() ? 'directory' : 'file',
                size: itemStat.size
            };
        });
        res.json({ type: 'directory', items });
    } else {
        // Return file content
        const content = fs.readFileSync(targetPath, 'utf8');
        res.json({ type: 'file', content, name: path.basename(targetPath) });
    }
});
// Save file
app.post('/api/servers/:id/files', requireAuth, (req, res) => {
    const { id } = req.params;
    const { path: filePath, content } = req.body;

    const server = serverStore.getServer(id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const repoPath = path.join(__dirname, 'repos', id);
    const targetPath = path.join(repoPath, filePath);

    if (!targetPath.startsWith(repoPath)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        fs.writeFileSync(targetPath, content, 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save file' });
    }
});

// Delete file
app.delete('/api/servers/:id/files', requireAuth, (req, res) => {
    const { id } = req.params;
    const filePath = req.query.path;

    const server = serverStore.getServer(id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const repoPath = path.join(__dirname, 'repos', id);
    const targetPath = path.join(repoPath, filePath);

    if (!targetPath.startsWith(repoPath)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    try {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete' });
    }
});

// Create new file
app.put('/api/servers/:id/files', requireAuth, (req, res) => {
    const { id } = req.params;
    const { path: filePath, content } = req.body;

    const server = serverStore.getServer(id);
    if (!server) {
        return res.status(404).json({ error: 'Server not found' });
    }

    const repoPath = path.join(__dirname, 'repos', id);
    const targetPath = path.join(repoPath, filePath);

    if (!targetPath.startsWith(repoPath)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content || '', 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create file' });
    }
});

// Bind to 0.0.0.0 so it's accessible externally
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT} or http://YOUR_IP:${PORT}`);

    // Start domain proxy on port 80 (requires admin/root on Windows/Linux)
    try {
        domainProxy.startProxy(80);
    } catch (err) {
        console.log('[Proxy] Could not start on port 80 (needs admin). Domain routing disabled.');
    }
});
