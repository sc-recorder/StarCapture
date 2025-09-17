const fs = require('fs');
const path = require('path');
const { Tail } = require('tail');
const SCLogParser = require('../sc-log-parser');
const BaseManager = require('./base-manager');
const Logger = require('../logger');

/**
 * Star Citizen Log Monitor Manager
 * Monitors Star Citizen log files for events
 */
class SCLogMonitor extends BaseManager {
    constructor() {
        super('sc-log');
        this.logger = new Logger('sc-log-monitor');
        this.logPath = null;
        this.monitoring = false;
        this.shutdownRequested = false;
        this.tail = null;
        this.instance = null;
        this.lastEventTime = null;
        this.multiMonitoring = false;
        this.monitoredFiles = new Map(); // Map of instance -> tail
        this.processStartTime = null;
        this.activeInstanceDetected = false;
        
        // Initialize the log parser
        this.parser = new SCLogParser();
        this.parserReady = false;
        
        // Initialize the parser
        this.initializeParser();
    }

    /**
     * Handle commands from supervisor
     */
    async handleCommand(command) {
        switch (command.type) {
            case 'set-log-path':
                // Receive log path from SC process monitor
                this.setLogPath(command.data);
                break;
                
            case 'monitor-multiple':
                // Monitor multiple log files to detect active instance
                await this.startMultipleMonitoring(command.data);
                break;
                
            case 'start-monitoring':
                await this.startMonitoring(command.path);
                break;
                
            case 'stop-monitoring':
                this.stopMonitoring();
                break;
                
            case 'shutdown':
                await this.shutdown();
                break;
                
            default:
                this.logger.log(`Unknown command type: ${command.type}`);
        }
    }

    /**
     * Initialize the log parser
     */
    async initializeParser() {
        try {
            this.logger.log('Initializing log parser...');
            const success = await this.parser.loadPatterns();
            this.parserReady = success;
            
            if (success) {
                this.logger.log('Parser initialized successfully');
                const patterns = this.parser.getPatterns();
                this.logger.log(`Loaded ${patterns.length} event patterns`);
            } else {
                this.logger.warn('Parser using fallback patterns');
            }
        } catch (error) {
            this.logger.error('Failed to initialize parser:', error);
            this.parserReady = false;
        }
    }

    /**
     * Set log path from SC process monitor
     */
    setLogPath(data) {
        const { instance, logPath } = data;
        
        this.logger.log(`Received log path for ${instance}: ${logPath}`);
        
        // If we're already monitoring a different log, stop it
        if (this.logPath && this.logPath !== logPath) {
            this.stopMonitoring();
        }
        
        this.instance = instance;
        this.logPath = logPath;
        
        // Automatically start monitoring if we have a valid path
        if (logPath && fs.existsSync(logPath)) {
            this.startMonitoring(logPath);
        }
    }

    /**
     * Start monitoring log file
     */
    async startMonitoring(logPath) {
        if (!logPath) {
            logPath = this.logPath;
        }
        
        if (!logPath || !fs.existsSync(logPath)) {
            this.logger.warn(`Cannot monitor - log file not found: ${logPath}`);
            return;
        }
        
        // Stop any existing monitoring
        if (this.tail) {
            this.tail.unwatch();
            this.tail = null;
        }
        
        this.logger.log(`Starting monitoring: ${logPath}`);
        this.logPath = logPath;
        this.monitoring = true;
        
        try {
            // Use tail to monitor the log file
            this.tail = new Tail(logPath, {
                fromBeginning: false,
                follow: true,
                logger: console,
                useWatchFile: true,
                fsWatchOptions: {
                    interval: 1000
                }
            });
            
            this.tail.on('line', (line) => {
                this.parseLine(line);
            });
            
            this.tail.on('error', (error) => {
                this.logger.error('Tail error:', error);
            });
            
            this.emit('sc-status', { 
                logActive: true,
                instance: this.instance,
                logPath: this.logPath
            });
        } catch (error) {
            this.logger.error('Failed to start monitoring:', error);
            this.monitoring = false;
            
            this.emit('sc-status', { 
                logActive: false,
                error: error.message
            });
        }
    }

    /**
     * Parse a log line for events
     */
    parseLine(line) {
        try {
            // Use the new parser if ready
            if (this.parserReady && this.parser) {
                const events = this.parser.parseLine(line);
                
                // Send each detected event
                for (const event of events) {
                    this.sendEvent({
                        type: event.category,
                        subtype: event.id,
                        name: event.name,
                        severity: event.severity,
                        timestamp: event.timestamp || new Date().toISOString(),
                        message: event.message,
                        data: event.data,
                        categoryInfo: event.categoryInfo,
                        raw: line
                    });
                }
            } else {
                // Fallback to basic detection if parser not ready
                // Kill event pattern
                if (line.includes(' killed ')) {
                    const killMatch = line.match(/(\S+) killed (\S+)/);
                    if (killMatch) {
                        this.sendEvent({
                            type: 'combat',
                            subtype: 'kill',
                            name: 'Player Kill',
                            data: {
                                killer: killMatch[1],
                                victim: killMatch[2]
                            },
                            message: `${killMatch[1]} killed ${killMatch[2]}`,
                            timestamp: new Date().toISOString(),
                            raw: line
                        });
                    }
                }
                
                // Death event pattern
                if (line.includes(' died') || line.includes('Player Death')) {
                    const deathMatch = line.match(/Player (\S+) died/);
                    if (deathMatch) {
                        this.sendEvent({
                            type: 'combat',
                            subtype: 'death',
                            name: 'Player Death',
                            data: {
                                player: deathMatch[1]
                            },
                            message: `${deathMatch[1]} died`,
                            timestamp: new Date().toISOString(),
                            raw: line
                        });
                    }
                }
                
                // Bounty completion
                if (line.includes('Bounty Completed') || line.includes('Contract Completed')) {
                    this.sendEvent({
                        type: 'mission',
                        subtype: 'bounty_completed',
                        name: 'Bounty Completed',
                        message: 'Bounty completed',
                        timestamp: new Date().toISOString(),
                        raw: line
                    });
                }
                
                // Location change (quantum travel, landing, etc.)
                if (line.includes('Quantum Travel') || line.includes('Landing Zone')) {
                    this.sendEvent({
                        type: 'location',
                        subtype: 'location_change',
                        name: 'Location Change',
                        message: 'Location changed',
                        timestamp: new Date().toISOString(),
                        raw: line
                    });
                }
            }
        } catch (error) {
            this.logger.error('Error parsing line:', error);
        }
    }

    /**
     * Send event to supervisor
     */
    sendEvent(event) {
        this.logger.log('Event detected:', event.type);
        
        this.emit('event', {
            source: 'star-citizen',
            instance: this.instance,
            ...event
        });
        
        this.lastEventTime = new Date();
    }

    /**
     * Start monitoring multiple log files to detect the active one
     */
    async startMultipleMonitoring(data) {
        const { processStartTime, instances } = data;
        this.processStartTime = processStartTime;
        this.multiMonitoring = true;
        this.activeInstanceDetected = false;
        
        this.logger.log(`Starting multi-file monitoring for ${instances.length} instances`);
        
        // Clear any existing monitors
        this.stopAllMonitoring();
        
        // Send initial waiting status
        this.emit('sc-status', { 
            logActive: false,
            instance: 'WAITING'
        });
        
        // Start monitoring each available log file
        for (const inst of instances) {
            try {
                this.logger.log(`Starting monitor for ${inst.instance}: ${inst.logPath}`);
                
                const tail = new Tail(inst.logPath, {
                    fromBeginning: false,
                    follow: true,
                    logger: console,
                    useWatchFile: true,
                    fsWatchOptions: {
                        interval: 500  // Check more frequently during detection phase
                    }
                });
                
                // Track when we see actual new content
                tail.on('line', (line) => {
                    if (!this.activeInstanceDetected) {
                        // If we're seeing new lines, this is the active instance
                        this.logger.log(`Detected activity in ${inst.instance} log`);
                        this.handleActiveInstanceDetected(inst.instance, inst.logPath);
                    }
                });
                
                tail.on('error', (error) => {
                    this.logger.error(`Error monitoring ${inst.instance}:`, error);
                });
                
                this.monitoredFiles.set(inst.instance, tail);
            } catch (error) {
                this.logger.error(`Failed to start monitoring ${inst.instance}:`, error);
            }
        }
        
        // Set a timeout to pick the most recent if no activity detected
        setTimeout(() => {
            if (!this.activeInstanceDetected && instances.length > 0) {
                // Pick the most recently modified
                const mostRecent = instances.reduce((prev, curr) => 
                    curr.lastModified > prev.lastModified ? curr : prev
                );
                
                this.logger.log(`No activity detected, defaulting to most recent: ${mostRecent.instance}`);
                this.handleActiveInstanceDetected(mostRecent.instance, mostRecent.logPath);
            }
        }, 10000); // Wait 10 seconds for activity
    }
    
    /**
     * Handle when we've detected the active instance
     */
    handleActiveInstanceDetected(instance, logPath) {
        if (this.activeInstanceDetected) return; // Already detected
        
        this.activeInstanceDetected = true;
        this.instance = instance;
        this.logPath = logPath;
        
        this.logger.log(`Active instance confirmed: ${instance}`);
        
        // Stop monitoring other files
        for (const [inst, tail] of this.monitoredFiles) {
            if (inst !== instance) {
                this.logger.log(`Stopping monitor for ${inst}`);
                tail.unwatch();
                this.monitoredFiles.delete(inst);
            }
        }
        
        // Keep the active one
        this.tail = this.monitoredFiles.get(instance);
        this.monitoring = true;
        this.multiMonitoring = false;
        
        // Clear the line handler and add the proper parser
        this.tail.removeAllListeners('line');
        this.tail.on('line', (line) => {
            this.parseLine(line);
        });
        
        // Notify that we've detected the active instance
        this.emit('sc-instance-detected', {
            instance: instance,
            logPath: logPath
        });
        
        // Update status
        this.emit('sc-status', { 
            logActive: true,
            instance: instance,
            logPath: logPath
        });
    }
    
    /**
     * Stop all monitoring
     */
    stopAllMonitoring() {
        // Stop single monitor
        if (this.tail) {
            this.tail.unwatch();
            this.tail = null;
        }
        
        // Stop all multi-monitors
        for (const [instance, tail] of this.monitoredFiles) {
            this.logger.log(`Stopping monitor for ${instance}`);
            tail.unwatch();
        }
        this.monitoredFiles.clear();
        
        this.monitoring = false;
        this.multiMonitoring = false;
        this.activeInstanceDetected = false;
    }
    
    /**
     * Stop monitoring
     */
    stopMonitoring() {
        this.logger.log('Stopping monitoring');
        
        this.stopAllMonitoring();
        
        this.emit('sc-status', { 
            logActive: false,
            instance: this.instance
        });
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

module.exports = SCLogMonitor;