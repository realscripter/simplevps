const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs');

const REPO_DIR = path.join(__dirname, '../repos');

// Ensure repo directory exists
if (!fs.existsSync(REPO_DIR)) {
    fs.mkdirSync(REPO_DIR, { recursive: true });
}

async function cloneRepo(url, name, token) {
    const targetDir = path.join(REPO_DIR, name);
    if (fs.existsSync(targetDir)) {
        throw new Error('Directory already exists');
    }

    try {
        let cloneUrl = url;
        if (token) {
            // Handle https://github.com/... -> https://token@github.com/...
            if (url.startsWith('https://')) {
                cloneUrl = url.replace('https://', `https://${token}@`);
            } else {
                // Determine if it is just a "user/repo" string or something else?
                // For now assume full HTTPS URL is passed.
                // If the user pasted a non-https url, this simple replace might fail or look weird, 
                // but let's assume standard github https urls.
            }
        }
        await simpleGit().clone(cloneUrl, targetDir);
        return targetDir;
    } catch (err) {
        console.error('Git Clone Error:', err);
        throw err;
    }
}

async function pullRepo(name) {
    const targetDir = path.join(REPO_DIR, name);
    if (!fs.existsSync(targetDir)) {
        throw new Error('Repository does not exist on disk');
    }

    try {
        const git = simpleGit(targetDir);
        const result = await git.pull();
        return result;
    } catch (err) {
        console.error('Git Pull Error:', err);
        throw err;
    }
}

async function fetchUpdates(name) {
    const targetDir = path.join(REPO_DIR, name);
    if (!fs.existsSync(targetDir)) {
        throw new Error('Repository does not exist on disk');
    }

    try {
        const git = simpleGit(targetDir);

        // Fetch from remote
        await git.fetch();

        // Get current branch
        const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
        const currentBranch = branch.trim();

        // Get commit log between local and origin
        const log = await git.log({
            from: `HEAD`,
            to: `origin/${currentBranch}`,
            '--oneline': null
        });

        // Get current and remote commit hashes
        const localHash = await git.revparse(['HEAD']);
        const remoteHash = await git.revparse([`origin/${currentBranch}`]);

        const hasUpdates = localHash.trim() !== remoteHash.trim();

        return {
            hasUpdates,
            branch: currentBranch,
            commits: log.all.map(c => ({
                hash: c.hash.substring(0, 7),
                message: c.message,
                date: c.date,
                author: c.author_name
            })),
            behind: log.total
        };
    } catch (err) {
        console.error('Git Fetch Error:', err);
        throw err;
    }
}

module.exports = {
    cloneRepo,
    pullRepo,
    fetchUpdates,
    REPO_DIR
};
