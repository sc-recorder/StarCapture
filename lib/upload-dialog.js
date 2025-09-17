/**
 * Upload Dialog Component
 * Universal dialog for configuring and queuing video uploads
 */
class UploadDialog {
    constructor() {
        this.dialog = null;
        this.currentFile = null;
        this.currentVideo = null;
        this.accounts = [];
        this.queuedUploads = [];
        this.onUploadQueued = null;

        // Get ipcRenderer from global scope
        this.ipc = window.ipcRenderer || (typeof ipcRenderer !== 'undefined' ? ipcRenderer : null);

        this.createDialog();
        this.setupEventListeners();
    }

    createDialog() {
        // Check if modal already exists
        if (document.getElementById('upload-dialog-modal')) {
            console.log('[UploadDialog] Modal already exists, reusing it');
            this.dialog = document.getElementById('upload-dialog-modal');
            return;
        }

        // Create dialog HTML
        const dialogHtml = `
            <div id="upload-dialog-modal" class="modal" style="display: none;">
                <div class="modal-content upload-dialog">
                    <div class="modal-header">
                        <h2>Upload Video</h2>
                        <button class="close-btn" id="close-upload-dialog">&times;</button>
                    </div>

                    <div class="modal-body">
                        <!-- Error Message Display -->
                        <div id="upload-error-message" style="display: none; color: #ff4444; background: rgba(255,68,68,0.1); padding: 10px; border-radius: 4px; margin-bottom: 15px;"></div>

                        <!-- File Info -->
                        <div class="file-info-section">
                            <div class="file-info">
                                <span class="label">File:</span>
                                <span id="upload-file-name">No file selected</span>
                            </div>
                            <div class="file-info">
                                <span class="label">Size:</span>
                                <span id="upload-file-size">-</span>
                                <span class="separator">|</span>
                                <span class="label">Duration:</span>
                                <span id="upload-file-duration">-</span>
                            </div>
                        </div>

                        <!-- Account Selection -->
                        <div class="form-group">
                            <label for="upload-account-select">Upload to:</label>
                            <select id="upload-account-select" class="form-control">
                                <option value="">Select Account...</option>
                            </select>
                        </div>

                        <!-- Platform-specific form -->
                        <div id="upload-platform-form" style="display: none;">
                            <hr class="divider">

                            <!-- S3 Options -->
                            <div id="s3-upload-options" class="platform-options" style="display: none;">
                                <h3>S3 Upload Options</h3>

                                <div class="form-group">
                                    <label>
                                        <input type="checkbox" id="s3-preserve-filename" checked>
                                        Preserve original filename (no timestamp prefix)
                                    </label>
                                </div>

                                <div class="form-group">
                                    <label>
                                        <input type="checkbox" id="s3-include-metadata" checked>
                                        Include event metadata (.json)
                                    </label>
                                </div>

                                <div class="form-group">
                                    <label>
                                        <input type="checkbox" id="s3-delete-after-upload">
                                        Delete local file after upload
                                    </label>
                                </div>

                                <div class="form-group">
                                    <label>
                                        <input type="checkbox" id="s3-make-public">
                                        Make publicly accessible
                                    </label>
                                </div>

                                <div class="upload-path-preview">
                                    <span class="label">File will be uploaded to:</span>
                                    <code id="s3-upload-path">-</code>
                                </div>
                            </div>

                            <!-- YouTube Options -->
                            <div id="youtube-upload-options" class="platform-options" style="display: none;">
                                <h3>YouTube Upload Options</h3>

                                <div class="form-group">
                                    <label for="youtube-upload-title">Title</label>
                                    <input type="text" id="youtube-upload-title" class="form-control" placeholder="Video title" maxlength="100">
                                </div>

                                <div class="form-group">
                                    <label for="youtube-upload-description">Description</label>
                                    <textarea id="youtube-upload-description" class="form-control" rows="4" placeholder="Video description" maxlength="5000"></textarea>
                                </div>

                                <div class="form-group">
                                    <label for="youtube-upload-tags">Tags</label>
                                    <input type="text" id="youtube-upload-tags" class="form-control" placeholder="tag1, tag2, tag3 (comma separated)">
                                </div>

                                <div class="form-group">
                                    <label for="youtube-upload-privacy">Privacy</label>
                                    <select id="youtube-upload-privacy" class="form-control">
                                        <option value="private">Private</option>
                                        <option value="unlisted">Unlisted</option>
                                        <option value="public">Public</option>
                                    </select>
                                </div>

                                <div class="form-group">
                                    <label for="youtube-upload-category">Category</label>
                                    <select id="youtube-upload-category" class="form-control">
                                        <option value="20">Gaming</option>
                                        <option value="24">Entertainment</option>
                                        <option value="22">People & Blogs</option>
                                        <option value="28">Science & Technology</option>
                                    </select>
                                </div>

                                <div class="form-group">
                                    <label for="youtube-upload-playlist">Add to Playlist (Optional)</label>
                                    <input type="text" id="youtube-upload-playlist" class="form-control" placeholder="Playlist ID (optional)">
                                </div>

                                <!-- Auto-generate Chapters -->
                                <div class="form-group" style="border-top: 1px solid #333; padding-top: 15px; margin-top: 15px;">
                                    <label style="display: flex; align-items: center; gap: 10px;">
                                        <input type="checkbox" id="youtube-auto-chapters">
                                        <span>Auto-generate chapters from events</span>
                                    </label>
                                    <small class="form-text text-muted">Creates YouTube chapter markers from recorded events</small>

                                    <div id="youtube-chapters-options" style="display: none; margin-top: 10px; padding-left: 25px;">
                                        <label for="youtube-chapters-placement" style="font-size: 12px;">Chapter placement:</label>
                                        <select id="youtube-chapters-placement" class="form-control" style="max-width: 200px;">
                                            <option value="before">Before description</option>
                                            <option value="after">After description</option>
                                        </select>
                                    </div>
                                </div>
                            </div>

                            <!-- Twitch removed - doesn't support direct uploads via API -->
                        </div>

                        <!-- Already Queued Info -->
                        <div id="upload-queue-info" style="display: none;">
                            <div class="info-box">
                                <strong>Already queued for:</strong>
                                <ul id="queued-accounts-list"></ul>
                            </div>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button id="cancel-upload-btn" class="btn btn-secondary">Cancel</button>
                        <button id="queue-another-btn" class="btn btn-secondary" style="display: none;">Queue & Add Another</button>
                        <button id="queue-upload-btn" class="btn btn-primary">Queue Upload</button>
                        <button id="upload-now-btn" class="btn btn-success">Upload Now</button>
                    </div>
                </div>
            </div>
        `;

        // Add dialog to DOM
        const dialogContainer = document.createElement('div');
        dialogContainer.innerHTML = dialogHtml;
        document.body.appendChild(dialogContainer.firstElementChild);

        this.dialog = document.getElementById('upload-dialog-modal');
    }

    setupEventListeners() {
        // Close button
        document.getElementById('close-upload-dialog').addEventListener('click', () => this.close());

        // Cancel button
        document.getElementById('cancel-upload-btn').addEventListener('click', () => this.close());

        // Account selection
        document.getElementById('upload-account-select').addEventListener('change', (e) => {
            this.onAccountSelected(e.target.value);
        });

        // Upload buttons
        document.getElementById('queue-upload-btn').addEventListener('click', () => this.queueUpload(false));
        document.getElementById('upload-now-btn').addEventListener('click', () => this.queueUpload(true));
        document.getElementById('queue-another-btn').addEventListener('click', () => this.queueAnother());

        // YouTube auto-chapters checkbox
        document.getElementById('youtube-auto-chapters').addEventListener('change', (e) => {
            const optionsDiv = document.getElementById('youtube-chapters-options');
            optionsDiv.style.display = e.target.checked ? 'block' : 'none';
        });

        // Click outside to close
        this.dialog.addEventListener('click', (e) => {
            if (e.target === this.dialog) {
                this.close();
            }
        });
    }

    async show(filePathOrVideo, options = {}) {
        console.log('[UploadDialog] Show called with:', filePathOrVideo, 'options:', options);

        // Reset state before setting new values
        this.currentFile = null;
        this.currentVideo = null;
        this.queuedUploads = [];

        // Handle both file path string and video object from browser
        if (typeof filePathOrVideo === 'string') {
            // Direct file path (backwards compatibility)
            this.currentFile = filePathOrVideo;
            this.currentVideo = null;
            console.log('[UploadDialog] Set currentFile from string:', this.currentFile);
        } else if (filePathOrVideo && filePathOrVideo.path) {
            // Video object from shared video browser or post controller
            this.currentVideo = filePathOrVideo;
            this.currentFile = filePathOrVideo.path;
            console.log('[UploadDialog] Set currentFile from video object:', this.currentFile);
        } else {
            console.error('[UploadDialog] Invalid input - no file path found:', filePathOrVideo);
            this.showError('Error: No file selected');
            return;
        }

        this.onUploadQueued = options.onUploadQueued || null;

        // Load accounts
        await this.loadAccounts();

        // Display file info
        await this.displayFileInfo(this.currentFile);

        // Reset form
        this.resetForm();

        // Show dialog
        this.dialog.style.display = 'flex';
    }

    close() {
        this.dialog.style.display = 'none';
        // Clear all state when closing
        this.currentFile = null;
        this.currentVideo = null;
        this.queuedUploads = [];
        // Clear any error messages
        this.clearError();
        // Reset the form for next use
        this.resetForm();
    }

    /**
     * Show error message in the dialog
     */
    showError(message) {
        const errorEl = document.getElementById('upload-error-message');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.style.display = 'block';

            // Auto-clear after 5 seconds
            setTimeout(() => this.clearError(), 5000);
        }
    }

    /**
     * Clear error message
     */
    clearError() {
        const errorEl = document.getElementById('upload-error-message');
        if (errorEl) {
            errorEl.style.display = 'none';
            errorEl.textContent = '';
        }
    }

    async loadAccounts() {
        if (!this.ipc) {
            console.error('IPC not available');
            return;
        }

        try {
            const result = await this.ipc.invoke('upload:list-accounts');
            // Handle both array and object response
            let allAccounts = Array.isArray(result) ? result : (result?.accounts || []);

            // Filter out Twitch accounts since they don't support uploads
            this.accounts = allAccounts.filter(account => account.type !== 'twitch');

            // Populate account dropdown
            const select = document.getElementById('upload-account-select');
            select.innerHTML = '<option value="">Select Account...</option>';

            if (!this.accounts || this.accounts.length === 0) {
                select.innerHTML += '<option value="_add_new">+ Add New Account</option>';
            } else {
                this.accounts.forEach(account => {
                    const option = document.createElement('option');
                    option.value = account.id;
                    option.textContent = `${account.name} (${account.type})`;
                    select.appendChild(option);
                });
                select.innerHTML += '<option value="_add_new">+ Add New Account</option>';
            }
        } catch (error) {
            console.error('Failed to load accounts:', error);
            this.accounts = [];
        }
    }

    async displayFileInfo(filePath) {
        const fileName = filePath.split(/[\\/]/).pop();
        document.getElementById('upload-file-name').textContent = fileName;

        // Get file size
        try {
            const fs = require('fs');
            const stats = fs.statSync(filePath);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
            document.getElementById('upload-file-size').textContent = `${sizeMB} MB`;
        } catch (error) {
            document.getElementById('upload-file-size').textContent = '-';
        }

        // TODO: Get video duration if possible
        document.getElementById('upload-file-duration').textContent = '-';
    }

    resetForm() {
        document.getElementById('upload-account-select').value = '';
        document.getElementById('upload-platform-form').style.display = 'none';
        document.getElementById('upload-queue-info').style.display = 'none';
        document.getElementById('queue-another-btn').style.display = 'none';

        // Reset platform forms
        document.querySelectorAll('.platform-options').forEach(el => {
            el.style.display = 'none';
        });

        // Reset YouTube fields
        document.getElementById('youtube-upload-title').value = '';
        document.getElementById('youtube-upload-description').value = '';
        document.getElementById('youtube-upload-tags').value = '';
        document.getElementById('youtube-upload-privacy').value = 'private';
        document.getElementById('youtube-upload-category').value = '20';
        document.getElementById('youtube-upload-playlist').value = '';
        document.getElementById('youtube-auto-chapters').checked = false;
        document.getElementById('youtube-chapters-placement').value = 'before';
        document.getElementById('youtube-chapters-options').style.display = 'none';

        // Reset S3 fields
        document.getElementById('s3-preserve-filename').checked = true;
        document.getElementById('s3-include-metadata').checked = true;
        document.getElementById('s3-delete-after-upload').checked = false;
        document.getElementById('s3-make-public').checked = false;
    }

    onAccountSelected(accountId) {
        if (!accountId) {
            document.getElementById('upload-platform-form').style.display = 'none';
            return;
        }

        if (accountId === '_add_new') {
            // Switch to Online Accounts settings
            this.close();
            // Find and click the online accounts navigation button
            const accountsBtn = document.querySelector('[data-subview="online-accounts"]');
            if (accountsBtn) {
                accountsBtn.click();
                // After a small delay, trigger the add account dialog
                setTimeout(() => {
                    const addBtn = document.getElementById('add-account-btn');
                    if (addBtn) {
                        addBtn.click();
                    }
                }, 100);
            }
            return;
        }

        // Find selected account
        const account = this.accounts.find(a => a.id === accountId);
        if (!account) return;

        // Show platform-specific form
        document.getElementById('upload-platform-form').style.display = 'block';

        // Hide all platform options first
        document.querySelectorAll('.platform-options').forEach(el => {
            el.style.display = 'none';
        });

        // Show relevant platform options
        if (account.type === 's3') {
            document.getElementById('s3-upload-options').style.display = 'block';
            this.updateS3UploadPath(account);

            // Add listener for preserve filename checkbox
            const preserveCheckbox = document.getElementById('s3-preserve-filename');
            if (preserveCheckbox) {
                // Remove any existing listener
                preserveCheckbox.onchange = null;
                // Add new listener
                preserveCheckbox.onchange = () => this.updateS3UploadPath(account);
            }
        } else if (account.type === 'youtube') {
            document.getElementById('youtube-upload-options').style.display = 'block';
        }
        // Twitch accounts filtered out in loadAccounts, but kept for future streaming features
    }

    updateS3UploadPath(account) {
        const fileName = this.currentFile.split(/[\\/]/).pop();
        const preserveFilename = document.getElementById('s3-preserve-filename')?.checked;

        const prefix = account.config?.prefix || '';

        let displayPath;
        if (preserveFilename) {
            // Show path without timestamp
            displayPath = prefix ? `${prefix}/${fileName}` : fileName;
        } else {
            // Show path with timestamp placeholder
            displayPath = prefix ? `${prefix}/[timestamp]_${fileName}` : `[timestamp]_${fileName}`;
        }

        document.getElementById('s3-upload-path').textContent = displayPath;
    }

    async queueUpload(immediate = false) {
        // Validate we have a file to upload
        if (!this.currentFile) {
            console.error('[UploadDialog] No file selected for upload - currentFile is null');
            this.showError('No file selected. Please close the dialog and try again.');
            return;
        }

        const accountId = document.getElementById('upload-account-select').value;
        if (!accountId || accountId === '_add_new') {
            this.showError('Please select an account');
            return;
        }

        const account = this.accounts.find(a => a.id === accountId);
        if (!account) return;

        // Gather upload options
        const options = {
            priority: immediate ? 'immediate' : 'queued',
            options: {}
        };

        // S3-specific options
        if (account.type === 's3') {
            options.options.preserveFilename = document.getElementById('s3-preserve-filename').checked;
            options.options.includeMetadata = document.getElementById('s3-include-metadata').checked;
            options.options.deleteAfterUpload = document.getElementById('s3-delete-after-upload').checked;
            options.options.makePublic = document.getElementById('s3-make-public').checked;
        }

        // YouTube-specific options
        if (account.type === 'youtube') {
            options.options.title = document.getElementById('youtube-upload-title').value ||
                this.currentFile.split(/[\\/]/).pop().replace(/\.[^/.]+$/, ''); // Use filename without extension as default

            let description = document.getElementById('youtube-upload-description').value || '';

            // Check if auto-chapters is enabled
            const autoChapters = document.getElementById('youtube-auto-chapters').checked;
            if (autoChapters) {
                const chaptersText = await this.generateChapters();
                if (chaptersText) {
                    const placement = document.getElementById('youtube-chapters-placement').value;
                    if (placement === 'before') {
                        description = chaptersText + (description ? '\n\n' + description : '');
                    } else {
                        description = (description ? description + '\n\n' : '') + chaptersText;
                    }
                }
            }

            options.options.description = description;

            const tagsValue = document.getElementById('youtube-upload-tags').value || '';
            options.options.tags = tagsValue ? tagsValue.split(',').map(t => t.trim()).filter(t => t) : ['Star Citizen'];

            options.options.privacy = document.getElementById('youtube-upload-privacy').value || 'private';
            options.options.categoryId = document.getElementById('youtube-upload-category').value || '20';
            options.options.playlist = document.getElementById('youtube-upload-playlist').value || undefined;
        }

        // Twitch removed - accounts still saved for future streaming features

        // Queue the upload
        try {
            const result = await this.ipc.invoke('upload:upload-file', {
                accountId: accountId,
                filePath: this.currentFile,
                metadata: options.options
            });

            if (result.success) {
                this.queuedUploads.push({
                    accountId: accountId,
                    accountName: account.name,
                    uploadId: result.uploadId
                });

                // Notify parent
                if (this.onUploadQueued) {
                    this.onUploadQueued(result.uploadId, account.name);
                }

                // Show success message
                this.showUploadQueued(account.name);

                // Close dialog
                this.close();
            } else {
                this.showError('Failed to queue upload: ' + (result.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showError('Failed to queue upload: ' + error.message);
        }
    }

    queueAnother() {
        // Update UI to show already queued
        const queueInfo = document.getElementById('upload-queue-info');
        const queueList = document.getElementById('queued-accounts-list');

        queueInfo.style.display = 'block';
        queueList.innerHTML = this.queuedUploads.map(u =>
            `<li>${u.accountName} (queued)</li>`
        ).join('');

        // Reset account selection
        document.getElementById('upload-account-select').value = '';
        document.getElementById('upload-platform-form').style.display = 'none';

        // Show queue another button
        document.getElementById('queue-another-btn').style.display = 'inline-block';
    }

    showUploadQueued(accountName) {
        // Could show a toast notification here
        console.log(`Upload queued to ${accountName}`);
    }

    /**
     * Generate YouTube chapters from events JSON file
     * @returns {Promise<string|null>} - Chapter text or null if no events
     */
    async generateChapters() {
        try {
            let eventsData = null;

            // Check if we have a video object with event info
            if (this.currentVideo && this.currentVideo.hasEvents) {
                // Load events from JSON file that shares the video's name
                const eventsPath = this.currentFile.replace(/\.[^/.]+$/, '.json');

                // Read the events file directly using Node.js fs module
                try {
                    const fs = require('fs');
                    const eventsContent = fs.readFileSync(eventsPath, 'utf8');
                    eventsData = JSON.parse(eventsContent);
                    console.log('Loaded events from:', eventsPath);
                } catch (error) {
                    console.error('Error reading events file:', error);
                    return null;
                }
            } else {
                console.log('No events available for chapter generation');
                return null;
            }

            if (!eventsData || !eventsData.events || eventsData.events.length === 0) {
                console.log('No events found for chapter generation');
                return null;
            }

            // Sort events by timestamp
            const sortedEvents = [...eventsData.events].sort((a, b) => {
                const timeA = a.videoOffset || 0;
                const timeB = b.videoOffset || 0;
                return timeA - timeB;
            });

            // Build chapter list
            const chapters = [];

            // YouTube requires first chapter to start at 00:00
            chapters.push('00:00 Start');

            // Add significant events as chapters
            const significantEvents = sortedEvents.filter(event => {
                // Filter for important events (you can customize this logic)
                const importantTypes = ['combat', 'location_change', 'quantum_jump', 'landing', 'takeoff'];
                return importantTypes.includes(event.type) || event.severity === 'high';
            });

            // Limit to reasonable number of chapters (YouTube allows up to 100)
            const maxChapters = 50;
            const chapterEvents = significantEvents.slice(0, maxChapters - 1);

            for (const event of chapterEvents) {
                const time = this.formatTimestamp(event.videoOffset || 0);
                let label = event.name || event.type || 'Event';

                // Clean up label for chapter
                label = label.replace(/_/g, ' ');
                label = label.charAt(0).toUpperCase() + label.slice(1);

                // Limit label length
                if (label.length > 60) {
                    label = label.substring(0, 57) + '...';
                }

                chapters.push(`${time} ${label}`);
            }

            // If we have chapters, return formatted text
            if (chapters.length > 1) {
                return 'Chapters:\n' + chapters.join('\n');
            }

            return null;
        } catch (error) {
            console.error('Error generating chapters:', error);
            return null;
        }
    }

    /**
     * Format seconds to YouTube timestamp (MM:SS or HH:MM:SS)
     * @param {number} seconds - Time in seconds
     * @returns {string} - Formatted timestamp
     */
    formatTimestamp(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) {
            return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    }
}

// Create singleton instance
let uploadDialogInstance = null;

// Export to window for browser use
if (typeof window !== 'undefined') {
    // Use a getter to ensure singleton
    window.getUploadDialog = function() {
        if (!uploadDialogInstance) {
            uploadDialogInstance = new UploadDialog();
        }
        return uploadDialogInstance;
    };
    // Keep backwards compatibility
    window.UploadDialog = UploadDialog;
}

// Export for Node.js/CommonJS use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UploadDialog;
}