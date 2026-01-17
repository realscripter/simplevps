const Greenlock = require('greenlock');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(__dirname, '../data/greenlock');
const CERTS_DIR = path.join(__dirname, '../data/certs');

// Ensure directories exist
[CONFIG_DIR, CERTS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

let greenlock = null;

function init(email) {
    if (greenlock) return greenlock;

    greenlock = Greenlock.create({
        packageRoot: path.join(__dirname, '..'),
        configDir: CONFIG_DIR,
        maintainerEmail: email || 'admin@example.com',
        staging: false, // Set to true for testing
        notify: function (event, details) {
            console.log('[SSL]', event, details);
        }
    });

    return greenlock;
}

async function addDomain(domain, email) {
    const gl = init(email);

    try {
        // Add the site/domain
        await gl.sites.add({
            subject: domain,
            altnames: [domain]
        });

        console.log(`[SSL] Added domain: ${domain}`);
        return { success: true, message: `SSL certificate requested for ${domain}` };
    } catch (err) {
        console.error('[SSL] Error adding domain:', err);
        throw err;
    }
}

async function getCertificate(domain) {
    const gl = init();

    try {
        const site = await gl.sites.get({ subject: domain });
        if (site) {
            return {
                success: true,
                hasCert: true,
                domain: site.subject,
                renewAt: site.renewAt
            };
        }
        return { success: true, hasCert: false };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function removeDomain(domain) {
    const gl = init();

    try {
        await gl.sites.remove({ subject: domain });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// Get middleware for ACME challenge
function getMiddleware() {
    const gl = init();
    return gl.middleware();
}

// Get HTTPS options for creating server
function getHttpsOptions() {
    const gl = init();
    return gl.tlsOptions;
}

module.exports = {
    init,
    addDomain,
    getCertificate,
    removeDomain,
    getMiddleware,
    getHttpsOptions
};
