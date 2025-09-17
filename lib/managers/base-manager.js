const EventEmitter = require('events');

/**
 * Base Manager Class
 * Provides common functionality for all manager classes
 */
class BaseManager extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
        this.isRunning = false;
        this.heartbeatInterval = null;
    }

    /**
     * Initialize the manager
     */
    async initialize() {
        this.startHeartbeat();
        this.emit('ready');
        return true;
    }

    /**
     * Start heartbeat to supervisor
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.emit('heartbeat');
        }, 1000);
    }

    /**
     * Stop heartbeat
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Handle commands from supervisor
     */
    async handleCommand(command) {
        // Override in subclasses
        throw new Error('handleCommand must be implemented by subclass');
    }

    /**
     * Shutdown the manager
     */
    async shutdown() {
        this.stopHeartbeat();
        this.isRunning = false;
        this.emit('shutdown');
    }
}

module.exports = BaseManager;