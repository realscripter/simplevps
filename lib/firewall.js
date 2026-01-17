const { exec } = require('child_process');

// Check if running on Linux
const isLinux = process.platform === 'linux';

// Run UFW command
function runUfw(args) {
    return new Promise((resolve) => {
        if (!isLinux) return resolve({ success: false, message: 'Not Linux' });

        exec(`sudo ufw ${args}`, (error, stdout, stderr) => {
            if (error) {
                console.log(`[UFW] Error: ${stderr || error.message}`);
                resolve({ success: false, message: stderr || error.message });
            } else {
                console.log(`[UFW] ${stdout.trim()}`);
                resolve({ success: true, message: stdout.trim() });
            }
        });
    });
}

// Open a port
async function openPort(port) {
    console.log(`[UFW] Opening port ${port}...`);
    return await runUfw(`allow ${port}/tcp`);
}

// Close a port
async function closePort(port) {
    console.log(`[UFW] Closing port ${port}...`);
    return await runUfw(`delete allow ${port}/tcp`);
}

// Open port 80 and 443 for SSL
async function openSSLPorts() {
    await openPort(80);
    await openPort(443);
}

// Check UFW status
async function status() {
    return await runUfw('status');
}

module.exports = {
    openPort,
    closePort,
    openSSLPorts,
    status,
    isLinux
};
