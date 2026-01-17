const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '../data/config.json');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(CONFIG_FILE))) {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
}

function getConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) {
            // Initialize with default values
            const initialConfig = {
                adminPassword: crypto.randomBytes(4).toString('hex'),
                githubToken: ''
            };
            saveConfig(initialConfig);
            return initialConfig;
        }
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
        console.error('Error reading config:', err);
        return {};
    }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('Error writing config:', err);
    }
}

function updateConfig(updates) {
    const current = getConfig();
    const newConfig = { ...current, ...updates };
    saveConfig(newConfig);
    return newConfig;
}

module.exports = {
    getConfig,
    saveConfig,
    updateConfig
};
