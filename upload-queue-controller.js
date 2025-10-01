/**
 * Upload Queue Controller
 * Manages the upload queue view and interactions
 */
class UploadQueueController {
    constructor() {
        this.uploads = {
            active: [],
            queued: [],
            completed: []
        };
        this.accounts = [];
        this.uploadDialog = null;
        this.videoBrowser = null;
        this.currentFilter = 'all';
        this.queuePaused = true;

        // Get ipcRenderer from global scope
        this.ipc = window.ipcRenderer || (typeof ipcRenderer !== 'undefined' ? ipcRenderer : null);

        this.setupEventListeners();
        this.initialize();
    }

    async initialize() {
        console.log('Initializing Upload Queue Controller');

        // Get shared upload dialog instance
        try {
            if (window.getUploadDialog) {
                this.uploadDialog = window.getUploadDialog();
            } else if (window.UploadDialog) {
                // Fallback to creating new instance if getUploadDialog not available
                this.uploadDialog = new window.UploadDialog();
            } else {
                console.error('UploadDialog not found on window');
            }
        } catch (error) {
            console.error('Failed to initialize UploadDialog:', error);
        }

        // Initialize shared video browser
        try {
            if (window.SharedVideoBrowser) {
                this.videoBrowser = new window.SharedVideoBrowser({
                    modalId: 'upload-video-browser-modal',
                    onVideoSelected: (video) => this.handleVideoSelected(video)
                });
            } else {
                console.error('SharedVideoBrowser not found on window');
            }
        } catch (error) {
            console.error('Failed to initialize SharedVideoBrowser:', error);
        }

        // Load initial state first, then render
        await this.loadUploadState();

        // Listen for upload state changes
        if (this.ipc) {
            this.ipc.on('upload-state-changed', (event, state) => {
                this.handleStateUpdate(state);
            });

            // Listen for specific upload events
            this.ipc.on('upload-started', (event, upload) => {
                this.handleUploadStarted(upload);
            });

            this.ipc.on('upload-progress', (event, data) => {
                this.updateUploadProgress(data);
            });

            this.ipc.on('upload-completed', (event, upload) => {
                this.handleUploadCompleted(upload);
            });

            this.ipc.on('upload-failed', (event, upload) => {
                this.handleUploadFailed(upload);
            });

            // Listen for queue state changes
            this.ipc.on('queue-started', () => {
                this.updateQueueButtons({ queuePaused: false });
            });

            this.ipc.on('queue-paused', () => {
                this.updateQueueButtons({ queuePaused: true });
            });
        }
    }

    setupEventListeners() {
        // Browse Recordings button
        document.getElementById('upload-browse-recordings-btn')?.addEventListener('click', () => {
            this.browseAndUpload();
        });

        // Clear Completed button
        document.getElementById('clear-completed-btn')?.addEventListener('click', () => {
            this.clearCompleted();
        });

        // Start Queue button
        document.getElementById('start-queue-btn')?.addEventListener('click', async () => {
            await this.startQueue();
        });

        // Pause Queue button
        document.getElementById('pause-queue-btn')?.addEventListener('click', async () => {
            await this.pauseQueue();
        });

        // Filter buttons
        document.querySelectorAll('.upload-filters .filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.applyFilter(e.target.dataset.filter);
                // Update active button
                document.querySelectorAll('.upload-filters .filter-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
            });
        });
    }

    async loadUploadState() {
        if (!this.ipc) return;

        try {
            const response = await this.ipc.invoke('upload:get-state');
            // Handle wrapped response from main process
            if (response && response.success && response.state) {
                this.handleStateUpdate(response.state);
            } else if (response && !response.success) {
                console.error('Failed to load upload state:', response.error);
            } else {
                // Fallback for direct state
                this.handleStateUpdate(response);
            }

            // Also get queue status
            const queueStatus = await this.ipc.invoke('upload:get-queue-status');
            if (queueStatus && queueStatus.success) {
                this.updateQueueButtons(queueStatus.status);
            }
        } catch (error) {
            console.error('Failed to load upload state:', error);
            // Still render even if loading fails
            this.renderUploads();
        }
    }

    handleStateUpdate(state) {
        // Update accounts first so they're available for rendering
        if (state && state.accounts) {
            this.accounts = Array.isArray(state.accounts) ? state.accounts : [];
        }

        if (state && state.uploads) {
            // Ensure uploads have the correct structure
            this.uploads = {
                active: state.uploads.active || [],
                queued: state.uploads.queued || [],
                completed: state.uploads.completed || []
            };
            this.renderUploads();
        }
    }

    renderUploads() {
        const container = document.getElementById('unified-uploads-list');
        if (!container) return;

        // Combine all uploads into a single list, sorted by status priority
        let allUploads = [
            ...this.uploads.active.map(u => ({ ...u, statusType: 'active' })),
            ...this.uploads.queued.map(u => ({ ...u, statusType: 'queued' })),
            ...this.uploads.completed.map(u => ({ ...u, statusType: 'completed' }))
        ];

        // Apply filter
        if (this.currentFilter !== 'all') {
            allUploads = allUploads.filter(upload => {
                switch (this.currentFilter) {
                    case 'queued':
                        return upload.statusType === 'queued';
                    case 'in-progress':
                        return upload.statusType === 'active';
                    case 'completed':
                        return upload.statusType === 'completed' && upload.status === 'completed';
                    case 'failed':
                        return upload.status === 'failed';
                    default:
                        return true;
                }
            });
        }

        if (allUploads.length === 0) {
            const filterText = this.currentFilter === 'all' ? '' : ` ${this.currentFilter}`;
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">☁️</div>
                    <p>No${filterText} uploads</p>
                    <p class="text-muted">Click "Browse & Upload" to upload videos</p>
                </div>
            `;
            return;
        }

        container.innerHTML = allUploads.map(upload => this.createUnifiedUploadElement(upload)).join('') +
            '<div style="height: 100px; flex-shrink: 0;"></div>';
    }

    createUnifiedUploadElement(upload) {
        const fileName = upload.filePath.split(/[\\/]/).pop();
        const account = this.accounts.find(a => a.id === upload.accountId);
        const accountName = account ? account.name : 'Unknown Account';

        // Determine status class and badge text
        let statusClass = upload.statusType || upload.status;
        let statusText = statusClass;
        if (statusClass === 'active') {
            statusClass = 'in-progress';
            statusText = 'Uploading';
        } else if (statusClass === 'queued') {
            statusText = 'Queued';
        } else if (upload.status === 'completed') {
            statusClass = 'completed';
            statusText = 'Completed';
        } else if (upload.status === 'failed') {
            statusClass = 'failed';
            statusText = 'Failed';
        }

        // Build the HTML
        let html = `
            <div class="upload-item ${statusClass}" data-upload-id="${upload.id}">
                <div class="upload-item-header">
                    <div class="upload-item-info">
                        <div class="upload-item-title">
                            ${fileName}
                            <span class="upload-status-badge ${statusClass}">${statusText}</span>
                            ${upload.metadataKey ? '<span class="metadata-tag">+JSON</span>' : ''}
                        </div>
                        <div class="upload-item-details">
                            <span>→ ${accountName}</span>
                            <span>• ${this.formatBytes(upload.totalBytes || 0)}</span>
                            ${upload.completedAt ? `<span>• ${this.getTimeAgo(upload.completedAt)}</span>` : ''}
                        </div>
                    </div>
                    <div class="upload-item-actions">`;

        // Add action buttons based on status
        if (statusClass === 'in-progress') {
            html += `
                <button class="btn btn-sm" onclick="window.uploadQueueController.pauseUpload('${upload.id}')">Pause</button>
                <button class="btn btn-sm btn-danger" onclick="window.uploadQueueController.cancelUpload('${upload.id}')">Cancel</button>`;
        } else if (statusClass === 'queued') {
            html += `
                <button class="btn btn-sm btn-danger" onclick="window.uploadQueueController.removeFromQueue('${upload.id}')">Remove</button>`;
        } else if (statusClass === 'failed') {
            html += `
                <button class="btn btn-sm" onclick="window.uploadQueueController.retryUpload('${upload.id}')">Retry</button>
                <button class="btn btn-sm" onclick="window.uploadQueueController.removeCompleted('${upload.id}')">Remove</button>`;
        } else if (statusClass === 'completed') {
            html += `
                <button class="btn btn-sm" onclick="window.uploadQueueController.removeCompleted('${upload.id}')">Remove</button>`;
        }

        html += `
                    </div>
                </div>`;

        // Add progress bar for active uploads
        if (statusClass === 'in-progress') {
            html += `
                <div class="upload-item-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${upload.progress || 0}%"></div>
                    </div>
                </div>
                <div class="upload-item-stats">
                    <span>${upload.progress || 0}% • ${this.formatBytes(upload.bytesUploaded || 0)} / ${this.formatBytes(upload.totalBytes || 0)}</span>
                    <span>↑ ${this.calculateSpeed(upload)} • ~${this.calculateETA(upload)} remaining</span>
                </div>`;
        }

        // Add result URL for completed uploads
        if (upload.status === 'completed' && upload.result) {
            // Get the appropriate URL based on provider type
            let uploadUrl = '';
            if (account?.type === 'youtube') {
                uploadUrl = upload.result.url || `https://youtube.com/watch?v=${upload.result.videoId}`;
            } else if (account?.type === 's3') {
                uploadUrl = upload.result.location || upload.result.key;
            } else if (account?.type === 'sc-player') {
                uploadUrl = upload.result.viewUrl || upload.result.publicUrl || upload.result.shareUrl;
            } else {
                uploadUrl = upload.result.url || upload.result.location || upload.result.key || 'Unknown';
            }

            html += `
                <div class="upload-result">
                    <div class="upload-url">
                        <code>${uploadUrl}</code>
                        <button class="btn btn-sm" onclick="window.uploadQueueController.copyUrl('${uploadUrl}')">Copy URL</button>
                        ${(account?.type === 's3' && uploadUrl?.startsWith('http')) || account?.type === 'youtube' || account?.type === 'sc-player' ?
                            `<button class="btn btn-sm" onclick="window.uploadQueueController.openUrl('${uploadUrl}')">Open</button>` : ''}
                    </div>
                </div>`;
        }

        // Add error message for failed uploads
        if (upload.status === 'failed' && upload.error) {
            html += `
                <div class="upload-error">
                    <span style="color: #ef4444;">Error: ${upload.error}</span>
                </div>`;
        }

        html += `</div>`;
        return html;
    }

    renderActiveUploads() {
        const container = document.getElementById('active-uploads-list');
        if (!container) return;

        if (this.uploads.active.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📤</div>
                    <p>No active uploads</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.uploads.active.map(upload => this.createActiveUploadElement(upload)).join('');
    }

    createActiveUploadElement(upload) {
        const fileName = upload.filePath.split(/[\\/]/).pop();
        const account = this.accounts.find(a => a.id === upload.accountId);
        const accountName = account ? account.name : 'Unknown Account';

        return `
            <div class="upload-item active" data-upload-id="${upload.id}">
                <div class="upload-item-header">
                    <div>
                        <div class="upload-item-title">📤 ${fileName}</div>
                        <div class="upload-item-status">
                            <span>→</span>
                            <span>${accountName}</span>
                        </div>
                    </div>
                    <div class="upload-item-actions">
                        <button class="btn btn-sm" onclick="window.uploadQueueController.pauseUpload('${upload.id}')">Pause</button>
                        <button class="btn btn-sm btn-danger" onclick="window.uploadQueueController.cancelUpload('${upload.id}')">Cancel</button>
                    </div>
                </div>
                <div class="upload-item-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${upload.progress}%"></div>
                    </div>
                </div>
                <div class="upload-item-stats">
                    <span>${upload.progress}% • ${this.formatBytes(upload.bytesUploaded)} / ${this.formatBytes(upload.totalBytes)}</span>
                    <span>↑ ${this.calculateSpeed(upload)} • ~${this.calculateETA(upload)} remaining</span>
                </div>
            </div>
        `;
    }

    renderQueuedUploads() {
        const container = document.getElementById('queued-uploads-list');
        if (!container) return;

        if (this.uploads.queued.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">⏳</div>
                    <p>No queued uploads</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.uploads.queued.map((upload, index) => this.createQueuedUploadElement(upload, index)).join('');
    }

    createQueuedUploadElement(upload, index) {
        const fileName = upload.filePath.split(/[\\/]/).pop();
        const account = this.accounts.find(a => a.id === upload.accountId);
        const accountName = account ? account.name : 'Unknown Account';

        return `
            <div class="upload-item" data-upload-id="${upload.id}">
                <div class="upload-item-header">
                    <div>
                        <div class="upload-item-title">⏳ ${fileName}</div>
                        <div class="upload-item-status">
                            <span>→</span>
                            <span>${accountName}</span>
                            <span>• ${this.formatBytes(upload.totalBytes)}</span>
                            <span>• Waiting...</span>
                        </div>
                    </div>
                    <div class="upload-item-actions">
                        ${index > 0 ? `<button class="btn btn-sm" onclick="window.uploadQueueController.moveUp('${upload.id}')">↑</button>` : ''}
                        ${index < this.uploads.queued.length - 1 ? `<button class="btn btn-sm" onclick="window.uploadQueueController.moveDown('${upload.id}')">↓</button>` : ''}
                        <button class="btn btn-sm btn-danger" onclick="window.uploadQueueController.removeFromQueue('${upload.id}')">Remove</button>
                    </div>
                </div>
            </div>
        `;
    }

    renderCompletedUploads() {
        const container = document.getElementById('completed-uploads-list');
        if (!container) return;

        if (this.uploads.completed.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">✅</div>
                    <p>No completed uploads</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.uploads.completed.map(upload => this.createCompletedUploadElement(upload)).join('');
    }

    createCompletedUploadElement(upload) {
        const fileName = upload.filePath.split(/[\\/]/).pop();
        const account = this.accounts.find(a => a.id === upload.accountId);
        const accountName = account ? account.name : 'Unknown Account';

        if (upload.status === 'completed') {
            return `
                <div class="upload-item completed" data-upload-id="${upload.id}">
                    <div class="upload-item-header">
                        <div>
                            <div class="upload-item-title">✅ ${fileName}</div>
                            <div class="upload-item-status">
                                <span>→</span>
                                <span>${accountName}</span>
                                <span>• ${this.getTimeAgo(upload.completedAt)}</span>
                            </div>
                        </div>
                    </div>
                    ${upload.result ? (() => {
                        // Get the appropriate URL based on provider type
                        let uploadUrl = '';
                        if (account?.type === 'youtube') {
                            uploadUrl = upload.result.url || `https://youtube.com/watch?v=${upload.result.videoId}`;
                        } else if (account?.type === 's3') {
                            uploadUrl = upload.result.location || upload.result.key;
                        } else {
                            uploadUrl = upload.result.url || upload.result.location || upload.result.key || 'Unknown';
                        }

                        return `
                        <div class="upload-result">
                            <div class="upload-url">
                                <code>${uploadUrl}</code>
                                <button class="btn btn-sm" onclick="window.uploadQueueController.copyUrl('${uploadUrl}')">Copy URL</button>
                                ${(account?.type === 's3' && uploadUrl?.startsWith('http')) || account?.type === 'youtube' ?
                                    `<button class="btn btn-sm" onclick="window.uploadQueueController.openUrl('${uploadUrl}')">Open</button>` : ''}
                            </div>
                        </div>`;
                    })() : ''
                    }
                </div>
            `;
        } else if (upload.status === 'failed') {
            return `
                <div class="upload-item failed" data-upload-id="${upload.id}">
                    <div class="upload-item-header">
                        <div>
                            <div class="upload-item-title">❌ ${fileName}</div>
                            <div class="upload-item-status">
                                <span>→</span>
                                <span>${accountName}</span>
                                <span>• Failed: ${upload.error}</span>
                            </div>
                        </div>
                        <div class="upload-item-actions">
                            <button class="btn btn-sm" onclick="window.uploadQueueController.retryUpload('${upload.id}')">Retry</button>
                            <button class="btn btn-sm" onclick="window.uploadQueueController.removeCompleted('${upload.id}')">Remove</button>
                        </div>
                    </div>
                </div>
            `;
        }
    }

    async startQueue() {
        if (!this.ipc) return;

        try {
            const result = await this.ipc.invoke('upload:start-queue');
            if (result && result.success) {
                this.queuePaused = false;
                this.updateQueueButtons({ queuePaused: false });
            }
        } catch (error) {
            console.error('Failed to start queue:', error);
        }
    }

    async pauseQueue() {
        if (!this.ipc) return;

        try {
            const result = await this.ipc.invoke('upload:pause-queue');
            if (result && result.success) {
                this.queuePaused = true;
                this.updateQueueButtons({ queuePaused: true });
            }
        } catch (error) {
            console.error('Failed to pause queue:', error);
        }
    }

    updateQueueButtons(status) {
        const startBtn = document.getElementById('start-queue-btn');
        const pauseBtn = document.getElementById('pause-queue-btn');

        if (!startBtn || !pauseBtn) return;

        this.queuePaused = status.queuePaused;

        if (status.queuePaused) {
            startBtn.style.display = 'inline-flex';
            pauseBtn.style.display = 'none';
        } else {
            startBtn.style.display = 'none';
            pauseBtn.style.display = 'inline-flex';
        }
    }

    applyFilter(filter) {
        this.currentFilter = filter;
        this.renderUploads();
    }

    async browseAndUpload() {
        // Use the shared video browser instead of file dialog
        if (this.videoBrowser) {
            try {
                await this.videoBrowser.show();
            } catch (error) {
                console.error('Error showing video browser:', error);
            }
        } else {
            console.error('Video browser not initialized');
        }
    }

    handleVideoSelected(video) {
        if (!video || !video.path) return;


        // Show upload dialog with the full video object (includes path and event info)
        if (this.uploadDialog) {
            this.uploadDialog.show(video, {
                onUploadQueued: (uploadId, accountName) => {
                    // Refresh the upload state
                    this.loadUploadState();
                }
            });
        } else {
            console.error('Upload dialog not initialized');
        }
    }

    async pauseAllUploads() {
        // TODO: Implement pause all functionality
    }

    async clearCompleted() {
        if (!this.ipc) {
            this.uploads.completed = [];
            this.renderUploads();
            return;
        }

        try {
            // Clear completed uploads in the backend
            await this.ipc.invoke('upload:clear-completed');
            // Update local state
            this.uploads.completed = [];
            this.renderUploads();
        } catch (error) {
            console.error('Failed to clear completed uploads:', error);
        }
    }

    async cancelUpload(uploadId) {
        if (!this.ipc) return;

        try {
            await this.ipc.invoke('upload:cancel-upload', { uploadId });
            await this.loadUploadState();
        } catch (error) {
            console.error('Failed to cancel upload:', error);
        }
    }

    async removeFromQueue(uploadId) {
        if (!this.ipc) {
            this.uploads.queued = this.uploads.queued.filter(u => u.id !== uploadId);
            this.renderUploads();
            return;
        }

        try {
            // Remove from backend queue
            const result = await this.ipc.invoke('upload:remove-from-queue', { uploadId });

            // Update local state immediately
            this.uploads.queued = this.uploads.queued.filter(u => u.id !== uploadId);
            this.renderUploads();
        } catch (error) {
            console.error('Failed to remove from queue:', error);
        }
    }

    async removeCompleted(uploadId) {
        if (!this.ipc) {
            this.uploads.completed = this.uploads.completed.filter(u => u.id !== uploadId);
            this.renderUploads();
            return;
        }

        try {
            // Remove from backend completed list
            const result = await this.ipc.invoke('upload:remove-completed', { uploadId });

            // Update local state immediately
            this.uploads.completed = this.uploads.completed.filter(u => u.id !== uploadId);
            this.renderUploads();
        } catch (error) {
            console.error('Failed to remove completed upload:', error);
        }
    }

    async retryUpload(uploadId) {
        // TODO: Implement retry functionality
    }

    async copyUrl(url) {
        if (!url) return;

        try {
            await navigator.clipboard.writeText(url);
            // Could show a toast notification here
        } catch (error) {
            console.error('Failed to copy URL:', error);
        }
    }

    async openUrl(url) {
        if (!url || !this.ipc) return;

        try {
            await this.ipc.invoke('open-url', url);
        } catch (error) {
            console.error('Failed to open URL:', error);
        }
    }

    openAccountsManager() {
        // Switch to the online accounts section
        const accountsTab = document.querySelector('[data-view="online-accounts"]');
        if (accountsTab) {
            accountsTab.click();
        }
    }

    updateUploadProgress(data) {
        const { uploadId, progress, bytesUploaded, totalBytes } = data;

        // Find and update the upload in active list
        const uploadIndex = this.uploads.active.findIndex(u => u.id === uploadId);
        if (uploadIndex !== -1) {
            this.uploads.active[uploadIndex].progress = progress;
            this.uploads.active[uploadIndex].bytesUploaded = bytesUploaded;
            if (totalBytes) {
                this.uploads.active[uploadIndex].totalBytes = totalBytes;
            }

            // Update progress bar
            const progressElement = document.querySelector(`[data-upload-id="${uploadId}"] .progress-fill`);
            if (progressElement) {
                progressElement.style.width = `${progress}%`;
            }

            // Update stats text
            const statsElement = document.querySelector(`[data-upload-id="${uploadId}"] .upload-item-stats`);
            if (statsElement) {
                const upload = this.uploads.active[uploadIndex];
                statsElement.innerHTML = `
                    <span>${progress || 0}% • ${this.formatBytes(bytesUploaded || 0)} / ${this.formatBytes(upload.totalBytes || 0)}</span>
                    <span>↑ ${this.calculateSpeed(upload)} • ~${this.calculateETA(upload)} remaining</span>
                `;
            }
        }
    }

    handleUploadStarted(upload) {
        // Move from queued to active
        this.uploads.queued = this.uploads.queued.filter(u => u.id !== upload.id);

        // Ensure upload has proper initial values
        upload.bytesUploaded = upload.bytesUploaded || 0;
        upload.progress = upload.progress || 0;

        // Add to active uploads
        this.uploads.active.push(upload);

        this.renderUploads();
    }

    handleUploadCompleted(upload) {
        // Move from active to completed
        this.uploads.active = this.uploads.active.filter(u => u.id !== upload.id);
        this.uploads.completed.unshift(upload);

        // Keep only last 50 completed
        if (this.uploads.completed.length > 50) {
            this.uploads.completed = this.uploads.completed.slice(0, 50);
        }

        this.renderUploads();
    }

    handleUploadFailed(upload) {
        // Move from active to completed (failed)
        this.uploads.active = this.uploads.active.filter(u => u.id !== upload.id);
        this.uploads.completed.unshift(upload);

        this.renderUploads();
    }

    // Utility functions
    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
    }

    calculateSpeed(upload) {
        if (!upload.startedAt || !upload.bytesUploaded || upload.bytesUploaded === 0) {
            return '0 B/s';
        }

        const elapsedSeconds = (Date.now() - upload.startedAt) / 1000;
        if (elapsedSeconds < 1) return 'calculating...';

        const bytesPerSecond = upload.bytesUploaded / elapsedSeconds;
        return this.formatBytes(bytesPerSecond) + '/s';
    }

    calculateETA(upload) {
        if (!upload.progress || upload.progress === 0 || !upload.startedAt || !upload.bytesUploaded) {
            return 'calculating...';
        }

        const elapsedSeconds = (Date.now() - upload.startedAt) / 1000;
        if (elapsedSeconds < 2) return 'calculating...';

        const bytesPerSecond = upload.bytesUploaded / elapsedSeconds;
        if (bytesPerSecond === 0) return 'calculating...';

        const remaining = upload.totalBytes - upload.bytesUploaded;
        const secondsRemaining = remaining / bytesPerSecond;

        if (secondsRemaining < 60) {
            return `${Math.round(secondsRemaining)}s`;
        } else if (secondsRemaining < 3600) {
            return `${Math.round(secondsRemaining / 60)}m`;
        } else {
            return `${Math.round(secondsRemaining / 3600)}h`;
        }
    }

    getTimeAgo(timestamp) {
        if (!timestamp) return '';

        const seconds = Math.floor((Date.now() - timestamp) / 1000);

        if (seconds < 60) return 'just now';
        if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
        return `${Math.floor(seconds / 86400)} days ago`;
    }
}

// Export to window for browser use
if (typeof window !== 'undefined') {
    window.UploadQueueController = UploadQueueController;
}

// Export for Node.js/CommonJS use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UploadQueueController;
}