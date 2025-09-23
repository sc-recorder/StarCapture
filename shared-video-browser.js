/**
 * Shared Video Browser Module
 * Provides video browsing functionality for both post view and edit view
 */
class SharedVideoBrowser {
    constructor(options = {}) {
        this.modalId = options.modalId || 'video-browser-modal';
        this.onVideoSelected = options.onVideoSelected || null;
        this.onEventsSelected = options.onEventsSelected || null;
        this.currentFolder = 'recordings'; // Default to recordings folder

        // Create modal if it doesn't exist
        this.createModal();
    }
    
    /**
     * Create the modal HTML if it doesn't exist
     */
    createModal() {
        // Check if modal already exists
        if (document.getElementById(this.modalId)) {
            return;
        }

        // Make sure we're in a browser environment
        if (typeof document === 'undefined') {
            console.error('SharedVideoBrowser: document is not available');
            return;
        }

        // Create modal HTML
        const modal = document.createElement('div');
        modal.id = this.modalId;
        modal.className = 'modal';
        modal.style.display = 'none';
        
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Available Recordings</h3>
                    <button class="modal-close" id="${this.modalId}-close">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="folder-tabs">
                        <button class="folder-tab active" data-folder="recordings" id="${this.modalId}-recordings-tab">Recordings</button>
                        <button class="folder-tab" data-folder="saved" id="${this.modalId}-saved-tab">Saved</button>
                        <button class="folder-tab" data-folder="edited" id="${this.modalId}-edited-tab">Edited</button>
                    </div>
                    <div class="browser-controls">
                        <button id="${this.modalId}-refresh" class="btn btn-sm">🔄 Refresh</button>
                        <span class="browser-path" id="${this.modalId}-path">--</span>
                    </div>
                    <div class="video-list" id="${this.modalId}-list">
                        <!-- Video items will be populated here -->
                    </div>
                </div>
            </div>
        `;
        
        // Make sure body exists before appending
        if (document.body) {
            document.body.appendChild(modal);
            // Setup event listeners after modal is added to DOM
            setTimeout(() => this.setupModalEventListeners(), 0);
        } else {
            console.error('SharedVideoBrowser: document.body not available, deferring modal creation');
            // Try again after DOM is ready
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    if (document.body && !document.getElementById(this.modalId)) {
                        document.body.appendChild(modal);
                        // Setup event listeners after modal is added to DOM
                        setTimeout(() => this.setupModalEventListeners(), 0);
                    }
                });
            }
        }
    }

    /**
     * Setup modal-specific event listeners
     */
    setupModalEventListeners() {
        try {
            // Close button
            const closeBtn = document.getElementById(`${this.modalId}-close`);
            if (closeBtn) {
                closeBtn.addEventListener('click', () => this.hide());
            } else {
                console.warn(`[SharedVideoBrowser] Close button not found for ${this.modalId}`);
            }

            // Refresh button
            const refreshBtn = document.getElementById(`${this.modalId}-refresh`);
            if (refreshBtn) {
                refreshBtn.addEventListener('click', () => this.loadVideoList());
            } else {
                console.warn(`[SharedVideoBrowser] Refresh button not found for ${this.modalId}`);
            }

            // Get modal element once
            const modal = document.getElementById(this.modalId);
            if (modal) {
                // Folder tabs - scope to this modal only
                const folderTabs = modal.querySelectorAll('.folder-tab');
                folderTabs.forEach(tab => {
                    tab.addEventListener('click', (e) => {
                        // Update active tab
                        folderTabs.forEach(t => t.classList.remove('active'));
                        e.target.classList.add('active');

                        // Update current folder and reload
                        this.currentFolder = e.target.dataset.folder;
                        this.loadVideoList();
                    });
                });

                // Click outside to close
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) {
                        this.hide();
                    }
                });
            }
        } catch (error) {
            console.error('Error setting up SharedVideoBrowser event listeners:', error);
        }
    }
    
    /**
     * Show the browser modal
     */
    async show() {
        const modal = document.getElementById(this.modalId);
        if (modal) {
            modal.style.display = 'flex';
            await this.loadVideoList();
        } else {
            console.error('Video browser modal not found');
        }
    }
    
    /**
     * Hide the browser modal
     */
    hide() {
        const modal = document.getElementById(this.modalId);
        if (modal) {
            modal.style.display = 'none';
        }
    }
    
    /**
     * Load list of videos from recording directory
     */
    async loadVideoList() {
        try {
            const recordings = await ipcRenderer.invoke('get-recordings-list', this.currentFolder);
            this.displayVideoList(recordings);
        } catch (error) {
            console.error('Failed to load video list:', error);
            this.displayVideoList([]);
        }
    }
    
    /**
     * Display video list in browser
     */
    displayVideoList(recordings) {
        const videoListEl = document.getElementById(`${this.modalId}-list`);
        const pathEl = document.getElementById(`${this.modalId}-path`);
        
        if (!videoListEl) return;
        
        // Update path display - get from config or first recording
        if (pathEl && recordings.length > 0) {
            // Extract directory from first recording path
            const firstPath = recordings[0].path;
            const directory = firstPath.substring(0, firstPath.lastIndexOf('\\'));
            pathEl.textContent = directory;
        }
        
        // Clear existing list
        videoListEl.innerHTML = '';
        
        if (!recordings || recordings.length === 0) {
            videoListEl.innerHTML = '<div class="no-videos">No recordings found</div>';
            return;
        }
        
        // Create video items
        recordings.forEach(video => {
            const videoItem = document.createElement('div');
            videoItem.className = video.hasEvents ? 'video-item has-events' : 'video-item';
            
            const date = new Date(video.modified);
            const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
            
            videoItem.innerHTML = `
                <div class="video-info">
                    <div class="video-name">${video.name}</div>
                    <div class="video-details">
                        <span class="video-date">📅 ${dateStr}</span>
                        <span class="video-size">💾 ${this.formatFileSize(video.size)}</span>
                        ${video.eventCount > 0 ? `<span class="video-events">📊 ${video.eventCount} events</span>` : ''}
                    </div>
                </div>
                <div class="video-actions">
                    <button class="btn btn-sm btn-primary load-btn" data-path="${video.path}">Load</button>
                </div>
            `;
            
            // Add click handler for Load button
            const loadBtn = videoItem.querySelector('.load-btn');
            if (loadBtn) {
                loadBtn.addEventListener('click', () => {
                    this.selectVideo(video);
                });
            }
            
            videoListEl.appendChild(videoItem);
        });
    }
    
    /**
     * Handle video selection
     */
    selectVideo(video) {
        
        if (this.onVideoSelected) {
            this.onVideoSelected(video);
        }
        
        // Close modal after selection
        this.hide();
    }
    
    /**
     * Handle events selection
     */
    selectEvents(video) {
        
        if (this.onEventsSelected) {
            this.onEventsSelected(video);
        }
    }
    
    /**
     * Format file size
     */
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }
}

// Export for use in other modules
window.SharedVideoBrowser = SharedVideoBrowser;