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
                                        <input type="checkbox" id="s3-include-thumbnails" checked>
                                        Include thumbnails
                                    </label>
                                    <div id="s3-thumbnail-status" style="margin-left: 24px; font-size: 12px; color: var(--text-secondary);"></div>
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

                                <hr class="divider" style="margin: 15px 0;">

                                <h4 style="margin-bottom: 10px;">Folder Structure</h4>

                                <div class="form-group">
                                    <label for="s3-base-folder">Base folder (optional):</label>
                                    <input type="text" id="s3-base-folder" class="form-control" placeholder="e.g., videos/ or content/recordings/">
                                </div>

                                <div class="form-group">
                                    <label>
                                        <input type="checkbox" id="s3-individual-folders" checked>
                                        Create individual folder for this video
                                    </label>
                                    <div style="margin-left: 24px; font-size: 12px; color: var(--text-secondary);">
                                        Each video gets its own folder containing all assets
                                    </div>
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
                                    <div id="youtube-thumbnail-status" style="padding: 10px; background: var(--card-bg); border-radius: 4px; margin-bottom: 10px; display: none;">
                                        <span style="color: var(--accent);">✓ Main thumbnail detected - will attempt to upload</span>
                                        <div style="font-size: 12px; margin-top: 5px; color: var(--text-secondary);">
                                            Note: Requires verified YouTube account with custom thumbnail permissions
                                        </div>
                                    </div>
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

                            <!-- SC Player Options -->
                            <div id="sc-player-upload-options" class="platform-options" style="display: none;">
                                <h3>StarCapture Player Upload</h3>

                                <!-- Tab Navigation -->
                                <div class="sc-player-tabs" style="display: flex; border-bottom: 1px solid #333; margin-bottom: 15px;">
                                    <button type="button" class="sc-player-tab-btn active" data-tab="direct" style="flex: 1; padding: 10px; background: var(--card-bg); border: none; color: var(--text); cursor: pointer; border-bottom: 2px solid var(--accent);">
                                        Direct Upload
                                    </button>
                                    <button type="button" class="sc-player-tab-btn" data-tab="s3-index" style="flex: 1; padding: 10px; background: var(--bg); border: none; color: var(--text-secondary); cursor: pointer; border-bottom: 2px solid transparent;">
                                        Upload via S3
                                    </button>
                                </div>

                                <!-- Common fields (shown in both tabs) -->
                                <div class="sc-player-common-fields">
                                    <div class="form-group">
                                        <label for="sc-player-upload-title">Title</label>
                                        <input type="text" id="sc-player-upload-title" class="form-control" placeholder="Video title" maxlength="100">
                                    </div>

                                    <div class="form-group">
                                        <label for="sc-player-upload-description">Description</label>
                                        <textarea id="sc-player-upload-description" class="form-control" rows="3" placeholder="Video description" maxlength="1000"></textarea>
                                    </div>

                                    <div class="form-group">
                                        <label for="sc-player-character-select">Character <span style="color: var(--accent);">*</span></label>
                                        <select id="sc-player-character-select" class="form-control" required>
                                            <option value="">Select Character...</option>
                                        </select>
                                    </div>

                                    <div class="form-group">
                                        <label for="sc-player-org-select">Organization (optional)</label>
                                        <select id="sc-player-org-select" class="form-control">
                                            <option value="">No Organization</option>
                                        </select>
                                    </div>

                                    <div class="form-group">
                                        <label for="sc-player-privacy">Privacy</label>
                                        <select id="sc-player-privacy" class="form-control">
                                            <option value="public">Public</option>
                                            <option value="unlisted">Unlisted</option>
                                            <option value="private">Private</option>
                                        </select>
                                    </div>

                                    <div class="form-group">
                                        <label>
                                            <input type="checkbox" id="sc-player-include-metadata" checked disabled>
                                            Include event metadata <span style="color: var(--accent);">*</span>
                                        </label>
                                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 5px;">
                                            Required for SC Player indexing - metadata file must be uploaded
                                        </div>
                                    </div>

                                    <div class="form-group" id="sc-player-thumbnails-group">
                                        <label>
                                            <input type="checkbox" id="sc-player-include-thumbnails" checked>
                                            Include thumbnails <span id="sc-player-thumbnails-required" style="color: var(--accent); display: none;">*</span>
                                        </label>
                                        <div id="sc-player-thumbnails-help" style="font-size: 12px; color: var(--text-secondary); margin-top: 5px; display: none;">
                                            Required when thumbnails exist - needed for proper SC Player indexing
                                        </div>
                                    </div>
                                </div>

                                <!-- Direct Upload Tab Content -->
                                <div id="sc-player-direct-tab" class="sc-player-tab-content">
                                    <div class="upload-method-info" style="padding: 10px; background: var(--card-bg); border-radius: 4px; font-size: 12px; color: var(--text-secondary);">
                                        <span id="sc-player-direct-method-text"></span>
                                    </div>

                                    <!-- Direct Upload Requirements Status -->
                                    <div id="sc-player-direct-upload-status" class="upload-requirements-status">
                                        <!-- Dynamically populated based on file validation -->
                                    </div>
                                </div>

                                <!-- S3 + Index Tab Content -->
                                <div id="sc-player-s3-tab" class="sc-player-tab-content" style="display: none;">
                                    <div class="form-group">
                                        <label for="sc-player-s3-account">S3 Account for Upload</label>
                                        <select id="sc-player-s3-account" class="form-control">
                                            <option value="">Select S3 Account...</option>
                                        </select>
                                        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 5px;">
                                            Video will be uploaded to S3 first, then automatically indexed in StarCapture Player
                                        </div>
                                    </div>

                                    <div class="upload-method-info" style="padding: 10px; background: var(--card-bg); border-radius: 4px; font-size: 12px; color: var(--text-secondary); margin-top: 10px;">
                                        <strong>Upload Flow:</strong><br>
                                        1. Upload video and assets to your S3 bucket<br>
                                        2. Automatically index the uploaded content in StarCapture Player<br>
                                        3. Video becomes available on your SC Player profile
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

        // S3 folder structure listeners
        const updateS3PathPreview = () => this.updateS3PathPreview();
        document.getElementById('s3-base-folder')?.addEventListener('input', updateS3PathPreview);
        document.getElementById('s3-individual-folders')?.addEventListener('change', updateS3PathPreview);
        document.getElementById('s3-preserve-filename')?.addEventListener('change', updateS3PathPreview);

        // SC Player tab switching
        document.addEventListener('click', (e) => {
            if (e.target.matches('.sc-player-tab-btn')) {
                this.switchSCPlayerTab(e.target.dataset.tab);
            }
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

        // Check for thumbnails
        this.checkForThumbnails(filePath);
    }

    checkForThumbnails(videoPath) {
        try {
            const fs = require('fs');
            const path = require('path');

            // Parse video path to check for thumbnail folder
            const parsed = path.parse(videoPath);
            const thumbnailFolder = path.join(parsed.dir, `${parsed.name}_thumbs`);
            const mainThumbnail = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

            let thumbnailStatus = '';
            let thumbnailCount = 0;

            // Check if thumbnail folder exists
            if (fs.existsSync(thumbnailFolder)) {
                const thumbFiles = fs.readdirSync(thumbnailFolder).filter(f => f.endsWith('.jpg'));
                thumbnailCount = thumbFiles.length;
                if (thumbnailCount > 0) {
                    thumbnailStatus = `${thumbnailCount} thumbnail${thumbnailCount !== 1 ? 's' : ''} found`;
                }
            }

            // Check for main thumbnail
            if (fs.existsSync(mainThumbnail)) {
                if (thumbnailStatus) {
                    thumbnailStatus += ' + main thumbnail';
                } else {
                    thumbnailStatus = 'Main thumbnail found';
                }
            }

            if (!thumbnailStatus) {
                thumbnailStatus = 'No thumbnails found';
            }

            // Update the status display
            const statusEl = document.getElementById('s3-thumbnail-status');
            if (statusEl) {
                statusEl.textContent = thumbnailStatus;
                statusEl.style.color = thumbnailCount > 0 ? 'var(--accent)' : 'var(--text-secondary)';
            }

            // Enable/disable checkbox based on thumbnail availability
            const checkbox = document.getElementById('s3-include-thumbnails');
            if (checkbox) {
                checkbox.disabled = thumbnailCount === 0;
                checkbox.checked = thumbnailCount > 0;
            }
        } catch (error) {
            console.error('Error checking for thumbnails:', error);
            const statusEl = document.getElementById('s3-thumbnail-status');
            if (statusEl) {
                statusEl.textContent = 'Unable to check for thumbnails';
            }
        }
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
        document.getElementById('s3-include-thumbnails').checked = true;
        document.getElementById('s3-delete-after-upload').checked = false;
        document.getElementById('s3-make-public').checked = false;
        document.getElementById('s3-base-folder').value = '';
        document.getElementById('s3-individual-folders').checked = true;
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

            // Check for main thumbnail for YouTube
            try {
                const fs = require('fs');
                const path = require('path');
                const parsed = path.parse(this.currentFile);
                const mainThumbnailPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

                const thumbnailStatus = document.getElementById('youtube-thumbnail-status');
                if (thumbnailStatus) {
                    if (fs.existsSync(mainThumbnailPath)) {
                        thumbnailStatus.style.display = 'block';
                    } else {
                        thumbnailStatus.style.display = 'none';
                    }
                }
            } catch (error) {
                console.error('Error checking for YouTube thumbnail:', error);
            }
        } else if (account.type === 'sc-player') {
            document.getElementById('sc-player-upload-options').style.display = 'block';

            // Load characters and organizations for this account
            this.loadSCPlayerContexts(account);

            // Update tab states based on account capabilities
            this.updateSCPlayerTabs(account);

            // Load S3 accounts for S3+Index tab
            this.loadS3AccountsForSCPlayer();

            // Check if thumbnails exist and make them required
            this.checkSCPlayerThumbnailRequirements();
        }
        // Twitch accounts filtered out in loadAccounts, but kept for future streaming features
    }

    updateS3UploadPath(account) {
        const fileName = this.currentFile.split(/[\\/]/).pop();
        const preserveFilename = document.getElementById('s3-preserve-filename')?.checked;
        const baseFolder = document.getElementById('s3-base-folder')?.value.trim() || '';
        const useIndividualFolders = document.getElementById('s3-individual-folders')?.checked;

        // Get the base filename (without extension)
        const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');

        let displayPath = '';

        // Add base folder if specified
        if (baseFolder) {
            displayPath = baseFolder.replace(/\/$/, ''); // Remove trailing slash
        }

        // Add individual video folder if enabled
        if (useIndividualFolders) {
            const folderName = preserveFilename ? nameWithoutExt : `[timestamp]_${nameWithoutExt}`;
            displayPath = displayPath ? `${displayPath}/${folderName}` : folderName;
        }

        // Add the actual filename
        const actualFileName = preserveFilename ? fileName : `[timestamp]_${fileName}`;
        displayPath = displayPath ? `${displayPath}/${actualFileName}` : actualFileName;

        document.getElementById('s3-upload-path').textContent = displayPath;
    }

    updateS3PathPreview() {
        // Update the path preview when any related field changes
        const accountId = document.getElementById('upload-account-select').value;
        if (accountId && accountId !== '_add_new') {
            const account = this.accounts.find(a => a.id === accountId);
            if (account && account.type === 's3') {
                this.updateS3UploadPath(account);
            }
        }
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
            options.options.includeThumbnails = document.getElementById('s3-include-thumbnails').checked;
            options.options.deleteAfterUpload = document.getElementById('s3-delete-after-upload').checked;
            options.options.makePublic = document.getElementById('s3-make-public').checked;
            options.options.baseFolder = document.getElementById('s3-base-folder').value.trim();
            options.options.useIndividualFolders = document.getElementById('s3-individual-folders').checked;
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

            // Check for main thumbnail
            try {
                const fs = require('fs');
                const path = require('path');
                const parsed = path.parse(this.currentFile);
                const mainThumbnailPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

                if (fs.existsSync(mainThumbnailPath)) {
                    options.options.thumbnailPath = mainThumbnailPath;
                    console.log('[UploadDialog] Found main thumbnail for YouTube upload:', mainThumbnailPath);
                }
            } catch (error) {
                console.error('[UploadDialog] Error checking for main thumbnail:', error);
            }

            options.options.description = description;

            const tagsValue = document.getElementById('youtube-upload-tags').value || '';
            options.options.tags = tagsValue ? tagsValue.split(',').map(t => t.trim()).filter(t => t) : ['Star Citizen'];

            options.options.privacy = document.getElementById('youtube-upload-privacy').value || 'private';
            options.options.categoryId = document.getElementById('youtube-upload-category').value || '20';
            options.options.playlist = document.getElementById('youtube-upload-playlist').value || undefined;
        }

        // SC Player-specific options
        if (account.type === 'sc-player') {
            const characterId = document.getElementById('sc-player-character-select').value;
            if (!characterId) {
                this.showError('Please select a character');
                return;
            }

            // Determine which tab is active
            const activeTab = document.querySelector('.sc-player-tab-btn.active')?.dataset?.tab || 'direct';

            options.options.title = document.getElementById('sc-player-upload-title').value ||
                this.currentFile.split(/[\\/]/).pop().replace(/\.[^/.]+$/, ''); // Use filename without extension as default
            options.options.description = document.getElementById('sc-player-upload-description').value || '';
            options.options.characterId = characterId;
            options.options.organizationId = document.getElementById('sc-player-org-select').value || undefined;
            options.options.privacy = document.getElementById('sc-player-privacy').value || 'public';
            // Force metadata to be included (always required for SC Player)
            options.options.includeMetadata = true;

            // Check if thumbnails are required (when they exist)
            const thumbnailCheckbox = document.getElementById('sc-player-include-thumbnails');
            const isThumbRequired = thumbnailCheckbox?.disabled && thumbnailCheckbox?.checked;
            options.options.includeThumbnails = thumbnailCheckbox?.checked || false;

            // Validate thumbnails if they're required
            if (isThumbRequired && !options.options.includeThumbnails) {
                this.showError('Thumbnails are required when they exist for SC Player uploads');
                return;
            }

            if (activeTab === 'direct') {
                // Direct upload to SC Player
                if (!account.accountInfo?.hasStorage) {
                    this.showError('Direct upload requires storage quota. Please use the "Upload via S3" tab.');
                    return;
                }
                options.options.uploadMethod = 'direct';
            } else if (activeTab === 's3-index') {
                // S3 upload with SC Player indexing
                const s3AccountId = document.getElementById('sc-player-s3-account')?.value;
                if (!s3AccountId) {
                    this.showError('Please select an S3 account for upload');
                    return;
                }
                options.options.uploadMethod = 's3-index';
                options.options.s3AccountId = s3AccountId;
            } else {
                this.showError('Please select a valid upload method');
                return;
            }

            // Check for main thumbnail
            try {
                const fs = require('fs');
                const path = require('path');
                const parsed = path.parse(this.currentFile);
                const mainThumbnailPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

                if (fs.existsSync(mainThumbnailPath)) {
                    options.options.mainThumbnailPath = mainThumbnailPath;
                    console.log('[UploadDialog] Found main thumbnail for SC Player upload:', mainThumbnailPath);
                }
            } catch (error) {
                console.error('[UploadDialog] Error checking for main thumbnail:', error);
            }
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
     * Load SC Player posting contexts (characters and organizations)
     */
    async loadSCPlayerContexts(account) {
        try {
            // Fetch posting contexts from the account's stored info
            if (!account.accountInfo) {
                console.warn('[UploadDialog] No account info available for SC Player account');
                return;
            }

            const { characters = [], organizations = [] } = account.accountInfo;

            // Populate character dropdown
            const characterSelect = document.getElementById('sc-player-character-select');
            characterSelect.innerHTML = '<option value="">Select Character...</option>';

            characters.forEach(character => {
                const option = document.createElement('option');
                option.value = character.id;
                option.textContent = character.handle || character.name || 'Unknown Character';
                characterSelect.appendChild(option);
            });

            // When character changes, update organizations
            characterSelect.addEventListener('change', () => {
                this.updateSCPlayerOrganizations(account, characterSelect.value);
            });

            // Select first character if only one
            if (characters.length === 1) {
                characterSelect.value = characters[0].id;
                this.updateSCPlayerOrganizations(account, characters[0].id);
            }
        } catch (error) {
            console.error('[UploadDialog] Failed to load SC Player contexts:', error);
        }
    }

    /**
     * Update organization dropdown based on selected character
     */
    updateSCPlayerOrganizations(account, characterId) {
        const orgSelect = document.getElementById('sc-player-org-select');
        orgSelect.innerHTML = '<option value="">No Organization</option>';

        if (!characterId || !account.accountInfo) return;

        // Find organizations for the selected character
        const { organizations = [] } = account.accountInfo;

        // Filter orgs that belong to the selected character
        const characterOrgs = organizations.filter(org => {
            // Organizations may have a characterId field or be associated through the character
            return org.characterId === characterId || !org.characterId;
        });

        characterOrgs.forEach(org => {
            const option = document.createElement('option');
            option.value = org.id || org.organizationId;
            option.textContent = org.name || org.sid || 'Unknown Organization';
            orgSelect.appendChild(option);
        });
    }

    /**
     * Switch SC Player upload tabs
     */
    switchSCPlayerTab(tabName) {
        // Update tab buttons
        const tabButtons = document.querySelectorAll('.sc-player-tab-btn');
        tabButtons.forEach(btn => {
            const isActive = btn.dataset.tab === tabName;
            btn.classList.toggle('active', isActive);
            btn.style.background = isActive ? 'var(--card-bg)' : 'var(--bg)';
            btn.style.color = isActive ? 'var(--text)' : 'var(--text-secondary)';
            btn.style.borderBottomColor = isActive ? 'var(--accent)' : 'transparent';
        });

        // Update tab content
        const directTab = document.getElementById('sc-player-direct-tab');
        const s3Tab = document.getElementById('sc-player-s3-tab');

        if (tabName === 'direct') {
            if (directTab) directTab.style.display = 'block';
            if (s3Tab) s3Tab.style.display = 'none';

            // Trigger validation when Direct Upload tab is selected
            this.validateDirectUploadRequirements();
        } else if (tabName === 's3-index') {
            if (directTab) directTab.style.display = 'none';
            if (s3Tab) s3Tab.style.display = 'block';

            // Clear any validation status from direct tab
            const uploadButton = document.getElementById('upload-button');
            if (uploadButton) {
                uploadButton.disabled = false;
            }
        }
    }

    /**
     * Update SC Player tabs based on account capabilities
     */
    updateSCPlayerTabs(account) {
        const directTabBtn = document.querySelector('.sc-player-tab-btn[data-tab="direct"]');
        const directMethodText = document.getElementById('sc-player-direct-method-text');

        if (!account.accountInfo || !directTabBtn || !directMethodText) {
            return;
        }

        const { hasStorage, storageUsedFormatted, storageQuotaFormatted, storagePercentage } = account.accountInfo;

        if (hasStorage) {
            // Account has storage - enable direct upload tab and make it default
            directTabBtn.disabled = false;
            directTabBtn.style.opacity = '1';
            directTabBtn.title = '';

            directMethodText.innerHTML = `
                <strong>Direct Upload Available</strong><br>
                Storage: ${storageUsedFormatted} / ${storageQuotaFormatted} (${storagePercentage}% used)<br>
                Video will be uploaded directly to your StarCapture Player storage.
            `;

            // Default to direct upload tab
            this.switchSCPlayerTab('direct');
        } else {
            // Account has no storage - disable direct upload tab, default to S3
            directTabBtn.disabled = true;
            directTabBtn.style.opacity = '0.5';
            directTabBtn.title = 'Direct upload requires storage quota';

            directMethodText.innerHTML = `
                <strong>Direct Upload Not Available</strong><br>
                Your account does not have storage quota assigned.<br>
                Please use the "Upload via S3" tab to upload and index your videos.
            `;

            // Default to S3 tab since direct is not available
            this.switchSCPlayerTab('s3-index');
        }
    }

    /**
     * Check if thumbnails exist and make them required for SC Player
     */
    checkSCPlayerThumbnailRequirements() {
        try {
            const fs = require('fs');
            const path = require('path');

            if (!this.currentFile) return;

            const parsed = path.parse(this.currentFile);
            const thumbnailFolder = path.join(parsed.dir, `${parsed.name}_thumbs`);
            const mainThumbnailPath = path.join(parsed.dir, `${parsed.name}_main_thumb.jpg`);

            const hasThumbnails = fs.existsSync(thumbnailFolder) || fs.existsSync(mainThumbnailPath);

            const thumbnailCheckbox = document.getElementById('sc-player-include-thumbnails');
            const thumbnailRequired = document.getElementById('sc-player-thumbnails-required');
            const thumbnailHelp = document.getElementById('sc-player-thumbnails-help');

            if (hasThumbnails && thumbnailCheckbox && thumbnailRequired && thumbnailHelp) {
                // Make thumbnails required if they exist
                thumbnailCheckbox.disabled = true;
                thumbnailCheckbox.checked = true;
                thumbnailRequired.style.display = 'inline';
                thumbnailHelp.style.display = 'block';
                thumbnailHelp.textContent = 'Required when thumbnails exist - needed for proper SC Player indexing';
            } else if (thumbnailCheckbox && thumbnailRequired && thumbnailHelp) {
                // Make thumbnails optional if they don't exist
                thumbnailCheckbox.disabled = false;
                thumbnailRequired.style.display = 'none';
                thumbnailHelp.style.display = 'block';
                thumbnailHelp.textContent = 'No thumbnails found for this video';
            }
        } catch (error) {
            console.error('[UploadDialog] Error checking thumbnail requirements:', error);
        }
    }

    /**
     * Load S3 accounts for SC Player indexing
     */
    loadS3AccountsForSCPlayer() {
        const s3Select = document.getElementById('sc-player-s3-account');
        if (!s3Select) return;

        // Clear existing options
        s3Select.innerHTML = '<option value="">Select S3 Account...</option>';

        // Filter accounts to show only S3 accounts
        const s3Accounts = this.accounts.filter(account => account.type === 's3');

        if (s3Accounts.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No S3 accounts configured';
            option.disabled = true;
            s3Select.appendChild(option);
        } else {
            s3Accounts.forEach(account => {
                const option = document.createElement('option');
                option.value = account.id;
                option.textContent = account.name;
                s3Select.appendChild(option);
            });

            // Auto-select if only one S3 account
            if (s3Accounts.length === 1) {
                s3Select.value = s3Accounts[0].id;
            }
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

    /**
     * Validate direct upload requirements for SC Player
     */
    async validateDirectUploadRequirements() {
        if (!this.currentFile) {
            return;
        }

        console.log('[UploadDialog] Validating direct upload requirements for:', this.currentFile);

        try {
            // Use the SC Player provider to validate files
            const result = await this.ipc.invoke('validate-sc-player-files', {
                filePath: this.currentFile
            });

            console.log('[UploadDialog] Validation result:', result);
            this.updateDirectUploadUI(result);
        } catch (error) {
            console.error('[UploadDialog] Failed to validate SC Player files:', error);
            this.updateDirectUploadUI({
                valid: false,
                error: 'Failed to validate files: ' + error.message
            });
        }
    }

    /**
     * Update the Direct Upload tab UI based on validation results
     */
    updateDirectUploadUI(validation) {
        const statusDiv = document.getElementById('sc-player-direct-upload-status');
        const uploadButton = document.getElementById('upload-button');

        if (!statusDiv) {
            console.warn('[UploadDialog] Status div not found for direct upload UI update');
            return;
        }

        if (!validation.valid) {
            // Show error/warning with appropriate action button
            const isThumbError = validation.error && validation.error.toLowerCase().includes('thumbnail');
            const isJsonError = validation.error && validation.error.includes('JSON');

            let buttonHtml = '';
            if (isThumbError) {
                buttonHtml = `
                    <button class="btn btn-primary" id="generate-thumbnails-btn" style="margin-top: 10px; width: 100%;">
                        Generate Thumbnails
                    </button>`;
            }

            const messageType = isJsonError ? 'error' : 'warning';
            statusDiv.innerHTML = `
                <div class="${messageType}-message" style="padding: 15px; border-radius: 5px; margin: 15px 0;">
                    <div style="font-weight: bold; margin-bottom: 8px;">
                        ${isJsonError ? '❌' : '⚠️'} ${validation.error}
                    </div>
                    ${isThumbError ? '<div style="font-size: 12px; opacity: 0.8;">Thumbnails are required for direct upload to ensure proper video presentation.</div>' : ''}
                    ${buttonHtml}
                </div>`;

            // Add event listener for thumbnail generation if button exists
            const generateBtn = document.getElementById('generate-thumbnails-btn');
            if (generateBtn) {
                // Capture the current file path at button creation time
                const capturedFilePath = this.currentFile;
                console.log('[UploadDialog] Setting up thumbnail button with file:', capturedFilePath);

                generateBtn.addEventListener('click', () => {
                    console.log('[UploadDialog] Thumbnail button clicked. this.currentFile:', this.currentFile, 'captured:', capturedFilePath);
                    // Use captured file path if this.currentFile is undefined
                    if (!this.currentFile && capturedFilePath) {
                        console.log('[UploadDialog] Using captured file path for thumbnail generation');
                        this.currentFile = capturedFilePath;
                    }
                    this.generateThumbnails();
                });
            }

            // Disable upload button
            if (uploadButton) {
                uploadButton.disabled = true;
            }
        } else {
            // Show success checklist
            statusDiv.innerHTML = `
                <div class="success-message" style="padding: 15px; border-radius: 5px; margin: 15px 0;">
                    <div style="font-weight: bold; margin-bottom: 8px;">
                        ✅ All requirements met for direct upload
                    </div>
                    <ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 13px;">
                        <li>✅ Video file</li>
                        <li>✅ Events JSON</li>
                        <li>✅ Main thumbnail</li>
                        <li>✅ Event thumbnails (${validation.eventThumbnailCount || 0} found)</li>
                    </ul>
                </div>`;

            // Enable upload button
            if (uploadButton) {
                uploadButton.disabled = false;
            }
        }
    }

    /**
     * Generate thumbnails using existing application functionality
     */
    async generateThumbnails() {
        const button = document.getElementById('generate-thumbnails-btn');
        if (!button) return;

        const originalText = button.textContent;

        try {
            // Validate that we have a current file
            if (!this.currentFile) {
                console.error('[UploadDialog] Cannot generate thumbnails: currentFile is null/undefined');
                console.error('[UploadDialog] currentVideo:', this.currentVideo);
                throw new Error('No video file selected for thumbnail generation');
            }

            // Update button to show progress with spinner
            button.disabled = true;
            button.innerHTML = `
                <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <div class="spinner" style="
                        width: 16px;
                        height: 16px;
                        border: 2px solid rgba(255,255,255,0.3);
                        border-top: 2px solid white;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                    "></div>
                    <span id="thumbnail-progress-text">Initializing...</span>
                </div>
            `;
            button.style.background = 'var(--accent-secondary)';

            // Add CSS animation for spinner if not already present
            if (!document.getElementById('spinner-styles')) {
                const style = document.createElement('style');
                style.id = 'spinner-styles';
                style.textContent = `
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `;
                document.head.appendChild(style);
            }

            console.log('[UploadDialog] Triggering thumbnail generation for:', this.currentFile);

            // Prepare parameters for thumbnail generation
            const videoPath = this.currentFile;
            const jsonPath = this.currentFile.replace(/\.[^/.]+$/, '.json');

            // Determine output folder (same directory as video, with _thumbs suffix)
            const path = require('path');
            const videoBaseName = path.basename(videoPath, path.extname(videoPath));
            const videoDir = path.dirname(videoPath);
            const outputFolder = path.join(videoDir, videoBaseName + '_thumbs');

            console.log('[UploadDialog] Output folder:', outputFolder);
            console.log('[UploadDialog] JSON path:', jsonPath);

            // Read events from JSON file
            const fs = require('fs');
            let events = [];
            try {
                if (fs.existsSync(jsonPath)) {
                    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
                    const jsonData = JSON.parse(jsonContent);
                    events = jsonData.events || [];
                    console.log('[UploadDialog] Loaded', events.length, 'events from JSON');
                } else {
                    console.warn('[UploadDialog] JSON file not found:', jsonPath);
                }
            } catch (error) {
                console.error('[UploadDialog] Failed to read events from JSON:', error);
            }

            // Set up progress listener
            const progressText = document.getElementById('thumbnail-progress-text');
            const progressListener = (event, progress) => {
                if (progressText) {
                    if (progress.stage) {
                        progressText.textContent = `${progress.stage}...`;
                    } else if (progress.processed && progress.total) {
                        const percentage = Math.round((progress.processed / progress.total) * 100);
                        progressText.textContent = `Processing ${progress.processed}/${progress.total} (${percentage}%)`;
                    } else if (progress.message) {
                        progressText.textContent = progress.message;
                    }
                }
            };

            // Listen for progress updates
            this.ipc.on('thumbnail-progress', progressListener);

            try {
                // Update initial status
                if (progressText) {
                    progressText.textContent = `Reading ${events.length} events...`;
                }

                // Call thumbnail generation with proper parameters
                const result = await this.ipc.invoke('generate-thumbnails', {
                    videoPath: videoPath,
                    events: events,
                    outputFolder: outputFolder,
                    mainEventId: events.length > 0 ? events[0].id : null
                });

                // Clean up progress listener
                this.ipc.removeListener('thumbnail-progress', progressListener);

                console.log('[UploadDialog] Thumbnail generation result:', result);

                if (result.success) {
                    // Update the JSON file with thumbnail paths
                    try {
                        await this.updateJsonWithThumbnailPaths(jsonPath, outputFolder, events);
                        console.log('[UploadDialog] Successfully updated JSON with thumbnail paths');
                    } catch (updateError) {
                        console.error('[UploadDialog] Failed to update JSON with thumbnail paths:', updateError);
                        // Don't fail the whole operation, just warn
                    }

                    // Show success message
                    button.innerHTML = '✅ Thumbnails generated!';
                    button.style.background = 'var(--success)';

                    // Re-validate after a short delay to allow file system to settle
                    setTimeout(() => {
                        this.validateDirectUploadRequirements();
                    }, 1500);
                } else {
                    throw new Error(result.error || 'Thumbnail generation failed');
                }

            } catch (generationError) {
                // Clean up progress listener on error
                this.ipc.removeListener('thumbnail-progress', progressListener);
                throw generationError;
            }
        } catch (error) {
            console.error('[UploadDialog] Thumbnail generation error:', error);
            button.textContent = 'Generation failed - Try again';
            button.style.background = 'var(--danger)';
            button.disabled = false;

            // Reset button after delay
            setTimeout(() => {
                button.textContent = originalText;
                button.style.background = '';
            }, 3000);

            // Show error message
            this.showError('Failed to generate thumbnails: ' + error.message);
        }
    }

    /**
     * Update JSON file with thumbnail paths after generation
     */
    async updateJsonWithThumbnailPaths(jsonPath, thumbnailFolder, events) {
        const fs = require('fs');
        const path = require('path');

        // Read the current JSON file
        const jsonContent = fs.readFileSync(jsonPath, 'utf8');
        const jsonData = JSON.parse(jsonContent);

        const videoDir = path.dirname(jsonPath);

        // Update main thumbnail in metadata
        const videoBaseName = path.basename(jsonPath, '.json');
        const mainThumbnailFileName = `${videoBaseName}_main_thumb.jpg`;
        const mainThumbnailPath = path.join(videoDir, mainThumbnailFileName);

        if (fs.existsSync(mainThumbnailPath)) {
            if (!jsonData.metadata) {
                jsonData.metadata = {};
            }
            jsonData.metadata.videoThumbnail = mainThumbnailFileName;
            console.log(`[UploadDialog] Updated metadata with videoThumbnail: ${mainThumbnailFileName}`);
        } else {
            console.warn(`[UploadDialog] Main thumbnail not found: ${mainThumbnailPath}`);
        }

        // Update each event with its thumbnail path
        if (jsonData.events) {
            jsonData.events.forEach(event => {
                if (event.id) {
                    // Construct the expected thumbnail filename based on event ID
                    const thumbnailFileName = `${event.id}.jpg`;
                    const thumbnailPath = path.join(thumbnailFolder, thumbnailFileName);

                    // Check if the thumbnail file exists
                    if (fs.existsSync(thumbnailPath)) {
                        // Set the thumbnail path relative to the video directory
                        const relativeThumbnailPath = path.relative(videoDir, thumbnailPath);
                        event.thumbnail = relativeThumbnailPath.replace(/\\/g, '/'); // Normalize path separators
                        console.log(`[UploadDialog] Updated event ${event.id} with thumbnail: ${event.thumbnail}`);
                    }
                }
            });
        }

        // Write the updated JSON back to file
        fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
        console.log(`[UploadDialog] Updated JSON file with thumbnail paths: ${jsonPath}`);
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