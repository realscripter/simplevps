const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/servers.json');
const EVENTS_FILE = path.join(__dirname, '../data/events.json');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(DATA_FILE))) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
}

// Ensure data files exist
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}
if (!fs.existsSync(EVENTS_FILE)) {
    fs.writeFileSync(EVENTS_FILE, JSON.stringify({}));
}

function getServers() {
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (err) {
        return [];
    }
}

function saveServers(servers) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(servers, null, 2));
}

function addServer(server) {
    const servers = getServers();
    servers.push(server);
    saveServers(servers);
    addEvent(server.id, 'Server created');
}

function updateServer(id, updates) {
    const servers = getServers();
    const index = servers.findIndex(s => s.id === id);
    if (index !== -1) {
        servers[index] = { ...servers[index], ...updates };
        saveServers(servers);
        addEvent(id, 'Configuration updated');
        return servers[index];
    }
    return null;
}

function removeServer(id) {
    const servers = getServers().filter(s => s.id !== id);
    saveServers(servers);
}

function getServer(id) {
    return getServers().find(s => s.id === id);
}

function getNextPort() {
    const used = getServers().map(s => s.port).filter(Boolean);
    let port = 3000;
    while (used.includes(port)) port++;
    return port;
}

// Events
function getEvents(serverId) {
    try {
        const all = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
        return (all[serverId] || []).slice(-50); // Last 50 events
    } catch (err) {
        return [];
    }
}

function addEvent(serverId, message) {
    try {
        const all = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
        if (!all[serverId]) all[serverId] = [];
        all[serverId].push({ time: new Date().toISOString(), message });
        // Keep only last 100 events per server
        if (all[serverId].length > 100) all[serverId] = all[serverId].slice(-100);
        fs.writeFileSync(EVENTS_FILE, JSON.stringify(all, null, 2));
    } catch (err) {
        console.error('Failed to add event:', err);
    }
}

module.exports = {
    getServers,
    addServer,
    updateServer,
    removeServer,
    getServer,
    getNextPort,
    getEvents,
    addEvent
};
