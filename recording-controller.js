/**
 * Recording Controller
 * Manages recording operations through WebSocket connection to OBS
 */
class RecordingController {
    constructor() {
        this.isRecording = false;
        this.statsInterval = null;
        this.recordButton = null;
        this.systemReady = false;
        this.statusPollInterval = null;
        this.currentRecordingPath = null;  // Track the current recording path

        this.init();
    }
    
    init() {
        // Get DOM elements
        this.recordButton = document.getElementById('record-button');
        this.recordIcon = this.recordButton?.querySelector('.record-icon');
        this.recordText = this.recordButton?.querySelector('.record-text');
        this.splitButton = document.getElementById('split-recording-btn');
        this.markEventButton = document.getElementById('mark-event-btn');
        this.saveButton = document.getElementById('save-current-recording-btn');


        // Ensure save button starts disabled
        if (this.saveButton) {
            this.saveButton.disabled = true;
        }

        // Setup event listeners
        this.recordButton?.addEventListener('click', () => this.toggleRecording());
        this.splitButton?.addEventListener('click', () => this.splitRecording());
        this.markEventButton?.addEventListener('click', () => this.markManualEvent());

        if (this.saveButton) {
            this.saveButton.addEventListener('click', () => {
                this.saveRecording();
            });
        } else {
            console.error('Save button not found during init');
        }
        
        // Add open folder button handler
        const openFolderBtn = document.getElementById('open-folder-btn');
        if (openFolderBtn) {
            openFolderBtn.addEventListener('click', async () => {
                try {
                    const result = await ipcRenderer.invoke('open-recording-folder');
                    if (!result.success) {
                        console.error('Failed to open folder:', result.error);
                    }
                } catch (error) {
                    console.error('Error opening recording folder:', error);
                }
            });
        }
        
        // Listen for status updates
        ipcRenderer.on('status-update', (event, state) => {
            this.updateSystemStatus(state);
        });
        
        // Listen for recording status
        ipcRenderer.on('recording-status', (event, status) => {
            this.updateRecordingStatus(status);
        });
        
        // Listen for captured events
        ipcRenderer.on('event', (event, eventData) => {
            this.handleCapturedEvent(eventData);
        });

        // Listen for manual events created via hotkey
        ipcRenderer.on('manual-event-created', (event, manualEvent) => {
            // The event will also come through the normal 'event' channel,
            // so we don't need to handle it specially here
        });

        // Listen for events saved notification
        ipcRenderer.on('events-saved', (event, result) => {
            this.handleEventsSaved(result);
        });
        
        // Initial check of system ready status
        if (this.recordButton) {
            this.systemReady = window.systemReady || false;
            this.recordButton.disabled = !this.systemReady;
        }

        // Ensure save button stays disabled on startup regardless of any initial status
        if (this.saveButton) {
            this.saveButton.disabled = true;
            this.saveButton.style.opacity = '0.5';
            this.saveButton.style.cursor = 'not-allowed';

            // Double-check in a moment to catch any async changes
            setTimeout(() => {
                if (this.saveButton) {
                    if (!this.saveButton.disabled) {
                        console.error('WARNING: Save button was re-enabled somehow!');
                        this.saveButton.disabled = true;
                        console.log('Re-disabled save button');
                    }
                }
            }, 100);
        }
        
        // Poll for system ready status every 500ms
        this.statusPollInterval = setInterval(() => {
            const currentReady = window.systemReady || false;
            if (currentReady !== this.systemReady) {
                this.systemReady = currentReady;
                if (this.recordButton && !this.isRecording) {
                    this.recordButton.disabled = !this.systemReady;
                }
            }
        }, 500);
        
        // Get initial status
        this.checkSystemStatus();
    }
    

    /**
     * Check system status and update UI
     */
    async checkSystemStatus() {
        const status = await ipcRenderer.invoke('get-status');
        if (status) {
            this.updateSystemStatus(status);
        }
    }
    
    /**
     * Update system status indicators
     */
    updateSystemStatus(state) {
        // Only handle recording state changes
        if (state.recording?.active) {
            // Don't change disabled state while recording
            this.recordButton.disabled = false;
            this.isRecording = true;
            this.updateRecordButton(true);
            this.startStatsUpdate();
        } else if (state.recording?.active === false && this.isRecording) {
            this.isRecording = false;
            this.updateRecordButton(false);
            this.stopStatsUpdate();
        }
        // Let the polling handle the button enable/disable based on window.systemReady
    }
    
    /**
     * Toggle recording on/off
     */
    async toggleRecording() {
        if (!this.systemReady) return;

        try {
            if (this.isRecording) {
                // Stop recording
                const result = await ipcRenderer.invoke('stop-recording');
                if (result.success) {
                    this.isRecording = false;
                    this.updateRecordButton(false);
                    this.stopStatsUpdate();

                    // Enable save button when WE stop a recording
                    if (this.currentRecordingPath && this.saveButton) {
                        this.saveButton.disabled = false;
                        this.saveButton.style.opacity = '1';
                        this.saveButton.style.cursor = 'pointer';
                    }

                    // Keep stats panel visible - don't hide it
                    // Stats will remain visible until next recording starts
                }
            } else {
                // Start recording
                const result = await ipcRenderer.invoke('start-recording');
                if (result.success) {
                    this.isRecording = true;
                    this.updateRecordButton(true);

                    // Disable save button when starting a new recording
                    if (this.saveButton) {
                        this.saveButton.disabled = true;
                        this.saveButton.style.opacity = '0.5';
                        this.saveButton.style.cursor = 'not-allowed';
                    }

                    // Clear previous stats before starting new recording
                    this.clearStats();
                    this.clearEventList();

                    this.startStatsUpdate();
                }
            }
        } catch (error) {
            console.error('Recording toggle error:', error);
        }
    }
    
    /**
     * Update record button appearance
     */
    updateRecordButton(isRecording) {
        if (!this.recordButton) return;
        
        if (isRecording) {
            this.recordButton.className = 'record-btn recording';
            if (this.recordIcon) this.recordIcon.textContent = '■';
            if (this.recordText) this.recordText.textContent = 'Stop Recording';
            // Enable split and mark event buttons when recording
            if (this.splitButton) {
                this.splitButton.disabled = false;
            }
            if (this.markEventButton) {
                this.markEventButton.disabled = false;
            }
        } else {
            this.recordButton.className = 'record-btn';
            if (this.recordIcon) this.recordIcon.textContent = '●';
            if (this.recordText) this.recordText.textContent = 'Start Recording';
            // Disable split and mark event buttons when not recording
            if (this.splitButton) {
                this.splitButton.disabled = true;
            }
            if (this.markEventButton) {
                this.markEventButton.disabled = true;
            }
        }
    }
    
    /**
     * Split recording into a new file
     */
    async splitRecording() {
        if (!this.isRecording) return;
        
        try {
            console.log('Splitting recording to new file...');
            const result = await ipcRenderer.invoke('split-recording');
            if (result.success) {
                console.log('Recording split successfully');
                // Show a notification or update UI
                if (window.NotificationManager) {
                    window.NotificationManager.success('Recording split to new file', 3000);
                }
            } else {
                console.error('Failed to split recording:', result.error);
                if (window.NotificationManager) {
                    window.NotificationManager.error('Failed to split recording: ' + result.error, 5000);
                }
            }
        } catch (error) {
            console.error('Split recording error:', error);
            if (window.NotificationManager) {
                window.NotificationManager.error('Error splitting recording', 5000);
            }
        }
    }
    
    /**
     * Mark a manual event
     */
    async markManualEvent() {
        if (!this.isRecording) {
            console.log('Cannot mark event when not recording');
            return;
        }

        try {
            console.log('Marking manual event...');
            const result = await ipcRenderer.invoke('mark-manual-event');
            if (result.success) {
                console.log('Manual event marked successfully');
                // No notification needed - the event system will show one
            } else {
                console.error('Failed to mark event:', result.error);
                if (window.NotificationManager) {
                    window.NotificationManager.error('Failed to mark event: ' + result.error, 5000);
                }
            }
        } catch (error) {
            console.error('Mark event error:', error);
            if (window.NotificationManager) {
                window.NotificationManager.error('Error marking event', 5000);
            }
        }
    }

    /**
     * Start periodic stats updates
     */
    startStatsUpdate() {
        // Update immediately
        this.updateRecordingStats();
        
        // Then update every second
        this.statsInterval = setInterval(() => {
            this.updateRecordingStats();
        }, 1000);
    }
    
    /**
     * Stop stats updates
     */
    stopStatsUpdate() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }
    
    /**
     * Update recording statistics
     */
    async updateRecordingStats() {
        try {
            const stats = await ipcRenderer.invoke('get-recording-stats');
            if (stats) {
                // Update duration
                const durationEl = document.getElementById('rec-duration');
                if (durationEl) {
                    durationEl.textContent = this.formatDuration(stats.duration);
                }
                
                // Update file size
                const sizeEl = document.getElementById('rec-size');
                if (sizeEl) {
                    sizeEl.textContent = this.formatFileSize(stats.bytes);
                }
                
                // Update bitrate
                const bitrateEl = document.getElementById('rec-bitrate');
                if (bitrateEl && stats.kbitsPerSec) {
                    const mbps = (stats.kbitsPerSec / 1000).toFixed(1);
                    bitrateEl.textContent = `${mbps} Mbps`;
                }
                
                // Update FPS
                const fpsEl = document.getElementById('rec-fps');
                if (fpsEl && stats.fps) {
                    fpsEl.textContent = Math.round(stats.fps);
                }
                
                // Update filename
                const filenameEl = document.getElementById('rec-filename');
                if (filenameEl && stats.outputPath) {
                    // Show just the filename, not the full path
                    const filename = stats.outputPath.split(/[\\\/]/).pop();
                    filenameEl.textContent = filename;
                    filenameEl.title = stats.outputPath; // Full path on hover
                }
            }
        } catch (error) {
            console.error('Failed to get recording stats:', error);
        }
    }
    
    /**
     * Format duration in seconds to HH:MM:SS
     */
    formatDuration(seconds) {
        if (!seconds) return '--:--:--';
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        return [hours, minutes, secs]
            .map(v => v.toString().padStart(2, '0'))
            .join(':');
    }
    
    /**
     * Format bytes to human readable size
     */
    formatFileSize(bytes) {
        if (!bytes) return '--';
        
        const mb = bytes / (1024 * 1024);
        if (mb < 1000) {
            return `${mb.toFixed(1)} MB`;
        } else {
            const gb = mb / 1024;
            return `${gb.toFixed(2)} GB`;
        }
    }
    
    /**
     * Update recording status from external event
     */
    updateRecordingStatus(status) {

        // Update recording path if provided (we still need this for stats display)
        if (status.path || status.outputPath) {
            const newPath = status.path || status.outputPath;
            if (newPath) {
                this.currentRecordingPath = newPath;
            }
        }

        // Check both 'active' and 'outputActive' for compatibility
        const isActive = status.active || status.outputActive || false;

        if (isActive !== this.isRecording) {
            this.isRecording = isActive;
            this.updateRecordButton(isActive);

            if (isActive) {
                this.startStatsUpdate();
            } else {
                this.stopStatsUpdate();
            }
        }
    }
    
    /**
     * Handle captured event
     */
    async handleCapturedEvent(eventData) {
        if (!eventData || !eventData.captured) return;
        
        const event = eventData.captured;
        
        // Update event counter
        const eventCountEl = document.getElementById('event-count');
        if (eventCountEl) {
            const status = await ipcRenderer.invoke('get-event-capture-status').catch(() => null);
            if (status) {
                eventCountEl.textContent = status.eventCount;
            }
        }
        
        // Update last event time
        const lastEventEl = document.getElementById('last-event-time');
        if (lastEventEl && event.videoTimecode) {
            lastEventEl.textContent = event.videoTimecode;
        }
        
        // Add to event list if recording
        if (this.isRecording) {
            this.addEventToList(event);
        }
    }
    
    /**
     * Add event to the visual list
     */
    addEventToList(event) {
        const eventList = document.getElementById('event-list');
        const eventListCard = document.getElementById('event-list-card');
        const eventCounter = document.getElementById('event-list-counter');
        
        // Also show in header event display
        this.showEventInHeader(event);
        
        if (!eventList) return;
        
        // Event list card is now always visible, no need to show
        
        // Create event item element
        const eventItem = document.createElement('div');
        eventItem.className = `event-item ${event.category || event.type}`;
        
        // Get icon for category
        const icon = this.getEventIcon(event.category || event.type);
        
        // Build event item HTML
        eventItem.innerHTML = `
            <span class="event-time">${event.videoTimecode || '00:00:00'}</span>
            <span class="event-icon">${icon}</span>
            <span class="event-message">${event.message || event.name}</span>
            <span class="event-severity ${event.severity}">${event.severity || 'low'}</span>
        `;
        
        // Add to top of list (newest first)
        eventList.insertBefore(eventItem, eventList.firstChild);
        
        // Keep list size reasonable (max 50 visible)
        while (eventList.children.length > 50) {
            eventList.removeChild(eventList.lastChild);
        }
        
        // Update counter
        if (eventCounter) {
            const count = eventList.children.length;
            eventCounter.textContent = `${count} event${count !== 1 ? 's' : ''}`;
        }
    }
    
    /**
     * Get icon for event category
     */
    getEventIcon(category) {
        const icons = {
            combat: '⚔️',
            vehicle: '🚀',
            mission: '📋',
            system: '⚙️',
            player: '👤',
            location: '📍'
        };
        return icons[category] || '📌';
    }
    
    /**
     * Show event in header display
     */
    showEventInHeader(event) {
        const display = document.getElementById('current-event-display');
        const timeEl = document.getElementById('current-event-time');
        const nameEl = document.getElementById('current-event-name');
        const messageEl = document.getElementById('current-event-message');
        
        if (!display) return;
        
        // Update content
        if (timeEl) timeEl.textContent = event.videoTimecode || '00:00:00';
        if (nameEl) nameEl.textContent = event.name || event.type || 'Event';
        if (messageEl) messageEl.textContent = event.message || '';
        
        // Show the display
        display.style.display = 'block';
        
        // Auto-hide after 8 seconds (longer than during playback since recording is active)
        clearTimeout(this.eventDisplayTimeout);
        this.eventDisplayTimeout = setTimeout(() => {
            display.style.display = 'none';
        }, 8000);
    }
    
    /**
     * Handle events saved notification
     */
    handleEventsSaved(result) {
        if (result && result.success) {
            console.log(`Events saved to: ${result.path}`);
            // Could show a notification to the user
        }
    }
    
    /**
     * Clear recording stats
     */
    clearStats() {
        // Clear stat displays but keep panel visible
        const durationEl = document.getElementById('rec-duration');
        if (durationEl) durationEl.textContent = '--:--:--';
        
        const sizeEl = document.getElementById('rec-size');
        if (sizeEl) sizeEl.textContent = '--';
        
        const bitrateEl = document.getElementById('rec-bitrate');
        if (bitrateEl) bitrateEl.textContent = '--';
        
        const fpsEl = document.getElementById('rec-fps');
        if (fpsEl) fpsEl.textContent = '--';
        
        const filenameEl = document.getElementById('rec-filename');
        if (filenameEl) {
            filenameEl.textContent = '--';
            filenameEl.title = '';
        }
    }
    
    /**
     * Clear event list
     */
    clearEventList() {
        const eventList = document.getElementById('event-list');
        const eventListCard = document.getElementById('event-list-card');
        const eventCounter = document.getElementById('event-list-counter');
        
        if (eventList) {
            eventList.innerHTML = '';
        }
        
        // Event list card is now always visible, no need to hide
        
        if (eventCounter) {
            eventCounter.textContent = '0 events';
        }
        
        // Reset event count display
        const eventCountEl = document.getElementById('event-count');
        if (eventCountEl) {
            eventCountEl.textContent = '0';
        }
        
        const lastEventEl = document.getElementById('last-event-time');
        if (lastEventEl) {
            lastEventEl.textContent = '--';
        }
    }

    /**
     * Save the current recording by moving it to the saved folder
     */
    async saveRecording() {
        console.log('=== Save Recording Called ===');
        console.log('Save button clicked');

        if (!this.currentRecordingPath) {
            console.error('No recording path available');
            this.showNotification('No recording available to save', 'error');
            return;
        }

        if (this.isRecording) {
            console.error('Cannot save while recording is active');
            this.showNotification('Cannot save while recording is active', 'error');
            return;
        }

        try {
            console.log('Calling IPC to move recording...');
            // Call IPC to move the recording
            const result = await ipcRenderer.invoke('move-recording', this.currentRecordingPath);

            if (result && result.success) {

                // Clear the current recording path
                this.currentRecordingPath = null;

                // Disable the save button after saving
                if (this.saveButton) {
                    this.saveButton.disabled = true;
                    this.saveButton.style.opacity = '0.5';
                    this.saveButton.style.cursor = 'not-allowed';
                    console.log('Save button disabled after successful save');
                }

                // Show success notification
                this.showNotification('✅ Recording saved to "saved" folder', 'success');
            } else {
                const errorMsg = result?.error || 'Unknown error';
                console.error('Failed to save recording:', errorMsg);
                this.showNotification(`Failed to save recording: ${errorMsg}`, 'error');
            }
        } catch (error) {
            console.error('Error saving recording:', error);
            this.showNotification(`Error saving recording: ${error.message}`, 'error');
        }
    }

    /**
     * Show a notification message
     */
    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `<span>${message}</span>`;

        const bgColor = type === 'success' ? '#28a745' :
                       type === 'error' ? '#dc3545' :
                       '#17a2b8';

        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${bgColor};
            color: white;
            padding: 12px 20px;
            border-radius: 4px;
            z-index: 10000;
            animation: slideIn 0.3s ease;
            box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        `;

        document.body.appendChild(notification);

        // Remove notification after 3 seconds
        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
}

// Initialize with a small delay to ensure DOM is fully ready
console.log('Preparing to initialize RecordingController...');
setTimeout(() => {
    console.log('Initializing RecordingController...');
    window.recordingController = new RecordingController();
}, 50);