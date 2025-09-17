const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Logger {
    constructor(name) {
        this.name = name;
        
        // Determine log directory based on environment
        if (app) {
            // Main process - use exe directory for portable app
            const exePath = app.getPath('exe');
            this.logDir = app.isPackaged 
                ? path.join(path.dirname(exePath), 'logs')
                : path.join(__dirname, '..', 'logs');
        } else {
            // Worker process - use process.cwd() or relative path
            this.logDir = path.join(process.cwd(), 'logs');
        }
        
        // Ensure logs directory exists
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        
        // Create log file with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        this.logFile = path.join(this.logDir, `${this.name}-${timestamp}.log`);
        
        // Also keep a latest.log for easy access
        this.latestLogFile = path.join(this.logDir, `${this.name}-latest.log`);
        
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
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}\n`;
        
        // Write to both files
        try {
            fs.appendFileSync(this.logFile, logLine);
            fs.writeFileSync(this.latestLogFile, logLine, { flag: 'a' });
        } catch (error) {
            console.error('Failed to write to log file:', error);
        }
    }
    
    log(...args) {
        const message = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');
        
        console.log(`[${this.name}]`, ...args);
        this.writeToFile(`[INFO] ${message}`);
    }
    
    error(...args) {
        const message = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');
        
        console.error(`[${this.name}]`, ...args);
        this.writeToFile(`[ERROR] ${message}`);
    }
    
    warn(...args) {
        const message = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');
        
        console.warn(`[${this.name}]`, ...args);
        this.writeToFile(`[WARN] ${message}`);
    }
    
    debug(...args) {
        const message = args.map(arg => 
            typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg
        ).join(' ');
        
        console.log(`[${this.name}] [DEBUG]`, ...args);
        this.writeToFile(`[DEBUG] ${message}`);
    }
}

module.exports = Logger;