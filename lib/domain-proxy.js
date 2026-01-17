const http = require('http');
const https = require('https');
const httpProxy = require('http-proxy');
const serverStore = require('./server-store');
const path = require('path');
const fs = require('fs');

// Create proxy instance
const proxy = httpProxy.createProxyServer({});

proxy.on('error', (err, req, res) => {
    console.error('Proxy error:', err.message);
    if (res.writeHead) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway - Server not responding');
    }
});

function handleRequest(req, res) {
    const host = req.headers.host?.split(':')[0];

    if (!host) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request - No host header');
        return;
    }

    // Find server by domain
    const servers = serverStore.getServers();
    const targetServer = servers.find(s => s.domain === host);

    if (!targetServer || !targetServer.port) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(`
            <html>
                <head><title>Domain Not Found</title></head>
                <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f0f12; color: #fff;">
                    <h1>Domain Not Configured</h1>
                    <p>No server is configured for domain: <strong>${host}</strong></p>
                </body>
            </html>
        `);
        return;
    }

    // Proxy to the target port
    const target = `http://127.0.0.1:${targetServer.port}`;
    console.log(`[Proxy] ${host} -> ${target}`);
    proxy.web(req, res, { target });
}

let httpServer = null;
let httpsServer = null;

function stopProxy() {
    return new Promise((resolve) => {
        if (httpServer) {
            httpServer.close(() => {
                httpServer = null;
                console.log('[Proxy] HTTP server stopped');
                if (httpsServer) {
                    httpsServer.close(() => {
                        httpsServer = null;
                        console.log('[Proxy] HTTPS server stopped');
                        resolve();
                    });
                } else {
                    resolve();
                }
            });
        } else {
            resolve();
        }
    });
}

function startProxy(httpPort = 80, httpsPort = 443) {
    if (httpServer) return httpServer;

    // HTTP Server (also handles ACME challenges)
    httpServer = http.createServer((req, res) => {
        handleRequest(req, res);
    });

    httpServer.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[Proxy] Port ${httpPort} is already in use (nginx/apache?). Proxy disabled.`);
        } else {
            console.log('[Proxy] Error:', err.message);
        }
    });

    try {
        httpServer.listen(httpPort, () => {
            console.log(`[Proxy] HTTP running on port ${httpPort}`);
        });
    } catch (e) {
        console.log('[Proxy] Failed to start:', e.message);
    }

    // Try to start HTTPS if certificates exist
    const certsDir = path.join(__dirname, '../data/certs');
    const certFile = path.join(certsDir, 'fullchain.pem');
    const keyFile = path.join(certsDir, 'privkey.pem');

    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
        try {
            httpsServer = https.createServer({
                cert: fs.readFileSync(certFile),
                key: fs.readFileSync(keyFile)
            }, handleRequest);

            httpsServer.listen(httpsPort, () => {
                console.log(`[Proxy] HTTPS running on port ${httpsPort}`);
            });
        } catch (err) {
            console.log('[Proxy] Could not start HTTPS:', err.message);
        }
    } else {
        console.log('[Proxy] No SSL certificates found, HTTPS disabled');
    }

    return httpServer;
}

module.exports = { startProxy, stopProxy };
