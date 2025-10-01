const BaseManager = require('./base-manager');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs').promises;
const { safeStorage } = require('electron');
const crypto = require('crypto');

/**
 * Upload Manager
 * Handles account management and file uploads to various cloud services
 */
class UploadManager extends BaseManager {
    constructor() {
        super('upload');
        this.accounts = new Map();
        this.uploadQueue = [];
        this.activeUploads = new Map();
        this.completedUploads = [];
        this.providers = new Map();
        this.credentialStorePath = null;
        this.maxConcurrentUploads = 3;
        this.initialized = false;
        this.queuePaused = true; // Start with queue paused
        this.autoProcessQueue = false; // Don't auto-process queue
    }

    /**
     * Initialize the upload manager
     */
    async initialize(config) {
        this.config = config;

        // Always use APPDATA for config storage
        const userDataPath = path.join(process.env.APPDATA || process.env.HOME, 'sc-recorder');
        this.credentialStorePath = path.join(userDataPath, 'accounts.encrypted');
        this.uploadStatePath = path.join(userDataPath, 'upload-state.json');

        // Load existing accounts
        await this.loadAccounts();

        // Load upload queue state
        await this.loadUploadState();

        // Initialize providers
        await this.initializeProviders();

        this.initialized = true;
        this.emit('initialized', this.getState());

        await super.initialize();
        return true;
    }

    /**
     * Initialize provider modules
     */
    async initializeProviders() {
        try {
            // Initialize S3 provider
            const S3Provider = require('../providers/s3-provider');
            const s3Provider = new S3Provider();
            this.providers.set('s3', s3Provider);

            // Initialize SC Player provider
            const SCPlayerProvider = require('../providers/sc-player-provider');
            const scPlayerProvider = new SCPlayerProvider();
            this.providers.set('sc-player', scPlayerProvider);

            // Initialize YouTube provider
            const YouTubeProvider = require('../providers/youtube-provider');
            const youtubeProvider = new YouTubeProvider();
            this.providers.set('youtube', youtubeProvider);

            // Twitch provider removed - Twitch doesn't support direct uploads via API

            this.emit('providers-initialized', Array.from(this.providers.keys()));
            this.emit('log', `Initialized ${this.providers.size} upload providers`);
        } catch (error) {
            this.emit('error', `Failed to initialize providers: ${error.message}`);
        }
    }

    /**
     * Load accounts from encrypted storage
     */
    async loadAccounts() {
        try {
            const exists = await fs.access(this.credentialStorePath).then(() => true).catch(() => false);
            if (!exists) {
                this.emit('log', 'No existing accounts file found');
                return;
            }

            const encryptedData = await fs.readFile(this.credentialStorePath);

            if (safeStorage.isEncryptionAvailable()) {
                const decryptedData = safeStorage.decryptString(encryptedData);
                const accountData = JSON.parse(decryptedData);

                for (const account of accountData) {
                    this.accounts.set(account.id, account);
                }

                this.emit('log', `Loaded ${accountData.length} accounts`);
            } else {
                this.emit('error', 'Encryption not available on this system');
            }
        } catch (error) {
            this.emit('error', `Failed to load accounts: ${error.message}`);
        }
    }

    /**
     * Save accounts to encrypted storage
     */
    async saveAccounts() {
        try {
            const accountData = Array.from(this.accounts.values());
            const jsonString = JSON.stringify(accountData, null, 2);

            if (safeStorage.isEncryptionAvailable()) {
                const encrypted = safeStorage.encryptString(jsonString);
                await fs.writeFile(this.credentialStorePath, encrypted);
                this.emit('log', 'Accounts saved successfully');
            } else {
                throw new Error('Encryption not available');
            }
        } catch (error) {
            this.emit('error', `Failed to save accounts: ${error.message}`);
            throw error;
        }
    }

    /**
     * Handle commands from supervisor
     */
    async handleCommand(command) {
        const { action, data } = command;

        switch (action) {
            // Account Management
            case 'ADD_ACCOUNT':
                return await this.addAccount(data);
            case 'UPDATE_ACCOUNT':
                return await this.updateAccount(data);
            case 'DELETE_ACCOUNT':
                return await this.deleteAccount(data);
            case 'LIST_ACCOUNTS':
                return this.listAccounts(data);
            case 'TEST_ACCOUNT':
                return await this.testAccount(data);

            // Upload Operations
            case 'UPLOAD_FILE':
                return await this.queueUpload(data);
            case 'CANCEL_UPLOAD':
                return await this.cancelUpload(data);
            case 'GET_UPLOAD_STATUS':
                return this.getUploadStatus();
            case 'GET_STATE':
                return this.getState();
            case 'CLEAR_COMPLETED':
                return await this.clearCompleted();
            case 'REMOVE_FROM_QUEUE':
                return await this.removeFromQueue(data);
            case 'REMOVE_COMPLETED':
                return await this.removeCompleted(data);
            case 'START_QUEUE':
                return await this.startQueue();
            case 'PAUSE_QUEUE':
                return await this.pauseQueue();
            case 'GET_QUEUE_STATUS':
                return this.getQueueStatus();

            default:
                throw new Error(`Unknown upload command: ${action}`);
        }
    }

    /**
     * Add a new account
     */
    async addAccount(data) {
        const { type, name, config, credentials } = data;

        // Generate unique ID
        const accountId = this.generateAccountId();

        const account = {
            id: accountId,
            type,
            name,
            config,
            credentials,
            createdAt: Date.now(),
            lastUsed: null,
            uploadCount: 0
        };

        // Validate account based on type
        const provider = this.providers.get(type);
        if (provider) {
            // Check which validation method the provider has
            if (provider.validateCredentials) {
                const isValid = await provider.validateCredentials(credentials, config);
                if (!isValid) {
                    throw new Error('Invalid credentials or configuration');
                }
            } else if (provider.validateAccount) {
                const result = await provider.validateAccount(credentials, config);
                if (!result.valid) {
                    throw new Error('Invalid credentials or configuration');
                }
                // Store account info for SC Player accounts (and any other providers that return it)
                if (result.accountInfo) {
                    account.accountInfo = result.accountInfo;
                }
                // Update tokens if refreshed
                if (result.newTokens) {
                    account.credentials = { ...credentials, ...result.newTokens };
                    // Save immediately to persist new tokens
                    await this.saveAccounts();
                    console.log(`[UploadManager] Updated tokens for account ${account.name}`);
                }
            }
        }

        this.accounts.set(accountId, account);
        await this.saveAccounts();

        this.emit('account-added', account);
        this.emit('state-changed', this.getState());

        return { success: true, accountId };
    }

    /**
     * Update an existing account
     */
    async updateAccount(data) {
        const { accountId, updates } = data;

        const account = this.accounts.get(accountId);
        if (!account) {
            throw new Error(`Account ${accountId} not found`);
        }

        // Update account fields
        Object.assign(account, updates);

        // Revalidate if credentials changed
        if (updates.credentials || updates.config) {
            const provider = this.providers.get(account.type);
            if (provider) {
                // Check which validation method the provider has
                if (provider.validateCredentials) {
                    const isValid = await provider.validateCredentials(
                        account.credentials,
                        account.config
                    );
                    if (!isValid) {
                        throw new Error('Invalid credentials or configuration');
                    }
                } else if (provider.validateAccount) {
                    const result = await provider.validateAccount(
                        account.credentials,
                        account.config
                    );
                    if (!result.valid) {
                        throw new Error('Invalid credentials or configuration');
                    }
                    // Update tokens if refreshed
                    if (result.newTokens) {
                        account.credentials = { ...account.credentials, ...result.newTokens };
                        // Save immediately to persist new tokens
                        await this.saveAccounts();
                        console.log(`[UploadManager] Updated tokens for account ${account.name}`);
                    }
                }
            }
        }

        await this.saveAccounts();

        this.emit('account-updated', account);
        this.emit('state-changed', this.getState());

        return { success: true };
    }

    /**
     * Delete an account
     */
    async deleteAccount(data) {
        const { accountId } = data;

        if (!this.accounts.has(accountId)) {
            throw new Error(`Account ${accountId} not found`);
        }

        // Cancel any active uploads for this account
        for (const [uploadId, upload] of this.activeUploads) {
            if (upload.accountId === accountId) {
                await this.cancelUpload({ uploadId });
            }
        }

        // Remove from queue
        this.uploadQueue = this.uploadQueue.filter(u => u.accountId !== accountId);

        this.accounts.delete(accountId);
        await this.saveAccounts();

        this.emit('account-deleted', accountId);
        this.emit('state-changed', this.getState());

        return { success: true };
    }

    /**
     * List all accounts (without sensitive data)
     */
    listAccounts(data) {
        const { includeCredentials = false } = data || {};

        const accounts = Array.from(this.accounts.values()).map(account => {
            const result = {
                id: account.id,
                type: account.type,
                name: account.name,
                config: account.config,
                createdAt: account.createdAt,
                lastUsed: account.lastUsed,
                uploadCount: account.uploadCount
            };

            // Include accountInfo for SC Player accounts
            if (account.accountInfo) {
                result.accountInfo = account.accountInfo;
            }

            if (includeCredentials) {
                result.credentials = account.credentials;
            }

            return result;
        });

        return accounts;
    }

    /**
     * Test account connectivity
     */
    async testAccount(data) {
        let account;
        let provider;

        // Support both accountId (for existing accounts) and direct credentials (for testing new accounts)
        if (data.accountId) {
            // Testing existing account
            account = this.accounts.get(data.accountId);
            if (!account) {
                throw new Error(`Account ${data.accountId} not found`);
            }
            provider = this.providers.get(account.type);
        } else if (data.type && data.credentials) {
            // Testing new account before saving
            account = {
                type: data.type,
                credentials: data.credentials,
                config: data.config || {}
            };
            provider = this.providers.get(data.type);
        } else {
            throw new Error('Either accountId or type+credentials required');
        }

        if (!provider) {
            throw new Error(`Provider ${account.type} not available`);
        }

        try {
            const result = await provider.testConnection(account.credentials, account.config);

            // If testing an existing account and we got new account info, update it
            if (data.accountId && result.details) {
                const existingAccount = this.accounts.get(data.accountId);
                if (existingAccount) {
                    existingAccount.accountInfo = result.details;
                    await this.saveAccounts();
                    this.emit('state-changed', this.getState());
                }
            }

            // If this was an existing account test, emit the event
            if (data.accountId) {
                this.emit('account-tested', { accountId: data.accountId, success: true, result });
            }

            return result; // Return the full result from testConnection
        } catch (error) {
            // If this was an existing account test, emit the event
            if (data.accountId) {
                this.emit('account-tested', { accountId: data.accountId, success: false, error: error.message });
            }

            return { success: false, message: error.message };
        }
    }

    /**
     * Queue a file for upload
     */
    async queueUpload(data) {
        const { accountId, filePath, metadata = {} } = data;

        const account = this.accounts.get(accountId);
        if (!account) {
            throw new Error(`Account ${accountId} not found`);
        }

        const uploadId = this.generateUploadId();
        const upload = {
            id: uploadId,
            accountId,
            accountType: account.type,
            filePath,
            metadata,
            status: 'queued',
            progress: 0,
            bytesUploaded: 0,
            totalBytes: 0,
            createdAt: Date.now(),
            startedAt: null,
            completedAt: null,
            error: null
        };

        // Get file size
        try {
            const stats = await fs.stat(filePath);
            upload.totalBytes = stats.size;
        } catch (error) {
            throw new Error(`File not found: ${filePath}`);
        }

        this.uploadQueue.push(upload);

        // Only process queue if not paused and auto-process is enabled
        if (!this.queuePaused && this.autoProcessQueue) {
            this.processQueue();
        }

        // Save state after adding to queue
        await this.saveUploadState();

        this.emit('upload-queued', upload);
        this.emit('state-changed', this.getState());

        return { success: true, uploadId };
    }

    /**
     * Process the upload queue
     */
    async processQueue() {
        // Don't process if queue is paused
        if (this.queuePaused) {
            this.emit('log', 'Queue is paused, not processing');
            return;
        }

        while (!this.queuePaused && this.activeUploads.size < this.maxConcurrentUploads && this.uploadQueue.length > 0) {
            const upload = this.uploadQueue.shift();
            await this.startUpload(upload);
        }
    }

    /**
     * Start an upload
     */
    async startUpload(upload) {
        const account = this.accounts.get(upload.accountId);
        if (!account) {
            upload.status = 'failed';
            upload.error = 'Account not found';
            this.completedUploads.push(upload);
            this.emit('upload-failed', upload);
            return;
        }

        const provider = this.providers.get(account.type);
        if (!provider) {
            upload.status = 'failed';
            upload.error = 'Provider not available';
            this.completedUploads.push(upload);
            this.emit('upload-failed', upload);
            return;
        }

        upload.status = 'uploading';
        upload.startedAt = Date.now();
        this.activeUploads.set(upload.id, upload);

        this.emit('upload-started', upload);
        this.emit('state-changed', this.getState());

        try {
            // Create progress callback
            const onProgress = (progress) => {
                upload.progress = progress.percentage;
                upload.bytesUploaded = progress.bytesUploaded;
                // Update totalBytes if provider sends it (e.g., for multi-file uploads like SC Player)
                if (progress.totalBytes) {
                    upload.totalBytes = progress.totalBytes;
                }
                this.emit('upload-progress', {
                    uploadId: upload.id,
                    progress: progress.percentage,
                    bytesUploaded: progress.bytesUploaded,
                    totalBytes: upload.totalBytes
                });
            };

            // Perform upload
            const result = await provider.upload(
                account.credentials,
                account.config,
                upload.filePath,
                upload.metadata,
                onProgress
            );

            // Check if this requires S3 upload with post-processing (SC Player indexing)
            if (result.requiresS3Upload && result.s3AccountId) {
                console.log(`[UploadManager] SC Player upload requires S3 delegation to account ${result.s3AccountId}`);
                await this.handleS3IndexUpload(upload, result, onProgress);
                return;
            }

            // Mark as completed
            upload.status = 'completed';
            upload.completedAt = Date.now();
            upload.progress = 100;
            upload.result = result;

            // Update account credentials if they were refreshed during upload
            if (result.updatedCredentials) {
                console.log(`[UploadManager] Updating refreshed credentials for account ${account.name}`);
                account.credentials = result.updatedCredentials;
            }

            // Update account stats
            account.lastUsed = Date.now();
            account.uploadCount++;
            await this.saveAccounts();

            this.activeUploads.delete(upload.id);
            this.completedUploads.push(upload);

            // Keep only last 50 completed uploads
            if (this.completedUploads.length > 50) {
                this.completedUploads = this.completedUploads.slice(-50);
            }

            this.emit('upload-completed', upload);
            this.emit('state-changed', this.getState());

            // Save state after upload completes
            await this.saveUploadState();

            // Process next in queue
            this.processQueue();

        } catch (error) {
            // Check if it's an authentication error and retry once with refresh
            if (error.message && (error.message.includes('401') || error.message.includes('unauthorized'))) {
                console.log(`[UploadManager] Upload failed with auth error, attempting token refresh for ${account.name}`);

                // Only retry if we have YouTube provider with refresh capability
                if (account.type === 'youtube' && account.credentials?.refreshToken) {
                    try {
                        const youtubeProvider = this.providers.get('youtube');
                        if (youtubeProvider && youtubeProvider.ensureValidToken) {
                            // Force refresh by setting expiry to past
                            const expiredCredentials = {
                                ...account.credentials,
                                expiresAt: Date.now() - 1000
                            };

                            const refreshedCredentials = await youtubeProvider.ensureValidToken(expiredCredentials);

                            if (refreshedCredentials.accessToken !== account.credentials.accessToken) {
                                console.log(`[UploadManager] Token refreshed, retrying upload for ${account.name}`);
                                account.credentials = refreshedCredentials;
                                await this.saveAccounts();

                                // Retry upload with refreshed credentials
                                const retryResult = await provider.upload(
                                    account.credentials,
                                    account.config,
                                    upload.filePath,
                                    upload.metadata,
                                    onProgress
                                );

                                // Mark as completed after successful retry
                                upload.status = 'completed';
                                upload.completedAt = Date.now();
                                upload.progress = 100;
                                upload.result = retryResult;

                                // Update account stats
                                account.lastUsed = Date.now();
                                account.uploadCount++;
                                await this.saveAccounts();

                                this.activeUploads.delete(upload.id);
                                this.completedUploads.push(upload);

                                // Keep only last 50 completed uploads
                                if (this.completedUploads.length > 50) {
                                    this.completedUploads = this.completedUploads.slice(-50);
                                }

                                this.emit('upload-completed', upload);
                                this.emit('state-changed', this.getState());

                                // Save state after successful retry
                                await this.saveUploadState();

                                // Process next in queue
                                this.processQueue();
                                return;
                            }
                        }
                    } catch (retryError) {
                        console.error(`[UploadManager] Retry with refreshed token failed:`, retryError);
                        // Fall through to normal error handling
                        error.message = `Upload failed after token refresh: ${retryError.message}`;
                    }
                }
            }

            // Normal error handling
            upload.status = 'failed';
            upload.error = error.message;
            upload.completedAt = Date.now();

            this.activeUploads.delete(upload.id);
            this.completedUploads.push(upload);

            this.emit('upload-failed', upload);
            this.emit('state-changed', this.getState());

            // Save state after upload fails
            await this.saveUploadState();

            // Process next in queue
            this.processQueue();
        }
    }

    /**
     * Handle S3 upload with SC Player indexing
     */
    async handleS3IndexUpload(upload, scPlayerResult, originalOnProgress) {
        try {
            // Get the S3 account
            const s3Account = this.accounts.get(scPlayerResult.s3AccountId);
            if (!s3Account) {
                throw new Error(`S3 account ${scPlayerResult.s3AccountId} not found`);
            }

            const s3Provider = this.providers.get('s3');
            if (!s3Provider) {
                throw new Error('S3 provider not available');
            }

            console.log(`[UploadManager] Starting S3 upload for SC Player indexing`);

            // Update upload status
            upload.status = 'uploading';
            upload.statusMessage = 'Uploading to S3...';
            this.emit('upload-progress', {
                uploadId: upload.id,
                progress: 0,
                statusMessage: 'Uploading to S3...'
            });

            // Create progress wrapper for S3 upload (use 80% of progress for S3, 20% for indexing)
            const s3OnProgress = (progress) => {
                const adjustedProgress = Math.min(80, Math.floor(progress.percentage * 0.8));
                upload.progress = adjustedProgress;
                upload.bytesUploaded = progress.bytesUploaded;

                originalOnProgress({
                    percentage: adjustedProgress,
                    bytesUploaded: progress.bytesUploaded
                });

                this.emit('upload-progress', {
                    uploadId: upload.id,
                    progress: adjustedProgress,
                    bytesUploaded: progress.bytesUploaded,
                    totalBytes: upload.totalBytes,
                    statusMessage: 'Uploading to S3...'
                });
            };

            // Perform S3 upload
            const s3Result = await s3Provider.upload(
                s3Account.credentials,
                s3Account.config,
                upload.filePath,
                upload.metadata,
                s3OnProgress
            );

            console.log(`[UploadManager] S3 upload completed, starting SC Player indexing`);

            // Update progress for indexing phase
            upload.progress = 85;
            upload.statusMessage = 'Indexing in StarCapture Player...';
            this.emit('upload-progress', {
                uploadId: upload.id,
                progress: 85,
                statusMessage: 'Indexing in StarCapture Player...'
            });

            // Perform SC Player indexing
            const scPlayerProvider = this.providers.get('sc-player');
            const indexResult = await this.indexInSCPlayer(scPlayerResult, s3Result);

            // Mark as completed
            upload.status = 'completed';
            upload.completedAt = Date.now();
            upload.progress = 100;
            upload.statusMessage = 'Completed';
            upload.result = {
                s3Result,
                scPlayerResult: indexResult,
                videoId: indexResult.videoId,
                viewUrl: indexResult.viewUrl || indexResult.shareUrl,
                publicUrl: indexResult.viewUrl || indexResult.shareUrl || s3Result.location,
                message: indexResult.message || 'Video uploaded to S3 and indexed in StarCapture Player successfully'
            };

            // Update account stats for both accounts
            const originalAccount = this.accounts.get(upload.accountId);
            if (originalAccount) {
                originalAccount.lastUsed = Date.now();
                originalAccount.uploadCount++;
            }

            if (s3Account) {
                s3Account.lastUsed = Date.now();
            }

            await this.saveAccounts();

            this.activeUploads.delete(upload.id);
            this.completedUploads.push(upload);

            // Keep only last 50 completed uploads
            if (this.completedUploads.length > 50) {
                this.completedUploads = this.completedUploads.slice(-50);
            }

            this.emit('upload-completed', upload);
            this.emit('state-changed', this.getState());

            // Save state after upload completes
            await this.saveUploadState();

            // Process next in queue
            this.processQueue();

        } catch (error) {
            console.error(`[UploadManager] S3+Index upload failed:`, error);

            upload.status = 'failed';
            upload.error = error.message;
            upload.completedAt = Date.now();

            this.activeUploads.delete(upload.id);
            this.completedUploads.push(upload);

            this.emit('upload-failed', upload);
            this.emit('state-changed', this.getState());

            await this.saveUploadState();
            this.processQueue();
        }
    }

    /**
     * Index uploaded content in SC Player
     */
    async indexInSCPlayer(scPlayerResult, s3Result) {
        const scPlayerProvider = this.providers.get('sc-player');
        if (!scPlayerProvider) {
            throw new Error('SC Player provider not available');
        }

        const indexData = scPlayerResult.scPlayerIndexData;

        // Get S3 account to access config for URL construction
        const s3Account = this.accounts.get(scPlayerResult.s3AccountId);
        const publicUrl = s3Account?.config?.publicUrl;

        // Build full URLs for metadata and thumbnails
        let s3JsonPath = null;
        let s3MainThumbPath = null;

        if (s3Result.metadataKey && publicUrl) {
            // Remove trailing slash from publicUrl if present
            const baseUrl = publicUrl.replace(/\/$/, '');
            s3JsonPath = `${baseUrl}/${s3Result.metadataKey}`;
        }

        // Find main thumbnail in thumbnailKeys
        if (s3Result.thumbnailKeys && s3Result.thumbnailKeys.length > 0 && publicUrl) {
            const baseUrl = publicUrl.replace(/\/$/, '');
            // Look for main thumbnail (should end with _main_thumb.jpg)
            const mainThumbKey = s3Result.thumbnailKeys.find(key => key.includes('_main_thumb.jpg'));
            if (mainThumbKey) {
                s3MainThumbPath = `${baseUrl}/${mainThumbKey}`;
            }
        }

        // Build video data for indexing
        const videoData = {
            title: indexData.title,
            description: indexData.description,
            characterId: indexData.characterId,
            organizationId: indexData.organizationId,
            privacy: indexData.privacy,
            s3VideoPath: s3Result.location, // Main video file URL from S3
            s3JsonPath: s3JsonPath, // JSON metadata file URL
            s3MainThumbPath: s3MainThumbPath, // Main thumbnail URL
            metadata: {
                includeMetadata: indexData.includeMetadata,
                includeThumbnails: indexData.includeThumbnails,
                s3Bucket: s3Result.bucket,
                s3Key: s3Result.key,
                s3MetadataKey: s3Result.metadataKey,
                s3ThumbnailKeys: s3Result.thumbnailKeys
            }
        };

        console.log(`[UploadManager] SC Player indexing data:`, {
            title: videoData.title,
            s3VideoPath: videoData.s3VideoPath,
            s3JsonPath: videoData.s3JsonPath,
            s3MainThumbPath: videoData.s3MainThumbPath,
            characterId: videoData.characterId
        });

        console.log(`[UploadManager] Indexing video in SC Player:`, videoData.title);

        return await scPlayerProvider.indexVideo(
            indexData.scPlayerCredentials,
            indexData.scPlayerConfig,
            videoData
        );
    }

    /**
     * Cancel an upload
     */
    async cancelUpload(data) {
        const { uploadId } = data;

        // Check if in queue
        const queueIndex = this.uploadQueue.findIndex(u => u.id === uploadId);
        if (queueIndex !== -1) {
            const upload = this.uploadQueue.splice(queueIndex, 1)[0];
            upload.status = 'cancelled';
            this.completedUploads.push(upload);
            this.emit('upload-cancelled', upload);
            this.emit('state-changed', this.getState());
            return { success: true };
        }

        // Check if active
        const upload = this.activeUploads.get(uploadId);
        if (upload) {
            // TODO: Implement provider-specific cancellation
            upload.status = 'cancelled';
            this.activeUploads.delete(uploadId);
            this.completedUploads.push(upload);
            this.emit('upload-cancelled', upload);
            this.emit('state-changed', this.getState());
            return { success: true };
        }

        throw new Error(`Upload ${uploadId} not found`);
    }

    /**
     * Get upload status
     */
    getUploadStatus() {
        return {
            active: Array.from(this.activeUploads.values()),
            queued: this.uploadQueue,
            completed: this.completedUploads.slice(-50)  // Return last 50 instead of just 10
        };
    }

    /**
     * Get complete state
     */
    getState() {
        return {
            initialized: this.initialized,
            accounts: this.listAccounts(),
            providers: Array.from(this.providers.keys()),
            uploads: {
                active: Array.from(this.activeUploads.values()),
                queued: this.uploadQueue,
                completed: this.completedUploads.slice(-50)  // Return last 50 instead of just 10
            },
            queueStatus: {
                paused: this.queuePaused,
                queueLength: this.uploadQueue.length,
                activeUploads: this.activeUploads.size
            }
        };
    }

    /**
     * Generate unique account ID
     */
    generateAccountId() {
        return `acc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    /**
     * Generate unique upload ID
     */
    generateUploadId() {
        return `upl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    }

    /**
     * Start the upload queue processing
     */
    async startQueue() {
        this.queuePaused = false;
        this.emit('log', 'Starting upload queue processing');
        await this.processQueue();
        this.emit('queue-started');
        this.emit('state-changed', this.getState());
        return { success: true };
    }

    /**
     * Pause the upload queue
     */
    async pauseQueue() {
        this.queuePaused = true;
        this.emit('log', 'Pausing upload queue');
        this.emit('queue-paused');
        this.emit('state-changed', this.getState());
        return { success: true };
    }

    /**
     * Get queue status
     */
    getQueueStatus() {
        return {
            paused: this.queuePaused,
            queueLength: this.uploadQueue.length,
            activeUploads: this.activeUploads.size
        };
    }

    /**
     * Clear completed uploads
     */
    async clearCompleted() {
        this.completedUploads = [];
        await this.saveUploadState();
        this.emit('state-changed', this.getState());
        return { success: true };
    }

    /**
     * Remove upload from queue
     */
    async removeFromQueue(data) {
        const { uploadId } = data;
        this.emit('log', `Removing upload from queue: ${uploadId}`);
        const index = this.uploadQueue.findIndex(u => u.id === uploadId);
        if (index !== -1) {
            this.uploadQueue.splice(index, 1);
            await this.saveUploadState();
            this.emit('state-changed', this.getState());
            this.emit('log', `Successfully removed upload ${uploadId} from queue`);
            return { success: true };
        }
        this.emit('log', `Upload ${uploadId} not found in queue`);
        return { success: false, error: 'Upload not found in queue' };
    }

    /**
     * Remove completed upload
     */
    async removeCompleted(data) {
        const { uploadId } = data;
        this.emit('log', `Removing completed upload: ${uploadId}`);
        const index = this.completedUploads.findIndex(u => u.id === uploadId);
        if (index !== -1) {
            this.completedUploads.splice(index, 1);
            await this.saveUploadState();
            this.emit('state-changed', this.getState());
            this.emit('log', `Successfully removed completed upload ${uploadId}`);
            return { success: true };
        }
        this.emit('log', `Completed upload ${uploadId} not found`);
        return { success: false, error: 'Upload not found in completed list' };
    }

    /**
     * Load upload queue state
     */
    async loadUploadState() {
        try {
            const exists = await fs.access(this.uploadStatePath).then(() => true).catch(() => false);
            if (!exists) {
                this.emit('log', 'No existing upload state file found');
                return;
            }

            const data = await fs.readFile(this.uploadStatePath, 'utf8');
            const state = JSON.parse(data);

            // Restore queued uploads (not active ones as they would have failed)
            if (state.queued && Array.isArray(state.queued)) {
                this.uploadQueue = state.queued.filter(upload => {
                    // Only restore if the file still exists
                    try {
                        require('fs').statSync(upload.filePath);
                        return true;
                    } catch {
                        return false;
                    }
                });
            }

            // Restore completed uploads history
            if (state.completed && Array.isArray(state.completed)) {
                this.completedUploads = state.completed.slice(-50); // Keep last 50
            }

            this.emit('log', `Restored ${this.uploadQueue.length} queued uploads and ${this.completedUploads.length} completed uploads`);
        } catch (error) {
            this.emit('error', `Failed to load upload state: ${error.message}`);
        }
    }

    /**
     * Save upload queue state
     */
    async saveUploadState() {
        try {
            const state = {
                queued: this.uploadQueue,
                completed: this.completedUploads.slice(-50), // Keep last 50
                savedAt: Date.now()
            };

            await fs.writeFile(this.uploadStatePath, JSON.stringify(state, null, 2));
        } catch (error) {
            this.emit('error', `Failed to save upload state: ${error.message}`);
        }
    }

    /**
     * Shutdown the manager
     */
    async shutdown() {
        // Save upload state before shutdown
        await this.saveUploadState();

        // Cancel all active uploads
        for (const uploadId of this.activeUploads.keys()) {
            await this.cancelUpload({ uploadId });
        }

        // Clear queue
        this.uploadQueue = [];

        await super.shutdown();
    }
}

module.exports = UploadManager;