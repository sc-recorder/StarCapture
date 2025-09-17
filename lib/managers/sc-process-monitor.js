const si = require('systeminformation');
const path = require('path');
const fs = require('fs').promises;
const BaseManager = require('./base-manager');
const Logger = require('../logger');

/**
 * Star Citizen Process Monitor Manager
 * Monitors for running Star Citizen instances and determines which version
 */
class SCProcessMonitor extends BaseManager {
    constructor() {
        super('sc-process');
        this.logger = new Logger('sc-process-monitor');
        this.monitoring = false;
        this.shutdownRequested = false;
        this.currentInstance = null;
        this.scInstallPath = null;
        this.checkInterval = null;
        this.processStartTime = null; // Track when we first detect SC running
    }

    /**
     * Handle commands from supervisor
     */
    async handleCommand(command) {
        switch (command.type) {
            case 'start-monitoring':
                await this.startMonitoring(command.config);
                break;
                
            case 'stop-monitoring':
                this.stopMonitoring();
                break;
                
            case 'sc-instance-detected':
                // Log worker has detected which instance is active
                this.handleInstanceDetected(command.data);
                break;
                
            case 'shutdown':
                await this.shutdown();
                break;
                
            default:
                this.logger.log(`Unknown command type: ${command.type}`);
        }
    }
    
    /**
     * Handle when log worker detects the active instance
     */
    handleInstanceDetected(data) {
        const { instance, logPath } = data;
        this.logger.log(`Log worker detected active instance: ${instance}`);
        
        if (this.currentInstance && this.currentInstance.type === 'WAITING') {
            this.currentInstance.type = instance;
            this.currentInstance.logPath = logPath;
            this.notifyStatusChange();
        }
    }

    /**
     * Start monitoring for Star Citizen process
     */
    async startMonitoring(config) {
        this.logger.log('Starting monitoring...');
        this.monitoring = true;
        this.scInstallPath = config?.starCitizenPath;
        
        if (this.scInstallPath) {
            this.logger.log('Configured SC path:', this.scInstallPath);
        } else {
            this.logger.log('No specific SC path configured, will detect from process');
        }
        
        // Check for SC process every 5 seconds
        this.checkInterval = setInterval(async () => {
            await this.checkStarCitizenProcess();
        }, 5000);
        
        // Do initial check
        this.logger.log('Performing initial check for StarCitizen.exe...');
        await this.checkStarCitizenProcess();
    }

    /**
     * Detect all available Star Citizen instances with log files
     */
    async detectAvailableInstances() {
        if (!this.scInstallPath) {
            this.logger.log('No SC install path configured');
            return [];
        }
        
        const instances = ['LIVE', 'PTU', 'EPTU', 'HOTFIX', 'TECH-PREVIEW'];
        const availableInstances = [];
        
        // Check each possible instance folder
        for (const instance of instances) {
            try {
                // Check if the instance folder exists
                const instancePath = path.join(this.scInstallPath, instance);
                await fs.access(instancePath);
                
                // Check for Game.log in the instance folder
                const logPath = path.join(instancePath, 'Game.log');
                try {
                    const stats = await fs.stat(logPath);
                    this.logger.log(`Found ${instance} with log modified: ${new Date(stats.mtimeMs).toISOString()}`);
                    
                    availableInstances.push({
                        instance: instance,
                        logPath: logPath,
                        lastModified: stats.mtimeMs
                    });
                } catch (err) {
                    // Log file doesn't exist or can't be accessed
                    this.logger.log(`No log file for ${instance}`);
                }
            } catch (err) {
                // Instance folder doesn't exist
                this.logger.log(`${instance} folder not found`);
            }
        }
        
        return availableInstances;
    }

    async checkStarCitizenProcess() {
        if (!this.monitoring) return;
        
        try {
            // Get all running processes
            const processes = await si.processes();
            
            // Look for StarCitizen.exe
            const scProcess = processes.list.find(proc => 
                proc.name === 'StarCitizen.exe' || 
                proc.name === 'StarCitizen'
            );
            
            if (scProcess) {
                // Found Star Citizen running
                const isNewProcess = !this.currentInstance || this.currentInstance.pid !== scProcess.pid;
                
                if (isNewProcess) {
                    this.logger.log('✓ Found StarCitizen.exe (PID: ' + scProcess.pid + ')');
                    
                    // Track when we first detected this process
                    if (!this.processStartTime || this.currentInstance?.pid !== scProcess.pid) {
                        this.processStartTime = Date.now();
                        this.logger.log('New process detected at:', new Date(this.processStartTime).toISOString());
                    }
                    
                    // Get all available instances with log files
                    const availableInstances = await this.detectAvailableInstances();
                    
                    if (availableInstances.length > 0) {
                        this.logger.log(`Found ${availableInstances.length} available instance(s)`);
                        
                        // Set initial state to WAITING
                        this.currentInstance = {
                            type: 'WAITING',
                            executablePath: 'StarCitizen.exe',
                            logPath: null,
                            pid: scProcess.pid
                        };
                        
                        this.notifyStatusChange();
                        
                        // Send all available log paths to the log worker to monitor
                        this.emit('monitor-logs', {
                            processStartTime: this.processStartTime,
                            instances: availableInstances
                        });
                    } else {
                        this.logger.log('No available instances found');
                        
                        this.currentInstance = {
                            type: 'UNKNOWN',
                            executablePath: 'StarCitizen.exe',
                            logPath: null,
                            pid: scProcess.pid
                        };
                        
                        this.notifyStatusChange();
                    }
                }
            } else {
                // No Star Citizen process found
                if (this.currentInstance) {
                    this.logger.log('Star Citizen stopped');
                    this.currentInstance = null;
                    this.processStartTime = null;
                    this.notifyStatusChange();
                    
                    // Notify log worker to stop monitoring
                    this.emit('sc-stopped', {});
                }
            }
        } catch (error) {
            this.logger.error('Error checking process:', error);
        }
    }

    /**
     * Notify supervisor of status change
     */
    notifyStatusChange() {
        this.emit('sc-status', {
            running: !!this.currentInstance,
            instance: this.currentInstance?.type || null,
            executablePath: this.currentInstance?.executablePath || null,
            logPath: this.currentInstance?.logPath || null
        });
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        this.logger.log('Stopping monitoring');
        this.monitoring = false;
        
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        
        this.currentInstance = null;
        this.notifyStatusChange();
    }

    /**
     * Shutdown manager
     */
    async shutdown() {
        this.logger.log('Shutting down manager...');
        this.shutdownRequested = true;
        this.stopMonitoring();
        await super.shutdown();
    }
}

module.exports = SCProcessMonitor;