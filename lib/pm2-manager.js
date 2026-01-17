const pm2 = require('pm2');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let connected = false;

function connect() {
    return new Promise((resolve, reject) => {
        if (connected) return resolve();
        pm2.connect((err) => {
            if (err) return reject(err);
            connected = true;
            resolve();
        });
    });
}

// Run a shell command and return output
function runCommand(command, cwd) {
    return new Promise((resolve, reject) => {
        console.log(`Running: ${command} in ${cwd}`);
        exec(command, { cwd, shell: true, timeout: 120000 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`Command error: ${stderr}`);
                return reject(error);
            }
            console.log(stdout);
            resolve(stdout);
        });
    });
}

// Kill process using a port
function killPort(port) {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        const cmd = isWin
            ? `netstat -ano | findstr :${port} | findstr LISTENING`
            : `lsof -ti:${port}`;

        exec(cmd, (error, stdout) => {
            if (error || !stdout.trim()) {
                console.log(`[Port] Port ${port} is free`);
                return resolve();
            }

            const pid = isWin
                ? stdout.trim().split(/\s+/).pop()
                : stdout.trim().split('\n')[0];

            if (pid && pid !== '0') {
                const killCmd = isWin ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`;
                exec(killCmd, (err) => {
                    if (!err) console.log(`[Port] Killed process ${pid} on port ${port}`);
                    resolve();
                });
            } else {
                resolve();
            }
        });
    });
}

async function startProcess(name, config) {
    await connect();

    const { script, cwd, interpreter, isNpm, args } = config;

    return new Promise((resolve, reject) => {
        let resolved = false;
        let options;

        if (isNpm && args && args.length > 0) {
            const scriptName = args[0] === 'run' ? args[1] : args[0];
            const pkgPath = path.join(cwd, 'package.json');

            if (fs.existsSync(pkgPath)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    const actualCommand = pkg.scripts?.[scriptName];

                    if (actualCommand) {
                        const parts = actualCommand.split(' ');
                        const cmd = parts[0].toLowerCase();

                        if (cmd === 'node' || cmd === 'nodemon') {
                            options = {
                                name,
                                script: parts.slice(1).join(' '),
                                cwd,
                                autorestart: true,
                                max_restarts: 10
                            };
                        } else if (cmd === 'python' || cmd === 'python3') {
                            options = {
                                name,
                                script: parts.slice(1).join(' '),
                                cwd,
                                interpreter: 'python',
                                autorestart: true
                            };
                        } else {
                            options = {
                                name,
                                script: actualCommand,
                                cwd,
                                interpreter: 'bash',
                                autorestart: true
                            };
                        }
                    }
                } catch (e) {
                    console.error('Failed to parse package.json:', e);
                }
            }

            if (!options) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
                    options = {
                        name,
                        script: pkg.main || 'index.js',
                        cwd,
                        autorestart: true
                    };
                } catch (e) {
                    options = { name, script: 'index.js', cwd, autorestart: true };
                }
            }
        } else {
            options = {
                name,
                script,
                cwd,
                autorestart: true,
                max_restarts: 10
            };

            if (interpreter === 'python') {
                options.interpreter = 'python';
            }
        }

        console.log('PM2 Start Options:', JSON.stringify(options, null, 2));

        pm2.start(options, (err, apps) => {
            if (resolved) return;
            resolved = true;
            if (err) return reject(err);
            resolve(apps);
        });
    });
}

async function stopProcess(name) {
    await connect();
    return new Promise((resolve, reject) => {
        let resolved = false;
        pm2.stop(name, (err) => {
            if (resolved) return;
            resolved = true;
            if (err) return reject(err);
            resolve();
        });
    });
}

async function restartProcess(name) {
    await connect();
    return new Promise((resolve, reject) => {
        let resolved = false;
        pm2.restart(name, (err) => {
            if (resolved) return;
            resolved = true;
            if (err) return reject(err);
            resolve();
        });
    });
}

async function deleteProcess(name) {
    await connect();
    return new Promise((resolve, reject) => {
        let resolved = false;
        pm2.delete(name, (err) => {
            if (resolved) return;
            resolved = true;
            if (err && err.message !== 'process or namespace not found') return reject(err);
            resolve();
        });
    });
}

async function listProcesses() {
    await connect();
    return new Promise((resolve, reject) => {
        let resolved = false;
        pm2.list((err, list) => {
            if (resolved) return;
            resolved = true;
            if (err) return reject(err);
            resolve(list);
        });
    });
}

module.exports = {
    startProcess,
    stopProcess,
    restartProcess,
    deleteProcess,
    listProcesses,
    runCommand,
    killPort
};
