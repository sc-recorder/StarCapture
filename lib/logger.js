const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
    constructor(name) {
        this.name = name;

        // Load logging configuration from package.json
        try {
            const packageJson = require('../package.json');
            this.config = packageJson.logging || {};
        } catch (error) {
            this.config = {};
        }

        // Set log levels (error=0, warn=1, info=2, debug=3)
        const levelMap = { 'error': 0, 'warn': 1, 'info': 2, 'debug': 3 };
        this.fileLevel = levelMap[this.config.file?.level || 'info'] || 2;
        this.fileEnabled = this.config.file?.enabled !== false;

        // Always use APPDATA for logs
        const appData = process.env.APPDATA || process.env.HOME;
        this.logDir = path.join(appData, 'sc-recorder', 'logs');

        // Ensure logs directory exists
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }

        // Create log file with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        this.logFile = path.join(this.logDir, `${this.name}-${timestamp}.log`);

        // Also keep a latest.log for easy access
        this.latestLogFile = path.join(this.logDir, `${this.name}-latest.log`);

        // Write queue for async writes
        this.writeQueue = [];
        this.isWriting = false;

        // Write header
        this.writeToFile(`===== ${this.name} Logger Started at ${new Date().toISOString()} =====`);
        this.writeToFile(`Process: ${process.pid}`);
        this.writeToFile(`Node: ${process.version}`);
        this.writeToFile(`Platform: ${process.platform}`);
        this.writeToFile(`Working Directory: ${process.cwd()}`);
        this.writeToFile(`Executable: ${process.execPath}`);
        this.writeToFile(`Packaged: ${app ? app.isPackaged : 'N/A'}`);
        this.writeToFile(`Log Directory: ${this.logDir}`);
        this.writeToFile('=====================================\n');
    }

    writeToFile(message) {
        if (!this.fileEnabled) return;

        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}\n`;

        // Add to queue
        this.writeQueue.push(logLine);

        // Process queue asynchronously
        if (!this.isWriting) {
            this.processWriteQueue();
        }
    }

    async processWriteQueue() {
        if (this.writeQueue.length === 0) {
            this.isWriting = false;
            return;
        }

        this.isWriting = true;
        const batch = this.writeQueue.splice(0, 100); // Process up to 100 entries at once
        const batchData = batch.join('');

        try {
            await fs.promises.appendFile(this.logFile, batchData);
            await fs.promises.writeFile(this.latestLogFile, batchData, { flag: 'a' });
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }

        // Continue processing if more items in queue
        if (this.writeQueue.length > 0) {
            setImmediate(() => this.processWriteQueue());
        } else {
            this.isWriting = false;
        }
    }
    
    log(...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');

        console.log(`[${this.name}]`, ...args);

        // Only write to file if level permits (info=2)
        if (this.fileLevel >= 2) {
            this.writeToFile(`[INFO] ${message}`);
        }
    }

    error(...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');

        console.error(`[${this.name}]`, ...args);

        // Always write errors (error=0)
        if (this.fileLevel >= 0) {
            this.writeToFile(`[ERROR] ${message}`);
        }
    }

    warn(...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');

        console.warn(`[${this.name}]`, ...args);

        // Only write to file if level permits (warn=1)
        if (this.fileLevel >= 1) {
            this.writeToFile(`[WARN] ${message}`);
        }
    }

    debug(...args) {
        // Skip debug logging entirely if not enabled
        if (this.fileLevel < 3) {
            return;
        }

        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');

        console.log(`[${this.name}] [DEBUG]`, ...args);
        this.writeToFile(`[DEBUG] ${message}`);
    }
}

module.exports = Logger;