/**
 * Online Accounts Controller
 * Manages the UI for upload account configuration
 */
class OnlineAccountsController {
    constructor() {
        console.log('[OnlineAccounts] Constructor called');
        this.accounts = [];
        this.selectedAccountId = null;
        this.isAddDialogOpen = false;

        // Get ipcRenderer from global scope
        this.ipc = window.ipcRenderer || (typeof ipcRenderer !== 'undefined' ? ipcRenderer : null);
        if (!this.ipc) {
            console.error('[OnlineAccounts] ipcRenderer not available');
        }
    }

    async initialize() {
        console.log('[OnlineAccounts] Initializing controller...');

        // Set up UI elements
        this.setupElements();

        // Set up event listeners
        this.setupEventListeners();

        // Load initial accounts
        await this.loadAccounts();

        // Listen for upload state changes
        if (this.ipc) {
            this.ipc.on('upload-state-changed', (event, state) => {
                console.log('[OnlineAccounts] Upload state changed:', state);
                if (state.accounts) {
                    this.accounts = state.accounts;
                    this.renderAccounts();
                }
            });

            // Listen for OAuth callbacks from the proxy server
            this.ipc.on('oauth-callback', (event, data) => {
                console.log('[OnlineAccounts] OAuth callback received:', data);
                if (data.success) {
                    const service = data.service === 'google' ? 'youtube' : data.service;
                    const statusDiv = document.getElementById(`${service}-auth-status`);
                    const statusText = statusDiv?.querySelector('.status-text');
                    const authBtn = document.getElementById(`${service}-auth-btn`);

                    if (statusText) {
                        statusText.innerHTML = `✅ Connected successfully!`;
                        statusText.classList.add('text-success');
                    }

                    // Store the auth data temporarily
                    this[`${data.service}AuthData`] = {
                        tokens: data.tokens,
                        service: data.service,
                        userInfo: data.userInfo  // Include user info from OAuth callback
                    };

                    if (authBtn) {
                        authBtn.textContent = 'Re-authenticate';
                        authBtn.disabled = false;
                    }
                } else {
                    const errorMsg = data.error || 'Authentication failed';
                    console.error('[OnlineAccounts] OAuth failed:', errorMsg);
                    // Could show error in UI here
                }
            });
        }

        console.log('[OnlineAccounts] Controller initialized');
    }

    setupElements() {
        console.log('[OnlineAccounts] Setting up elements...');

        // Account list container
        this.accountsList = document.getElementById('accounts-list');
        console.log('[OnlineAccounts] accounts-list element:', this.accountsList);

        // Buttons
        this.addAccountBtn = document.getElementById('add-account-btn');
        console.log('[OnlineAccounts] add-account-btn element:', this.addAccountBtn);
        this.testAccountBtn = document.getElementById('test-account-btn');
        this.deleteAccountBtn = document.getElementById('delete-account-btn');

        // Add account dialog
        this.addAccountDialog = document.getElementById('add-account-dialog');
        this.accountTypeSelect = document.getElementById('account-type-select');
        this.accountNameInput = document.getElementById('account-name-input');
        this.accountForm = document.getElementById('account-form');
        this.saveAccountBtn = document.getElementById('save-account-btn');
        this.cancelAccountBtn = document.getElementById('cancel-account-btn');

        // Status display
        this.accountStatus = document.getElementById('account-status');

        // Confirmation modal
        this.confirmModal = document.getElementById('confirm-delete-modal');
        this.confirmMessage = document.getElementById('confirm-delete-message');
        this.confirmDeleteBtn = document.getElementById('confirm-delete-confirm');
        this.cancelDeleteBtn = document.getElementById('confirm-delete-cancel');

        console.log('[OnlineAccounts] Elements setup complete');
    }

    setupEventListeners() {
        // Add account button
        if (this.addAccountBtn) {
            this.addAccountBtn.addEventListener('click', () => this.showAddAccountDialog());
        }

        // Test account button
        if (this.testAccountBtn) {
            this.testAccountBtn.addEventListener('click', () => this.testSelectedAccount());
        }

        // Delete account button
        if (this.deleteAccountBtn) {
            this.deleteAccountBtn.addEventListener('click', () => this.deleteSelectedAccount());
        }

        // Account type selection
        if (this.accountTypeSelect) {
            this.accountTypeSelect.addEventListener('change', () => this.onAccountTypeChange());
        }

        // Save account button
        if (this.saveAccountBtn) {
            this.saveAccountBtn.addEventListener('click', () => this.saveAccount());
        }

        // Cancel button
        if (this.cancelAccountBtn) {
            this.cancelAccountBtn.addEventListener('click', () => this.hideAddAccountDialog());
        }

        // Confirmation modal buttons
        if (this.confirmDeleteBtn) {
            this.confirmDeleteBtn.addEventListener('click', () => this.confirmDelete());
        }
        if (this.cancelDeleteBtn) {
            this.cancelDeleteBtn.addEventListener('click', () => this.hideConfirmModal());
        }
    }

    async loadAccounts() {
        if (!this.ipc) {
            console.error('[OnlineAccounts] Cannot load accounts - ipcRenderer not available');
            return;
        }
        try {
            const result = await this.ipc.invoke('upload:list-accounts');
            if (result.success) {
                this.accounts = result.accounts || [];
                this.renderAccounts();
            } else {
                console.error('[OnlineAccounts] Failed to load accounts:', result.error);
            }
        } catch (error) {
            console.error('[OnlineAccounts] Error loading accounts:', error);
        }
    }

    renderAccounts() {
        if (!this.accountsList) return;

        if (this.accounts.length === 0) {
            this.accountsList.innerHTML = `
                <div class="empty-state">
                    <p>No accounts configured</p>
                    <p class="text-muted">Click "Add Account" to get started</p>
                </div>
            `;
            return;
        }

        this.accountsList.innerHTML = this.accounts.map(account => `
            <div class="account-item ${account.id === this.selectedAccountId ? 'selected' : ''}"
                 data-account-id="${account.id}">
                <div class="account-icon">
                    ${this.getAccountIcon(account.type)}
                </div>
                <div class="account-info">
                    <div class="account-name">${this.escapeHtml(account.name)}</div>
                    <div class="account-type">${this.getAccountTypeName(account.type)}</div>
                </div>
                <div class="account-status">
                    ${account.uploadCount > 0 ?
                        `<span class="upload-count">${account.uploadCount} uploads</span>` :
                        '<span class="text-muted">No uploads yet</span>'
                    }
                </div>
            </div>
        `).join('');

        // Add click handlers
        this.accountsList.querySelectorAll('.account-item').forEach(item => {
            item.addEventListener('click', () => {
                this.selectAccount(item.dataset.accountId);
            });
        });
    }

    selectAccount(accountId) {
        this.selectedAccountId = accountId;

        // Update UI selection
        this.accountsList.querySelectorAll('.account-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.accountId === accountId);
        });

        // Enable/disable buttons
        if (this.testAccountBtn) {
            this.testAccountBtn.disabled = !accountId;
        }
        if (this.deleteAccountBtn) {
            this.deleteAccountBtn.disabled = !accountId;
        }
    }

    showAddAccountDialog() {
        if (!this.addAccountDialog) return;

        this.isAddDialogOpen = true;
        this.addAccountDialog.style.display = 'block';

        // Reset form
        if (this.accountNameInput) {
            this.accountNameInput.value = '';
        }
        if (this.accountTypeSelect) {
            this.accountTypeSelect.value = 's3';
        }

        // Show S3 form by default
        this.onAccountTypeChange();
    }

    hideAddAccountDialog() {
        if (!this.addAccountDialog) return;

        this.isAddDialogOpen = false;
        this.addAccountDialog.style.display = 'none';
    }

    onAccountTypeChange() {
        const accountType = this.accountTypeSelect?.value || 's3';

        if (!this.accountForm) return;

        // Clear existing form
        this.accountForm.innerHTML = '';

        switch (accountType) {
            case 's3':
                this.renderS3Form();
                break;
            case 'youtube':
                this.renderYouTubeForm();
                break;
            case 'twitch':
                this.renderTwitchForm();
                break;
        }
    }

    renderS3Form() {
        this.accountForm.innerHTML = `
            <div class="form-group">
                <label for="s3-access-key">Access Key ID</label>
                <input type="text" id="s3-access-key" class="form-control" required>
            </div>
            <div class="form-group">
                <label for="s3-secret-key">Secret Access Key</label>
                <input type="password" id="s3-secret-key" class="form-control" required>
            </div>
            <div class="form-group">
                <label for="s3-bucket">Bucket Name</label>
                <input type="text" id="s3-bucket" class="form-control" required>
            </div>
            <div class="form-group">
                <label for="s3-region">Region</label>
                <input type="text" id="s3-region" class="form-control" value="us-east-1">
            </div>
            <div class="form-group">
                <label for="s3-endpoint">Custom Endpoint (optional)</label>
                <input type="text" id="s3-endpoint" class="form-control"
                       placeholder="https://s3.example.com">
                <small class="form-text">Full URL including https:// for non-AWS S3 services (Cloudflare R2, MinIO, Wasabi, etc.)</small>
            </div>
            <div class="form-group">
                <label for="s3-public-url">Public URL Base (optional)</label>
                <input type="text" id="s3-public-url" class="form-control"
                       placeholder="https://pub-example.r2.dev">
                <small class="form-text">Base URL for public access if different from endpoint (e.g., R2 public hostname)</small>
            </div>
            <div class="form-group">
                <label for="s3-prefix">Path Prefix (optional)</label>
                <input type="text" id="s3-prefix" class="form-control"
                       placeholder="recordings/star-citizen">
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="s3-force-path-style">
                    Force Path Style (for some S3-compatible services)
                </label>
            </div>
        `;
    }

    renderYouTubeForm() {
        this.accountForm.innerHTML = `
            <div class="form-group">
                <div class="oauth-auth-section">
                    <h4>YouTube Authentication</h4>
                    <p class="text-muted">Connect your YouTube channel to upload videos directly.</p>
                    <button type="button" id="youtube-auth-btn" class="btn btn-primary">
                        <i class="fab fa-youtube"></i> Connect YouTube Account
                    </button>
                    <div id="youtube-auth-status" class="auth-status mt-3" style="display: none;">
                        <span class="status-text"></span>
                    </div>
                </div>
            </div>
            <div class="form-group">
                <label for="youtube-privacy">Default Privacy Setting</label>
                <select id="youtube-privacy" class="form-control">
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                </select>
            </div>
            <div class="form-group">
                <label for="youtube-playlist">Add to Playlist (optional)</label>
                <input type="text" id="youtube-playlist" class="form-control"
                       placeholder="Playlist ID (optional)">
            </div>
        `;

        // Add OAuth button handler
        const authBtn = document.getElementById('youtube-auth-btn');
        if (authBtn) {
            authBtn.addEventListener('click', () => this.authenticateOAuth('google'));
        }
    }

    renderTwitchForm() {
        this.accountForm.innerHTML = `
            <div class="form-group">
                <div class="oauth-auth-section">
                    <h4>Twitch Authentication</h4>
                    <p class="text-muted">Connect your Twitch account to upload highlights and videos.</p>
                    <button type="button" id="twitch-auth-btn" class="btn btn-primary">
                        <i class="fab fa-twitch"></i> Connect Twitch Account
                    </button>
                    <div id="twitch-auth-status" class="auth-status mt-3" style="display: none;">
                        <span class="status-text"></span>
                    </div>
                </div>
            </div>
            <div class="form-group">
                <label for="twitch-video-type">Video Type</label>
                <select id="twitch-video-type" class="form-control">
                    <option value="archive">Archive</option>
                    <option value="highlight">Highlight</option>
                    <option value="upload">Upload</option>
                </select>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="twitch-auto-publish" checked>
                    Auto-publish after upload
                </label>
            </div>
        `;

        // Add OAuth button handler
        const authBtn = document.getElementById('twitch-auth-btn');
        if (authBtn) {
            authBtn.addEventListener('click', () => this.authenticateOAuth('twitch'));
        }
    }

    async authenticateOAuth(service) {
        const statusDiv = document.getElementById(`${service === 'google' ? 'youtube' : service}-auth-status`);
        const statusText = statusDiv?.querySelector('.status-text');
        const authBtn = document.getElementById(`${service === 'google' ? 'youtube' : service}-auth-btn`);

        if (statusDiv) statusDiv.style.display = 'block';
        if (statusText) statusText.textContent = 'Opening authentication window...';
        if (authBtn) authBtn.disabled = true;

        try {
            const result = await this.ipc.invoke('oauth:authenticate', service);

            if (result.success) {
                if (result.pending) {
                    // OAuth proxy flow - authentication happens in browser
                    if (statusText) {
                        statusText.textContent = '⏳ Please complete authentication in your browser...';
                        statusText.classList.add('text-warning');
                    }
                    // The actual result will come via the oauth-callback event
                } else {
                    // Direct authentication (legacy flow)
                    if (statusText) {
                        const displayName = service === 'google'
                            ? result.userInfo.name
                            : result.userInfo.display_name || result.userInfo.login;
                        statusText.innerHTML = `✅ Connected as: <strong>${displayName}</strong>`;
                        statusText.classList.add('text-success');
                    }

                    // Store the auth data temporarily
                    this[`${service}AuthData`] = {
                        tokens: result.tokens,
                        userInfo: result.userInfo
                    };

                    // Update button
                    if (authBtn) {
                        authBtn.textContent = 'Re-authenticate';
                        authBtn.disabled = false;
                    }
                }
            } else {
                if (statusText) {
                    statusText.textContent = `❌ Authentication failed: ${result.error}`;
                    statusText.classList.add('text-danger');
                }
                if (authBtn) authBtn.disabled = false;
            }
        } catch (error) {
            console.error(`[OnlineAccounts] OAuth authentication error:`, error);
            if (statusText) {
                statusText.textContent = `❌ Error: ${error.message}`;
                statusText.classList.add('text-danger');
            }
            if (authBtn) authBtn.disabled = false;
        }
    }

    async saveAccount() {
        const accountType = this.accountTypeSelect?.value || 's3';
        const accountName = this.accountNameInput?.value?.trim();

        if (!accountName) {
            this.showStatus('Please enter an account name', 'error');
            return;
        }

        let accountData;

        switch (accountType) {
            case 's3':
                accountData = this.collectS3Data();
                if (!accountData) return;
                break;
            case 'youtube':
                accountData = this.collectYouTubeData();
                if (!accountData) return;
                break;
            case 'twitch':
                accountData = this.collectTwitchData();
                if (!accountData) return;
                break;
            default:
                this.showStatus('Account type not yet supported', 'error');
                return;
        }

        // Add account via IPC
        if (!this.ipc) {
            this.showStatus('Cannot add account - IPC not available', 'error');
            return;
        }
        try {
            const result = await this.ipc.invoke('upload:add-account', {
                type: accountType,
                name: accountName,
                ...accountData
            });

            if (result.success) {
                this.showStatus('Account added successfully', 'success');
                this.hideAddAccountDialog();
                await this.loadAccounts();
            } else {
                this.showStatus(result.error || 'Failed to add account', 'error');
            }
        } catch (error) {
            console.error('[OnlineAccounts] Error adding account:', error);
            this.showStatus('Failed to add account', 'error');
        }
    }

    collectS3Data() {
        const accessKey = document.getElementById('s3-access-key')?.value?.trim();
        const secretKey = document.getElementById('s3-secret-key')?.value?.trim();
        const bucket = document.getElementById('s3-bucket')?.value?.trim();
        const region = document.getElementById('s3-region')?.value?.trim() || 'us-east-1';
        const endpoint = document.getElementById('s3-endpoint')?.value?.trim();
        const publicUrl = document.getElementById('s3-public-url')?.value?.trim();
        const prefix = document.getElementById('s3-prefix')?.value?.trim();
        const forcePathStyle = document.getElementById('s3-force-path-style')?.checked || false;

        if (!accessKey || !secretKey || !bucket) {
            this.showStatus('Please fill in all required fields', 'error');
            return null;
        }

        return {
            credentials: {
                accessKeyId: accessKey,
                secretAccessKey: secretKey
            },
            config: {
                bucket,
                region,
                endpoint: endpoint || undefined,
                publicUrl: publicUrl || undefined,
                prefix: prefix || undefined,
                forcePathStyle
            }
        };
    }

    collectYouTubeData() {
        if (!this.googleAuthData) {
            this.showStatus('Please authenticate with YouTube first', 'error');
            return null;
        }

        const privacy = document.getElementById('youtube-privacy')?.value || 'private';
        const playlist = document.getElementById('youtube-playlist')?.value?.trim();

        // Provide defaults if userInfo is missing
        const userInfo = this.googleAuthData.userInfo || {};

        return {
            credentials: {
                accessToken: this.googleAuthData.tokens.access_token,
                refreshToken: this.googleAuthData.tokens.refresh_token,
                expiresIn: this.googleAuthData.tokens.expires_in,
                tokenType: this.googleAuthData.tokens.token_type
            },
            config: {
                channelId: userInfo.id || 'unknown',
                channelName: userInfo.name || 'YouTube User',
                email: userInfo.email || '',
                privacy,
                playlist: playlist || undefined
            }
        };
    }

    collectTwitchData() {
        if (!this.twitchAuthData) {
            this.showStatus('Please authenticate with Twitch first', 'error');
            return null;
        }

        const videoType = document.getElementById('twitch-video-type')?.value || 'upload';
        const autoPublish = document.getElementById('twitch-auto-publish')?.checked ?? true;

        // Handle cases where userInfo might be null (OAuth proxy doesn't always return it)
        const userInfo = this.twitchAuthData.userInfo || {};

        return {
            credentials: {
                accessToken: this.twitchAuthData.tokens.access_token,
                expiresIn: this.twitchAuthData.tokens.expires_in,
                tokenType: this.twitchAuthData.tokens.token_type
            },
            config: {
                channelId: userInfo.id || '',
                channelName: userInfo.display_name || userInfo.login || 'Twitch User',
                login: userInfo.login || '',
                videoType,
                autoPublish,
                // Include the client ID for the provider to use
                clientId: this.twitchAuthData.tokens.client_id || ''
            }
        };
    }

    async testSelectedAccount() {
        if (!this.selectedAccountId) return;

        this.showStatus('Testing connection...', 'info');

        if (!this.ipc) {
            this.showStatus('Cannot test account - IPC not available', 'error');
            return;
        }

        try {
            const result = await this.ipc.invoke('upload:test-account', {
                accountId: this.selectedAccountId
            });

            if (result.success) {
                this.showStatus('Connection successful!', 'success');
            } else {
                this.showStatus(result.error || 'Connection failed', 'error');
            }
        } catch (error) {
            console.error('[OnlineAccounts] Error testing account:', error);
            this.showStatus('Failed to test connection', 'error');
        }
    }

    async deleteSelectedAccount() {
        if (!this.selectedAccountId) return;

        const account = this.accounts.find(a => a.id === this.selectedAccountId);
        if (!account) return;

        // Store the account ID for the confirmation
        this.accountToDelete = this.selectedAccountId;

        // Show custom confirmation modal
        this.showConfirmModal(`Are you sure you want to delete the account "${account.name}"?`);
    }

    showConfirmModal(message) {
        if (!this.confirmModal || !this.confirmMessage) return;

        this.confirmMessage.textContent = message;
        this.confirmModal.style.display = 'flex';
    }

    hideConfirmModal() {
        if (!this.confirmModal) return;

        this.confirmModal.style.display = 'none';
        this.accountToDelete = null;
    }

    async confirmDelete() {
        if (!this.accountToDelete) {
            this.hideConfirmModal();
            return;
        }

        if (!this.ipc) {
            this.showStatus('Cannot delete account - IPC not available', 'error');
            this.hideConfirmModal();
            return;
        }

        try {
            const result = await this.ipc.invoke('upload:delete-account', {
                accountId: this.accountToDelete
            });

            if (result.success) {
                this.showStatus('Account deleted', 'success');
                this.selectedAccountId = null;
                await this.loadAccounts();
            } else {
                this.showStatus(result.error || 'Failed to delete account', 'error');
            }
        } catch (error) {
            console.error('[OnlineAccounts] Error deleting account:', error);
            this.showStatus('Failed to delete account', 'error');
        } finally {
            this.hideConfirmModal();
        }
    }

    showStatus(message, type = 'info') {
        if (!this.accountStatus) return;

        this.accountStatus.textContent = message;
        this.accountStatus.className = `status-message status-${type}`;

        // Auto-hide after 5 seconds
        setTimeout(() => {
            if (this.accountStatus.textContent === message) {
                this.accountStatus.textContent = '';
                this.accountStatus.className = '';
            }
        }, 5000);
    }

    getAccountIcon(type) {
        const icons = {
            's3': '☁️',
            'youtube': '📺',
            'twitch': '🎮'
        };
        return icons[type] || '📁';
    }

    getAccountTypeName(type) {
        const names = {
            's3': 'S3-Compatible Storage',
            'youtube': 'YouTube',
            'twitch': 'Twitch'
        };
        return names[type] || type;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Export for use in index.html
window.OnlineAccountsController = OnlineAccountsController;
console.log('[OnlineAccounts] Class registered to window');