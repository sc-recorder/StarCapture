const fs = require('fs').promises;
const path = require('path');

/**
 * Event Capture Manager
 * Manages recording events and syncs them with video timeline
 */
class EventCaptureManager {
    constructor() {
        this.events = [];
        this.recordingStartTime = null;
        this.recordingStartTimecode = null;
        this.recordingActive = false;
        this.eventFilePath = null;
        this.unsavedEvents = false;
    }

    /**
     * Start a new recording session
     */
    startRecording(recordingPath, startTimecode = null) {
        console.log('[EventCapture] Starting recording session:', recordingPath);
        
        this.events = [];
        this.recordingStartTime = Date.now();
        this.recordingStartTimecode = startTimecode || Date.now();
        this.recordingActive = true;
        this.unsavedEvents = false;
        
        // Generate event file path (same as video but with .json extension)
        if (recordingPath) {
            const parsedPath = path.parse(recordingPath);
            this.eventFilePath = path.join(
                parsedPath.dir,
                `${parsedPath.name}.json`
            );
            console.log('[EventCapture] Event file will be saved to:', this.eventFilePath);
        }
        
        // Add recording start event
        this.addEvent({
            type: 'system',
            subtype: 'recording_start',
            name: 'Recording Started',
            message: 'Recording started',
            severity: 'low',
            data: {
                startTime: new Date(this.recordingStartTime).toISOString()
            }
        });
        
        return {
            startTime: this.recordingStartTime,
            eventFilePath: this.eventFilePath
        };
    }

    /**
     * Stop recording session and save events
     */
    async stopRecording() {
        if (!this.recordingActive) {
            console.warn('[EventCapture] No active recording to stop');
            return null;
        }
        
        console.log('[EventCapture] Stopping recording session');
        
        // Add recording stop event
        const stopTime = Date.now();
        const duration = (stopTime - this.recordingStartTime) / 1000;
        
        this.addEvent({
            type: 'system',
            subtype: 'recording_stop',
            name: 'Recording Stopped',
            message: `Recording stopped after ${this.formatDuration(duration)}`,
            severity: 'low',
            data: {
                stopTime: new Date(stopTime).toISOString(),
                duration: duration
            }
        });
        
        // Save events to file
        const result = await this.saveEvents();
        
        // Reset state
        this.recordingActive = false;
        
        return result;
    }

    /**
     * Add an event to the capture
     */
    addEvent(event) {
        if (!this.recordingActive) {
            // Store events even when not recording, in case recording starts soon
            // This helps capture events that happen just before recording starts
            if (this.events.length > 100) {
                // Keep only last 100 events if not recording
                this.events = this.events.slice(-100);
            }
        }
        
        // Calculate video timestamp offset
        const eventTime = Date.now();
        const videoOffset = this.recordingActive 
            ? (eventTime - this.recordingStartTime) / 1000 
            : 0;
        
        // Enhanced event structure
        const capturedEvent = {
            id: this.generateEventId(),
            timestamp: new Date(eventTime).toISOString(),
            videoOffset: videoOffset, // Seconds from recording start
            videoTimecode: this.formatTimecode(videoOffset),
            type: event.type || 'unknown',
            subtype: event.subtype || '',
            name: event.name || 'Unknown Event',
            message: event.message || '',
            severity: event.severity || 'low',
            category: event.category || event.type,
            categoryInfo: event.categoryInfo || {},
            data: event.data || {},
            raw: event.raw || null,
            thumbnail: null  // Placeholder for event thumbnail
        };
        
        this.events.push(capturedEvent);
        this.unsavedEvents = true;
        
        // Auto-save periodically if recording
        if (this.recordingActive && this.events.length % 10 === 0) {
            this.saveEvents().catch(err => {
                console.error('[EventCapture] Auto-save failed:', err);
            });
        }
        
        return capturedEvent;
    }

    /**
     * Save events to JSON file
     */
    async saveEvents() {
        if (!this.eventFilePath) {
            console.warn('[EventCapture] No event file path set');
            return null;
        }
        
        if (this.events.length === 0) {
            console.log('[EventCapture] No events to save');
            return null;
        }
        
        try {
            const metadata = {
                version: '1.0.0',
                recorder: 'SC-Recorder',
                recordingStartTime: new Date(this.recordingStartTime).toISOString(),
                recordingStartTimecode: this.recordingStartTimecode,
                recordingDuration: this.recordingActive
                    ? (Date.now() - this.recordingStartTime) / 1000
                    : null,
                eventCount: this.events.length,
                categories: this.getCategorySummary(),
                savedAt: new Date().toISOString(),
                videoThumbnail: null  // Placeholder for main video thumbnail
            };
            
            const data = {
                metadata: metadata,
                events: this.events
            };
            
            // Ensure directory exists
            const dir = path.dirname(this.eventFilePath);
            await fs.mkdir(dir, { recursive: true });
            
            // Write JSON file
            await fs.writeFile(
                this.eventFilePath,
                JSON.stringify(data, null, 2),
                'utf8'
            );
            
            this.unsavedEvents = false;
            
            console.log(`[EventCapture] Saved ${this.events.length} events to ${this.eventFilePath}`);
            
            return {
                success: true,
                path: this.eventFilePath,
                eventCount: this.events.length
            };
        } catch (error) {
            console.error('[EventCapture] Failed to save events:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Load events from a JSON file
     */
    async loadEvents(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);
            
            if (data.events) {
                this.events = data.events;
                console.log(`[EventCapture] Loaded ${this.events.length} events from ${filePath}`);
                return data;
            }
            
            return null;
        } catch (error) {
            console.error('[EventCapture] Failed to load events:', error);
            return null;
        }
    }

    /**
     * Get events within a time range
     */
    getEventsByTimeRange(startOffset, endOffset) {
        return this.events.filter(event => 
            event.videoOffset >= startOffset && 
            event.videoOffset <= endOffset
        );
    }

    /**
     * Get events by type/category
     */
    getEventsByType(type, subtype = null) {
        return this.events.filter(event => {
            if (subtype) {
                return event.type === type && event.subtype === subtype;
            }
            return event.type === type || event.category === type;
        });
    }

    /**
     * Get category summary
     */
    getCategorySummary() {
        const summary = {};
        
        for (const event of this.events) {
            const category = event.category || event.type;
            if (!summary[category]) {
                summary[category] = {
                    count: 0,
                    types: {}
                };
            }
            
            summary[category].count++;
            
            if (event.subtype) {
                summary[category].types[event.subtype] = 
                    (summary[category].types[event.subtype] || 0) + 1;
            }
        }
        
        return summary;
    }

    /**
     * Get all events
     */
    getAllEvents() {
        return this.events;
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            recordingActive: this.recordingActive,
            recordingStartTime: this.recordingStartTime,
            eventCount: this.events.length,
            unsavedEvents: this.unsavedEvents,
            eventFilePath: this.eventFilePath,
            categories: this.getCategorySummary()
        };
    }

    /**
     * Update event thumbnails and metadata
     */
    async updateEventMetadata(thumbnailMap, mainThumbnailFilename = null) {
        if (!this.eventFilePath) {
            console.warn('[EventCapture] No event file path set');
            return null;
        }

        try {
            // Read existing JSON
            const content = await fs.readFile(this.eventFilePath, 'utf8');
            const data = JSON.parse(content);

            // Update main thumbnail in metadata
            if (mainThumbnailFilename) {
                data.metadata.videoThumbnail = mainThumbnailFilename;
            }

            // Update individual event thumbnails
            if (thumbnailMap) {
                data.events.forEach(event => {
                    if (thumbnailMap[event.id]) {
                        event.thumbnail = thumbnailMap[event.id];
                    }
                });

                // Also update in-memory events
                this.events.forEach(event => {
                    if (thumbnailMap[event.id]) {
                        event.thumbnail = thumbnailMap[event.id];
                    }
                });
            }

            // Save updated JSON
            await fs.writeFile(
                this.eventFilePath,
                JSON.stringify(data, null, 2),
                'utf8'
            );

            console.log('[EventCapture] Updated event metadata with thumbnails');
            return {
                success: true,
                mainThumbnail: mainThumbnailFilename,
                thumbnailCount: thumbnailMap ? Object.keys(thumbnailMap).length : 0
            };
        } catch (error) {
            console.error('[EventCapture] Failed to update event metadata:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Clear all events
     */
    clearEvents() {
        this.events = [];
        this.unsavedEvents = false;
        console.log('[EventCapture] Events cleared');
    }

    /**
     * Generate unique event ID
     */
    generateEventId() {
        return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Format duration in seconds to readable format
     */
    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes}m ${secs}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    /**
     * Format video timecode
     */
    formatTimecode(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    /**
     * Update recording path (in case OBS changes it)
     */
    updateRecordingPath(newPath) {
        if (this.recordingActive && newPath) {
            console.log('[EventCapture] Updating recording path:', newPath);

            // Update event file path
            const parsedPath = path.parse(newPath);
            this.eventFilePath = path.join(
                parsedPath.dir,
                `${parsedPath.name}.json`
            );
        }
    }

    /**
     * Sync with OBS timecode
     */
    syncWithOBSTimecode(obsTimecode) {
        // This can be used to sync with OBS's internal timecode
        // for more accurate timestamp alignment
        if (this.recordingActive && obsTimecode) {
            const drift = obsTimecode - this.recordingStartTimecode;
            if (Math.abs(drift) > 1000) { // More than 1 second drift
                console.log('[EventCapture] Syncing with OBS timecode, drift:', drift);
                this.recordingStartTimecode = obsTimecode;
            }
        }
    }
}

module.exports = EventCaptureManager;