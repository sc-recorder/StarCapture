const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
// AWS SDK no longer needed - server handles S3 completion

/**
 * StarCapture Player Provider
 * Handles integration with the SC Player backend API
 */
class SCPlayerProvider {
    constructor() {
        this.name = 'sc-player';
        this.displayName = 'StarCapture Player';
        this.defaultBaseUrl = 'https://api.starcapture.video/api';
        this.limitsCache = null;
        this.limitsCacheTime = null;
        this.limitsCacheTTL = 5 * 60 * 1000; // 5 minutes

        // Session management to prevent concurrent uploads
        this.currentSession = null;
        this.uploadInProgress = false;
    }

    /**
     * Get current upload status
     */
    getUploadStatus() {
        return {
            uploadInProgress: this.uploadInProgress,
            currentSessionId: this.currentSession ? this.currentSession.session_id : null
        };
    }

    /**
     * Force cancel the current upload
     */
    async forceCancel(credentials, config) {
        console.log('[SCPlayerProvider] Force canceling current upload');

        if (this.currentSession) {
            await this.cancelSession(credentials, config, this.currentSession.session_id);
        }

        this.currentSession = null;
        this.uploadInProgress = false;

        console.log('[SCPlayerProvider] Upload canceled and state reset');
    }

    /**
     * Cancel/cleanup an existing upload session
     */
    async cancelSession(credentials, config, sessionId) {
        if (!sessionId) return;

        try {
            console.log(`[SCPlayerProvider] Canceling session: ${sessionId}`);
            await this.makeApiRequest(`/companion/upload/session/${sessionId}`, {
                apiKey: credentials.apiKey,
                baseUrl: config.baseUrl || this.defaultBaseUrl,
                method: 'DELETE'
            });
            console.log(`[SCPlayerProvider] Session ${sessionId} canceled successfully`);
        } catch (error) {
            console.warn(`[SCPlayerProvider] Failed to cancel session ${sessionId}:`, error.message);
        }
    }

    /**
     * Make an API request to SC Player backend
     */
    async makeApiRequest(endpoint, options = {}) {
        const { apiKey, baseUrl = this.defaultBaseUrl, method = 'GET', body = null } = options;

        // Ensure endpoint starts with /
        const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;

        // For baseUrl ending with /api, construct the full URL properly
        let fullUrl;
        if (baseUrl.endsWith('/api')) {
            fullUrl = baseUrl + cleanEndpoint;
        } else if (baseUrl.endsWith('/')) {
            fullUrl = baseUrl + 'api' + cleanEndpoint;
        } else {
            fullUrl = baseUrl + '/api' + cleanEndpoint;
        }

        const url = new URL(fullUrl);

        return new Promise((resolve, reject) => {
            const requestOptions = {
                method,
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            };

            const req = https.request(url, requestOptions, (res) => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    console.log(`[SCPlayerProvider] Response status: ${res.statusCode}`);

                    // Always log response details for errors, regardless of JSON parsing
                    if (res.statusCode >= 400) {
                        console.error(`[SCPlayerProvider] ===== HTTP ERROR ${res.statusCode} =====`);
                        console.error(`[SCPlayerProvider] URL: ${method} ${url.pathname}`);
                        console.error(`[SCPlayerProvider] Raw response: ${data}`);
                        console.error(`[SCPlayerProvider] ===========================`);
                    }

                    try {
                        const parsed = JSON.parse(data);

                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            // Enhanced error logging for server errors
                            console.error(`[SCPlayerProvider] API Error ${res.statusCode} - Parsed response:`, JSON.stringify(parsed, null, 2));

                            const errorMsg = parsed.error?.message || parsed.message || `API error: ${res.statusCode}`;
                            const errorDetails = parsed.error?.details || parsed.details || 'No additional details';

                            const fullErrorMsg = `${errorMsg} (Details: ${errorDetails})`;
                            reject(new Error(fullErrorMsg));
                        }
                    } catch (parseError) {
                        // Log raw response if JSON parsing fails
                        console.error(`[SCPlayerProvider] JSON Parse Error for ${res.statusCode}:`, parseError.message);
                        console.error(`[SCPlayerProvider] Raw response (first 500 chars):`, data.substring(0, 500));

                        if (res.statusCode >= 400) {
                            reject(new Error(`Server error ${res.statusCode}: ${data.substring(0, 200)}`));
                        } else {
                            reject(new Error(`Failed to parse response: ${parseError.message}. Raw response: ${data.substring(0, 200)}`));
                        }
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            if (body) {
                const requestBody = JSON.stringify(body);
                req.write(requestBody);
            }

            req.end();
        });
    }

    /**
     * Get upload limits from server with caching
     */
    async getUploadLimits(credentials, config = {}) {
        // Check cache first
        if (this.limitsCache && this.limitsCacheTime &&
            (Date.now() - this.limitsCacheTime) < this.limitsCacheTTL) {
            console.log('[SCPlayerProvider] Using cached upload limits');
            return this.limitsCache;
        }

        console.log('[SCPlayerProvider] Fetching upload limits from server');

        try {
            const limits = await this.makeApiRequest('/upload/limits', {
                apiKey: credentials.apiKey,
                baseUrl: config.baseUrl,
                method: 'GET'
            });

            // Cache the limits
            this.limitsCache = limits;
            this.limitsCacheTime = Date.now();

            console.log('[SCPlayerProvider] Upload limits fetched:', JSON.stringify(limits, null, 2));
            return limits;
        } catch (error) {
            console.error('[SCPlayerProvider] Failed to fetch upload limits:', error.message);

            // Return default limits if server doesn't support the endpoint yet
            const defaultLimits = {
                max_file_sizes: {
                    video: 5368709120, // 5GB
                    events_json: 104857600, // 100MB
                    main_thumbnail: 10485760, // 10MB
                    event_thumbnail: 10485760 // 10MB
                },
                multipart_threshold: 5368709120, // 5GB
                part_size: 104857600, // 100MB
                max_parts_per_file: 10000
            };

            console.log('[SCPlayerProvider] Using default limits due to server error');
            return defaultLimits;
        }
    }

    /**
     * Validate API key and get account information
     * Returns detailed information about characters, orgs, and storage
     */
    async validateAccount(credentials, config = {}) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;

        console.log('[SCPlayerProvider] validateAccount called with baseUrl:', baseUrl);

        if (!apiKey) {
            throw new Error('API key is required');
        }

        if (!apiKey.startsWith('scplayer_')) {
            throw new Error('Invalid API key format. Must start with "scplayer_"');
        }

        console.log('[SCPlayerProvider] API key format valid, making API requests...');

        try {
            // First try the companion-specific endpoints that require API key auth
            console.log('[SCPlayerProvider] Fetching posting contexts from /companion/user/posting-contexts...');
            const contextsResponse = await this.makeApiRequest('/companion/user/posting-contexts', {
                apiKey,
                baseUrl
            });
            console.log('[SCPlayerProvider] Contexts response received');

            // Fetch storage quota information for API key users
            console.log('[SCPlayerProvider] Fetching storage quota from /companion/user/quota...');
            let quotaInfo = null;
            try {
                quotaInfo = await this.makeApiRequest('/companion/user/quota', {
                    apiKey,
                    baseUrl
                });
                console.log('[SCPlayerProvider] Quota info received:', quotaInfo);
            } catch (quotaError) {
                console.log('[SCPlayerProvider] Could not fetch quota info:', quotaError.message);
            }

            // Calculate summary information
            // The posting contexts response has availableContexts array
            const availableContexts = contextsResponse.data?.availableContexts || contextsResponse.availableContexts || [];
            console.log('[SCPlayerProvider] Found availableContexts:', availableContexts.length);

            // Extract character from the context (there's one character per context)
            const characters = availableContexts
                .map(ctx => ctx.character)
                .filter(Boolean);
            console.log('[SCPlayerProvider] Found characters:', characters.length, characters.map(c => c.handle));

            // Extract all organizations from all characters
            const allOrgs = availableContexts.flatMap(ctx => {
                // Organizations are nested under character.organizations
                return ctx.character?.organizations || [];
            });
            console.log('[SCPlayerProvider] Found all character organizations:', allOrgs.length);

            // Also get the unique organizations from the list
            const uniqueOrgIds = [...new Set(allOrgs.map(org => org.organization?.id || org.organizationId).filter(Boolean))];
            console.log('[SCPlayerProvider] Unique organizations:', uniqueOrgIds.length);

            // Extract storage quota information if available
            const storageUsed = quotaInfo?.used_bytes || 0;
            const storageQuota = quotaInfo?.quota_bytes || 0;
            const hasStorage = quotaInfo?.has_quota || false;

            console.log('[SCPlayerProvider] Storage info - Used:', storageUsed, 'Quota:', storageQuota, 'Has storage:', hasStorage);

            // Extract username from first character or use API key identifier
            const username = characters.length > 0 && characters[0].handle
                ? characters[0].handle
                : 'API Key User';

            const summary = {
                valid: true,
                accountInfo: {
                    username: username,
                    email: null, // Not available for API key users
                    accountTier: 'api', // API key users
                    characterCount: characters.length,
                    organizationCount: uniqueOrgIds.length,
                    storageUsedBytes: storageUsed,
                    storageQuotaBytes: storageQuota,
                    hasStorage,
                    storageUsedFormatted: this.formatBytes(storageUsed),
                    storageQuotaFormatted: this.formatBytes(storageQuota),
                    storagePercentage: storageQuota > 0 ? Math.round((storageUsed / storageQuota) * 100) : 0,
                    characters: characters,
                    organizations: allOrgs.map(o => o.organization || o) // Extract the organization object
                }
            };

            console.log('[SCPlayerProvider] Final summary:', JSON.stringify(summary, null, 2));
            return summary;
        } catch (error) {
            console.error('[SCPlayerProvider] Validation failed:', error);
            console.error('[SCPlayerProvider] Error details:', {
                message: error.message,
                stack: error.stack
            });

            // Try basic health check if detailed info fails
            console.log('[SCPlayerProvider] Trying fallback health check...');
            try {
                // Note: /health endpoint is available both at root and under /api
                const healthResponse = await this.makeApiRequest('/health', { apiKey, baseUrl });
                console.log('[SCPlayerProvider] Health check response:', healthResponse);

                return {
                    valid: true,
                    accountInfo: {
                        username: 'Connected',
                        characterCount: 0,
                        organizationCount: 0,
                        storageUsedBytes: 0,
                        storageQuotaBytes: 0,
                        hasStorage: false,
                        error: 'Could not fetch detailed information'
                    }
                };
            } catch (healthError) {
                console.error('[SCPlayerProvider] Health check also failed:', healthError);
                throw new Error(`Authentication failed: ${error.message}`);
            }
        }
    }

    /**
     * Get posting contexts (characters and organizations)
     */
    async getPostingContexts(credentials, config = {}) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;

        try {
            const response = await this.makeApiRequest('/companion/user/posting-contexts', {
                apiKey,
                baseUrl
            });

            return response.data || response || [];
        } catch (error) {
            console.error('[SCPlayerProvider] Failed to fetch posting contexts:', error);
            throw error;
        }
    }

    /**
     * Index a video that's already uploaded to S3
     */
    async indexVideo(credentials, config, videoData) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;

        // Build request body - only include JSON path if it exists
        const requestBody = {
            title: videoData.title,
            description: videoData.description || '',
            s3VideoPath: videoData.s3VideoPath,
            privacy: videoData.privacy || 'public',
            characterId: videoData.characterId,
            metadata: videoData.metadata || {}
        };

        // Only include optional S3 paths if they exist
        if (videoData.s3JsonPath) {
            requestBody.s3JsonPath = videoData.s3JsonPath;
        }

        if (videoData.s3MainThumbPath) {
            requestBody.s3MainThumbPath = videoData.s3MainThumbPath;
        }

        if (videoData.organizationId) {
            requestBody.organizationId = videoData.organizationId;
        }


        try {
            const response = await this.makeApiRequest('/companion/videos', {
                apiKey,
                baseUrl,
                method: 'POST',
                body: requestBody
            });

            console.log('[SCPlayerProvider] Index video API response:', JSON.stringify(response, null, 2));

            const videoId = response.data?.video?.id || response.data?.id || response.video?.id;
            const shareUrl = response.data?.shareUrl || response.shareUrl;

            // Use the direct share URL from the API response
            let viewUrl = shareUrl;
            if (!viewUrl && videoId) {
                // Fallback: construct URL if no direct share URL
                const basePlayerUrl = baseUrl.replace('/api', '').replace(':8443', ':3000');
                viewUrl = `${basePlayerUrl}/watch?v=${videoId}`;
            }

            return {
                success: true,
                videoId: videoId,
                shareUrl: shareUrl,
                viewUrl: viewUrl,
                message: videoId ? `Video indexed successfully with ID: ${videoId}` : 'Video indexed successfully'
            };
        } catch (error) {
            console.error('[SCPlayerProvider] Failed to index video:', error);
            throw error;
        }
    }

    /**
     * Create upload session for direct upload
     */
    async createUploadSession(credentials, config, sessionData) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;

        try {
            const response = await this.makeApiRequest('/companion/upload/session', {
                apiKey,
                baseUrl,
                method: 'POST',
                body: sessionData
            });

            return response;
        } catch (error) {
            console.error('[SCPlayerProvider] Failed to create upload session:', error);
            throw error;
        }
    }

    /**
     * Format bytes to human readable format
     */
    formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 B';

        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];

        const i = Math.floor(Math.log(bytes) / Math.log(k));

        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }


    /**
     * Upload video to SC Player
     * Handles both direct upload (if storage available) and S3-index flow
     */
    async upload(credentials, config, filePath, metadata = {}, onProgress) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;

        // Validate required metadata
        if (!metadata.characterId) {
            throw new Error('Character ID is required for SC Player upload');
        }

        // Check upload method
        if (metadata.uploadMethod === 'direct') {
            // Direct upload to SC Player (if account has storage quota)
            return await this.directUpload(credentials, config, filePath, metadata, onProgress);
        } else if (metadata.uploadMethod === 's3-index') {
            // S3 upload with indexing - delegate to S3 provider first
            if (!metadata.s3AccountId) {
                throw new Error('S3 account ID is required for S3 + indexing upload method');
            }

            return await this.s3IndexUpload(credentials, config, filePath, metadata, onProgress);
        } else {
            throw new Error('Unknown upload method: ' + metadata.uploadMethod);
        }
    }

    /**
     * S3 upload with indexing - delegates to S3 provider then indexes the result
     */
    async s3IndexUpload(credentials, config, filePath, metadata, onProgress) {
        // For S3 + indexing flow, we need to:
        // 1. Signal that this should be handled as an S3 upload with post-upload indexing
        // 2. Return metadata that the upload manager can use to trigger indexing after S3 upload

        return {
            success: true,
            requiresS3Upload: true,
            s3AccountId: metadata.s3AccountId,
            postUploadAction: 'sc-player-index',
            scPlayerIndexData: {
                scPlayerCredentials: credentials,
                scPlayerConfig: config,
                title: metadata.title,
                description: metadata.description,
                characterId: metadata.characterId,
                organizationId: metadata.organizationId,
                privacy: metadata.privacy || 'public',
                includeMetadata: metadata.includeMetadata,
                includeThumbnails: metadata.includeThumbnails,
                mainThumbnailPath: metadata.mainThumbnailPath
            },
            message: 'Upload will be processed via S3 with automatic StarCapture Player indexing'
        };
    }

    /**
     * Validate that all required files exist for direct upload
     */
    validateRequiredFiles(videoPath, limits = null) {
        const baseName = path.basename(videoPath, path.extname(videoPath));
        const dir = path.dirname(videoPath);

        // Expected file paths
        const jsonPath = path.join(dir, `${baseName}.json`);
        const mainThumbPath = path.join(dir, `${baseName}_main_thumb.jpg`);
        const thumbsDir = path.join(dir, `${baseName}_thumbs`);

        console.log('[SCPlayerProvider] Validating required files for:', videoPath);
        console.log('[SCPlayerProvider] Expected JSON path:', jsonPath);
        console.log('[SCPlayerProvider] Expected main thumb:', mainThumbPath);
        console.log('[SCPlayerProvider] Expected thumbs dir:', thumbsDir);

        // Check video file
        if (!fs.existsSync(videoPath)) {
            return { valid: false, error: 'Video file not found' };
        }

        // Check video file size against server limits
        const videoStats = fs.statSync(videoPath);
        const videoSizeGB = videoStats.size / (1024 * 1024 * 1024);

        if (limits && limits.max_file_sizes && videoStats.size > limits.max_file_sizes.video) {
            const maxVideoSizeGB = (limits.max_file_sizes.video / 1024 / 1024 / 1024).toFixed(2);
            return {
                valid: false,
                error: `Video file is ${videoSizeGB.toFixed(2)}GB, which exceeds the ${maxVideoSizeGB}GB limit for direct upload. Please use the video editor to split or trim the video before uploading.`
            };
        }

        // Check JSON file (REQUIRED)
        if (!fs.existsSync(jsonPath)) {
            return {
                valid: false,
                error: 'Events JSON not found. This file is required for direct upload to SC Player.'
            };
        }

        // Check main thumbnail (REQUIRED)
        if (!fs.existsSync(mainThumbPath)) {
            return {
                valid: false,
                error: 'Main thumbnail not found. Generate thumbnails before using direct upload.'
            };
        }

        // Check main thumbnail size against server limits
        const mainThumbStats = fs.statSync(mainThumbPath);
        const mainThumbSizeMB = mainThumbStats.size / (1024 * 1024);

        if (limits && limits.max_file_sizes && mainThumbStats.size > limits.max_file_sizes.main_thumbnail) {
            const maxThumbSizeMB = (limits.max_file_sizes.main_thumbnail / 1024 / 1024).toFixed(2);
            return {
                valid: false,
                error: `Main thumbnail is ${mainThumbSizeMB.toFixed(2)}MB, which exceeds the ${maxThumbSizeMB}MB limit. Please regenerate thumbnails.`
            };
        }

        // Check event thumbnails directory
        if (!fs.existsSync(thumbsDir)) {
            return {
                valid: false,
                error: 'Event thumbnails directory not found. Generate thumbnails before using direct upload.'
            };
        }

        // Get all event thumbnails (REQUIRED - must have at least one)
        const eventThumbnails = fs.readdirSync(thumbsDir)
            .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
            .map(f => path.join(thumbsDir, f));

        if (eventThumbnails.length === 0) {
            return {
                valid: false,
                error: 'No event thumbnails found. Event thumbnails are required for direct upload.'
            };
        }

        // Check each event thumbnail size against server limits
        for (const thumbPath of eventThumbnails) {
            const thumbStats = fs.statSync(thumbPath);
            const thumbSizeMB = thumbStats.size / (1024 * 1024);

            if (limits && limits.max_file_sizes && thumbStats.size > limits.max_file_sizes.event_thumbnail) {
                const maxEventThumbSizeMB = (limits.max_file_sizes.event_thumbnail / 1024 / 1024).toFixed(2);
                const thumbName = path.basename(thumbPath);
                return {
                    valid: false,
                    error: `Event thumbnail ${thumbName} is ${thumbSizeMB.toFixed(2)}MB, which exceeds the ${maxEventThumbSizeMB}MB limit. Please regenerate thumbnails.`
                };
            }
        }

        // Collect file sizes for all files
        const jsonStats = fs.statSync(jsonPath);
        const eventThumbnailSizes = eventThumbnails.map(thumbPath => ({
            filename: path.basename(thumbPath),
            size: fs.statSync(thumbPath).size
        }));

        const fileSizes = {
            video: videoStats.size,
            events_json: jsonStats.size,
            main_thumbnail: mainThumbStats.size,
            event_thumbnails: eventThumbnailSizes
        };

        console.log(`[SCPlayerProvider] Validation passed - found ${eventThumbnails.length} event thumbnails`);

        return {
            valid: true,
            videoPath,
            jsonPath,
            mainThumbPath,
            eventThumbnails,
            videoSizeGB: videoSizeGB,
            mainThumbSizeMB: mainThumbSizeMB,
            fileSizes: fileSizes
        };
    }

    /**
     * Validate file sizes against server limits
     */
    validateFileSizes(fileSizes, maxFileSizes) {
        console.log('[SCPlayerProvider] Validating file sizes against server limits');
        console.log('[SCPlayerProvider] Max file sizes:', JSON.stringify(maxFileSizes, null, 2));

        // Check video size
        if (fileSizes.video > maxFileSizes.video) {
            const videoSizeGB = (fileSizes.video / 1024 / 1024 / 1024).toFixed(2);
            const maxVideoSizeGB = (maxFileSizes.video / 1024 / 1024 / 1024).toFixed(2);
            return {
                valid: false,
                error: `Video file is ${videoSizeGB}GB, which exceeds the ${maxVideoSizeGB}GB limit. Please use the video editor to split or trim the video.`
            };
        }

        // Check JSON size
        if (fileSizes.events_json > maxFileSizes.events_json) {
            const jsonSizeMB = (fileSizes.events_json / 1024 / 1024).toFixed(2);
            const maxJsonSizeMB = (maxFileSizes.events_json / 1024 / 1024).toFixed(2);
            return {
                valid: false,
                error: `Events JSON is ${jsonSizeMB}MB, which exceeds the ${maxJsonSizeMB}MB limit.`
            };
        }

        // Check main thumbnail size
        if (fileSizes.main_thumbnail > maxFileSizes.main_thumbnail) {
            const thumbSizeMB = (fileSizes.main_thumbnail / 1024 / 1024).toFixed(2);
            const maxThumbSizeMB = (maxFileSizes.main_thumbnail / 1024 / 1024).toFixed(2);
            return {
                valid: false,
                error: `Main thumbnail is ${thumbSizeMB}MB, which exceeds the ${maxThumbSizeMB}MB limit. Please regenerate thumbnails.`
            };
        }

        // Check each event thumbnail size
        for (const eventThumb of fileSizes.event_thumbnails) {
            if (eventThumb.size > maxFileSizes.event_thumbnail) {
                const thumbSizeMB = (eventThumb.size / 1024 / 1024).toFixed(2);
                const maxThumbSizeMB = (maxFileSizes.event_thumbnail / 1024 / 1024).toFixed(2);
                return {
                    valid: false,
                    error: `Event thumbnail ${eventThumb.filename} is ${thumbSizeMB}MB, which exceeds the ${maxThumbSizeMB}MB limit. Please regenerate thumbnails.`
                };
            }
        }

        console.log('[SCPlayerProvider] All file sizes are within limits');
        return { valid: true };
    }

    /**
     * Upload a file to a presigned URL
     */
    async uploadFileToPresignedUrl(url, filePath, headers = {}, onProgress) {
        const fileName = path.basename(filePath);
        console.log(`[SCPlayerProvider] [${fileName}] Starting upload to presigned URL`);

        return new Promise((resolve, reject) => {
            const stats = fs.statSync(filePath);
            const fileSize = stats.size;
            const stream = fs.createReadStream(filePath);
            const urlObj = new URL(url);

            let uploadedBytes = 0;
            let lastProgressTime = Date.now();
            let requestStartTime = Date.now();

            // Use headers exactly as provided by server (server now includes Content-Length)
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'PUT',
                headers: headers
            };


            const req = https.request(options, (res) => {
                const responseStartTime = Date.now();
                const requestDuration = responseStartTime - requestStartTime;

                let responseData = '';

                res.on('data', chunk => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    const totalDuration = Date.now() - requestStartTime;
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        console.log(`[SCPlayerProvider] [${fileName}] File upload successful: ${res.statusCode}`);
                        resolve({ success: true });
                    } else {
                        console.error(`[SCPlayerProvider] [${fileName}] File upload failed: ${res.statusCode}`, responseData);
                        reject(new Error(`Upload failed with status ${res.statusCode}: ${responseData}`));
                    }
                });
            });

            // Set longer timeout for large file uploads
            req.setTimeout(300000, () => { // 5 minute timeout
                const timeoutDuration = Date.now() - requestStartTime;
                console.error(`[SCPlayerProvider] [${fileName}] Upload request timeout after ${timeoutDuration}ms (5 minute limit)`);
                req.destroy();
                reject(new Error('Upload timeout after 5 minutes'));
            });

            req.on('error', (error) => {
                const errorDuration = Date.now() - requestStartTime;
                console.error(`[SCPlayerProvider] [${fileName}] Upload request error after ${errorDuration}ms:`, error);
                reject(error);
            });

            req.on('connect', () => {
                console.log(`[SCPlayerProvider] [${fileName}] Connected to server`);
            });

            req.on('socket', (socket) => {
                socket.on('error', (error) => {
                    console.error(`[SCPlayerProvider] [${fileName}] Socket error:`, error);
                });

                socket.on('timeout', () => {
                    console.error(`[SCPlayerProvider] [${fileName}] Socket timeout`);
                });
            });

            stream.on('data', (chunk) => {
                uploadedBytes += chunk.length;
                const progress = (uploadedBytes / fileSize) * 100;

                if (onProgress) {
                    onProgress(progress);
                }
            });

            stream.on('error', (error) => {
                console.error(`[SCPlayerProvider] [${fileName}] File read error:`, error);
                reject(error);
            });

            requestStartTime = Date.now();
            stream.pipe(req);
        });
    }

    /**
     * Upload file using multipart upload (for files >5GB)
     */
    async uploadMultipart(sessionFile, filePath, fileSize, onProgress, credentials, config) {
        console.log(`[SCPlayerProvider] uploadMultipart called with sessionFile:`, JSON.stringify(sessionFile, null, 2));

        // Validate multipart upload properties
        if (!sessionFile || typeof sessionFile !== 'object') {
            throw new Error('Invalid sessionFile object for multipart upload');
        }

        const { multipart_upload_id, file_key, multipart_parts } = sessionFile;

        // Validate required multipart properties
        if (!multipart_upload_id) {
            throw new Error('Missing multipart_upload_id for multipart upload');
        }
        if (!file_key) {
            throw new Error('Missing file_key for multipart upload');
        }
        if (!Array.isArray(multipart_parts) || multipart_parts.length === 0) {
            throw new Error(`Invalid or empty multipart_parts array for multipart upload. Expected array, got: ${typeof multipart_parts}`);
        }

        console.log(`[SCPlayerProvider] Starting multipart upload - ${multipart_parts.length} parts`);
        console.log(`[SCPlayerProvider] File key: ${file_key}`);
        console.log(`[SCPlayerProvider] Upload ID: ${multipart_upload_id}`);

        const completedParts = [];
        let uploadedBytes = 0;

        // Upload parts with controlled concurrency (max 4 concurrent)
        const CONCURRENT_PARTS = 4;

        for (let i = 0; i < multipart_parts.length; i += CONCURRENT_PARTS) {
            const partBatch = multipart_parts.slice(i, i + CONCURRENT_PARTS);
            console.log(`[SCPlayerProvider] Uploading part batch ${Math.floor(i / CONCURRENT_PARTS) + 1} (parts ${i + 1}-${Math.min(i + CONCURRENT_PARTS, multipart_parts.length)} of ${multipart_parts.length})`);

            const batchPromises = partBatch.map(async (part) => {
                try {
                    const partResult = await this.uploadPart(part, filePath, fileSize, sessionFile);
                    uploadedBytes += this.getPartSize(part, fileSize, sessionFile.multipart_part_size, sessionFile.multipart_total_parts);

                    // Update progress
                    if (onProgress) {
                        const progress = (uploadedBytes / fileSize) * 100;
                        onProgress(progress);
                    }

                    return partResult;
                } catch (error) {
                    console.error(`[SCPlayerProvider] Failed to upload part ${part.part_number}:`, error.message);
                    throw error;
                }
            });

            const batchResults = await Promise.all(batchPromises);
            completedParts.push(...batchResults);
        }

        // Sort completed parts by part number
        completedParts.sort((a, b) => a.PartNumber - b.PartNumber);

        console.log(`[SCPlayerProvider] All ${completedParts.length} parts uploaded successfully`);

        // Complete multipart upload via server
        const result = await this.completeMultipartUploadViaServer(sessionFile, completedParts, credentials, config);

        console.log(`[SCPlayerProvider] Multipart upload completed via server`);
        return { multipart_upload: true, total_parts: completedParts.length };
    }

    /**
     * Upload a single part of a multipart upload
     */
    async uploadPart(part, filePath, totalFileSize, sessionFile) {
        return new Promise((resolve, reject) => {
            const partSize = this.getPartSize(part, totalFileSize, sessionFile.multipart_part_size, sessionFile.multipart_total_parts);
            const startByte = (part.part_number - 1) * partSize;

            // Create stream for this part only
            const stream = fs.createReadStream(filePath, {
                start: startByte,
                end: startByte + partSize - 1
            });

            const urlObj = new URL(part.url);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'PUT',
                headers: part.headers
            };


            const req = https.request(options, (res) => {
                let responseData = '';

                res.on('data', chunk => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        const etag = res.headers.etag;
                        console.log(`[SCPlayerProvider] Part ${part.part_number} uploaded successfully, ETag: ${etag}`);
                        resolve({
                            PartNumber: part.part_number,
                            ETag: etag
                        });
                    } else {
                        console.error(`[SCPlayerProvider] Part ${part.part_number} upload failed: ${res.statusCode}`, responseData);
                        reject(new Error(`Part upload failed with status ${res.statusCode}: ${responseData}`));
                    }
                });
            });

            req.on('error', (error) => {
                console.error(`[SCPlayerProvider] Part ${part.part_number} request error:`, error);
                reject(error);
            });

            stream.pipe(req);
        });
    }

    /**
     * Get the size of a part based on part number and total file size
     * Uses server-provided part size when available
     */
    getPartSize(part, totalFileSize, serverPartSize = null, totalParts = null) {
        // Use server-provided part size or fall back to default
        const partSize = serverPartSize || (100 * 1024 * 1024); // 100MB fallback
        const numParts = totalParts || Math.ceil(totalFileSize / partSize);

        if (part.part_number === numParts) {
            // Last part - might be smaller
            return totalFileSize - ((numParts - 1) * partSize);
        }

        return partSize;
    }

    /**
     * Complete multipart upload via server endpoint
     */
    async completeMultipartUploadViaServer(sessionFile, completedParts, credentials, config) {
        console.log(`[SCPlayerProvider] Completing multipart upload via server`);
        console.log(`[SCPlayerProvider] File ID: ${sessionFile.file_id}`);
        console.log(`[SCPlayerProvider] Upload ID: ${sessionFile.multipart_upload_id}`);
        console.log(`[SCPlayerProvider] Completed parts: ${completedParts.length}`);

        // Prepare parts data for server (convert from S3 format to server format)
        const serverParts = completedParts.map(part => ({
            part_number: part.PartNumber,
            etag: part.ETag
        }));

        // Sort parts by part number
        serverParts.sort((a, b) => a.part_number - b.part_number);

        const payload = {
            file_id: sessionFile.file_id,
            parts: serverParts
        };

        console.log(`[SCPlayerProvider] Sending completion request with ${serverParts.length} parts`);

        try {
            const response = await this.makeApiRequest(`/companion/upload/session/${this.currentSession.session_id}/complete`, {
                apiKey: credentials.apiKey,
                baseUrl: config.baseUrl || this.defaultBaseUrl,
                method: 'POST',
                body: payload
            });

            console.log(`[SCPlayerProvider] Server completion successful`);
            return response;
        } catch (error) {
            console.error('[SCPlayerProvider] Failed to complete multipart upload via server:', error.message);
            throw new Error(`Failed to complete multipart upload via server: ${error.message}`);
        }
    }

    /**
     * Notify server that a file upload is complete
     */
    async notifyFileCompletion(credentials, config, sessionId, fileId, uploadResult = {}) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;


        // Build notification payload based on backend expansion spec
        const notificationPayload = {
            file_id: fileId,
            status: 'completed',
            message: 'Upload completed successfully'
        };

        // Add enhanced metadata if available (Phase 2)
        if (uploadResult.s3_location) {
            notificationPayload.s3_location = uploadResult.s3_location;
        }

        if (uploadResult.s3_etag) {
            notificationPayload.s3_etag = uploadResult.s3_etag;
        }

        if (uploadResult.multipart_upload !== undefined) {
            notificationPayload.metadata = {
                multipart_upload: uploadResult.multipart_upload,
                upload_duration_ms: Date.now() - (uploadResult.start_time || Date.now()),
                retry_count: 0
            };

            if (uploadResult.total_parts) {
                notificationPayload.metadata.total_parts = uploadResult.total_parts;
            }
        }

        try {
            const response = await this.makeApiRequest(`/companion/upload/session/${sessionId}/notify`, {
                apiKey,
                baseUrl,
                method: 'POST',
                body: notificationPayload
            });

            console.log('[SCPlayerProvider] File completion notification response:', response);
            return response;
        } catch (error) {
            console.error('[SCPlayerProvider] Failed to notify file completion:', error);
            throw error;
        }
    }

    /**
     * Map local files to session upload files
     */
    mapFilesToSession(validation, sessionFiles) {
        const fileMap = [];

        // Map video file
        const videoFile = sessionFiles.find(f => f.file_type === 'video');
        if (videoFile) {
            fileMap.push({
                localPath: validation.videoPath,
                sessionFile: videoFile
            });
        }

        // Map JSON file
        const jsonFile = sessionFiles.find(f => f.file_type === 'events_json');
        if (jsonFile) {
            fileMap.push({
                localPath: validation.jsonPath,
                sessionFile: jsonFile
            });
        }

        // Map main thumbnail
        const thumbnailFile = sessionFiles.find(f => f.file_type === 'main_thumbnail');
        if (thumbnailFile) {
            fileMap.push({
                localPath: validation.mainThumbPath,
                sessionFile: thumbnailFile
            });
        }

        // Map event thumbnails using event IDs instead of array indices
        const eventThumbFiles = sessionFiles.filter(f => f.file_type === 'event_thumbnail');

        // Check if server is sending file_key field
        const hasFileKeys = eventThumbFiles.some(f => f.file_key);
        if (!hasFileKeys) {
            // Fallback to array index mapping if server hasn't implemented file_key yet
            validation.eventThumbnails.forEach((thumbPath, index) => {
                if (eventThumbFiles[index]) {
                    fileMap.push({
                        localPath: thumbPath,
                        sessionFile: eventThumbFiles[index]
                    });
                }
            });
        } else {
            // Use event ID mapping when server provides file_key
            eventThumbFiles.forEach(serverThumbFile => {
                const fileKey = serverThumbFile.file_key;
                if (!fileKey) {
                    console.warn(`[SCPlayerProvider] Event thumbnail missing file_key:`, serverThumbFile.file_id);
                    return;
                }

                // Extract event ID from file_key (remove extension if present)
                const eventId = path.basename(fileKey, path.extname(fileKey));

                // Find matching local thumbnail file by event ID
                const matchingThumbPath = validation.eventThumbnails.find(thumbPath => {
                    const fileName = path.basename(thumbPath, path.extname(thumbPath));
                    return fileName === eventId;
                });

                if (matchingThumbPath) {
                    fileMap.push({
                        localPath: matchingThumbPath,
                        sessionFile: serverThumbFile
                    });
                } else {
                    console.error(`[SCPlayerProvider] No local file found for event ID: ${eventId}`);
                }
            });
        }

        console.log(`[SCPlayerProvider] Mapped ${fileMap.length} files for upload`);
        console.log('[SCPlayerProvider] File mapping details:');
        fileMap.forEach((mapping, index) => {
            const fileName = path.basename(mapping.localPath);
            const fileKey = mapping.sessionFile.file_key || mapping.sessionFile.file_id;
            console.log(`  ${index + 1}. ${fileName} -> ${mapping.sessionFile.file_type} (Key: ${fileKey})`);
        });
        return fileMap;
    }

    /**
     * Direct upload to SC Player (for accounts with storage quota)
     */
    async directUpload(credentials, config, filePath, metadata, onProgress) {
        const { apiKey } = credentials;
        const { baseUrl = this.defaultBaseUrl } = config;

        // Check if upload is already in progress
        if (this.uploadInProgress) {
            throw new Error('Another upload is already in progress. Please wait for it to complete or cancel it first.');
        }

        // Mark upload as in progress
        this.uploadInProgress = true;

        try {
            console.log('[SCPlayerProvider] Starting direct upload to SC Player');
            console.log('[SCPlayerProvider] File path:', filePath);

            // Cancel any existing session first
            if (this.currentSession) {
                console.log(`[SCPlayerProvider] Canceling previous session: ${this.currentSession.session_id}`);
                await this.cancelSession(credentials, config, this.currentSession.session_id);
                this.currentSession = null;
            }

            // Step 1: Get upload limits from server
            const limits = await this.getUploadLimits(credentials, config);

        // Step 2: Strict validation of all required files
        const validation = this.validateRequiredFiles(filePath, limits);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        // Step 3: Validate file sizes against server limits
        const sizeValidation = this.validateFileSizes(validation.fileSizes, limits.max_file_sizes);
        if (!sizeValidation.valid) {
            throw new Error(sizeValidation.error);
        }

        // Step 4: Read and parse the events JSON
        console.log('[SCPlayerProvider] Reading events JSON file');
        const eventsJsonContent = fs.readFileSync(validation.jsonPath, 'utf8');
        const eventsJson = JSON.parse(eventsJsonContent);

        console.log(`[SCPlayerProvider] Parsed events JSON with ${eventsJson.events?.length || 0} events`);

        // Step 5: Create upload session with file sizes
        const sessionData = {
            title: metadata.title,
            description: metadata.description,
            privacy: metadata.privacy || 'public',
            character_id: metadata.characterId,
            organization_id: metadata.organizationId,
            starcapture_json: eventsJson,
            file_sizes: validation.fileSizes
        };

            console.log('[SCPlayerProvider] Creating upload session');
            console.log('[SCPlayerProvider] Session data summary:');
            console.log(`  - Title: ${sessionData.title}`);
            console.log(`  - Description: ${sessionData.description}`);
            console.log(`  - Character ID: ${sessionData.character_id}`);
            console.log(`  - Organization ID: ${sessionData.organization_id}`);
            console.log(`  - Events count: ${eventsJson.events?.length || 0}`);
            console.log(`  - File sizes:`, sessionData.file_sizes);
            console.log(`  - StarCapture JSON metadata:`, eventsJson.metadata || 'none');

            // Log potentially problematic fields that might cause server errors
            if (eventsJson.events && eventsJson.events.length > 0) {
                console.log(`  - First event sample:`, JSON.stringify(eventsJson.events[0], null, 2));
                console.log(`  - Last event sample:`, JSON.stringify(eventsJson.events[eventsJson.events.length - 1], null, 2));
            }
            const session = await this.createUploadSession(credentials, config, sessionData);
            console.log('[SCPlayerProvider] Full session response:', JSON.stringify(session, null, 2));
            console.log(`[SCPlayerProvider] Created session ${session.session_id} with ${session.files.length} files to upload`);

            // Store the current session
            this.currentSession = session;

        // Step 4: Map local files to session files
        const fileMap = this.mapFilesToSession(validation, session.files);

        // Step 5: Calculate total bytes and upload each file with progress tracking
        const totalFiles = fileMap.length;
        let completedFiles = 0;

        // Calculate total bytes for all files
        let totalBytes = 0;
        let uploadedBytes = 0;
        const fileSizes = {};

        for (const { localPath } of fileMap) {
            const stats = fs.statSync(localPath);
            const fileSize = stats.size;
            fileSizes[localPath] = fileSize;
            totalBytes += fileSize;
        }

        if (onProgress) {
            onProgress({
                percentage: 0,
                message: 'Starting file uploads...',
                bytesUploaded: uploadedBytes,
                totalBytes: totalBytes
            });
        }

        for (const { localPath, sessionFile } of fileMap) {
            const fileName = path.basename(localPath);
            console.log(`[SCPlayerProvider] Uploading ${fileName} (${sessionFile.file_type})`);

            const currentFileSize = fileSizes[localPath];
            const startFileBytes = uploadedBytes;

            if (onProgress) {
                const progress = Math.round((uploadedBytes / totalBytes) * 1000) / 10; // Round to 1 decimal place
                onProgress({
                    percentage: progress,
                    message: `Uploading ${sessionFile.file_type}...`,
                    bytesUploaded: uploadedBytes,
                    totalBytes: totalBytes
                });
            }

            // Check upload method and route accordingly with retry logic
            let uploadResult = null;
            const maxRetries = 3;
            let retryCount = 0;
            let uploadSuccess = false;

            while (!uploadSuccess && retryCount <= maxRetries) {
                try {
                    if (sessionFile.upload_method === 'multipart') {
                        console.log(`[SCPlayerProvider] Using multipart upload for ${fileName}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);
                        uploadResult = await this.uploadMultipart(
                            sessionFile,
                            localPath,
                            currentFileSize,
                            (fileProgress) => {
                                // Calculate bytes uploaded for this file
                                const fileBytesUploaded = (fileProgress / 100) * currentFileSize;
                                const totalBytesUploaded = startFileBytes + fileBytesUploaded;
                                const totalProgress = Math.round((totalBytesUploaded / totalBytes) * 1000) / 10; // Round to 1 decimal place

                                if (onProgress) {
                                    onProgress({
                                        percentage: totalProgress,
                                        message: `Uploading ${sessionFile.file_type}...`,
                                        bytesUploaded: totalBytesUploaded,
                                        totalBytes: totalBytes
                                    });
                                }
                            },
                            credentials,
                            config
                        );
                    } else {
                        console.log(`[SCPlayerProvider] Using single upload for ${fileName}${retryCount > 0 ? ` (retry ${retryCount}/${maxRetries})` : ''}`);
                        // Upload file to presigned URL (single upload)
                        await this.uploadFileToPresignedUrl(
                            sessionFile.url,
                            localPath,
                            sessionFile.headers,
                            (fileProgress) => {
                                // Calculate bytes uploaded for this file
                                const fileBytesUploaded = (fileProgress / 100) * currentFileSize;
                                const totalBytesUploaded = startFileBytes + fileBytesUploaded;
                                const totalProgress = Math.round((totalBytesUploaded / totalBytes) * 1000) / 10; // Round to 1 decimal place

                                if (onProgress) {
                                    onProgress({
                                        percentage: totalProgress,
                                        message: `Uploading ${sessionFile.file_type}...`,
                                        bytesUploaded: totalBytesUploaded,
                                        totalBytes: totalBytes
                                    });
                                }
                            }
                        );
                        uploadResult = { multipart_upload: false };
                    }

                    uploadSuccess = true;
                    console.log(`[SCPlayerProvider] File upload successful: ${fileName}`);

                } catch (error) {
                    retryCount++;
                    const isRetryableError = error.code === 'ECONNRESET' ||
                                           error.code === 'ETIMEDOUT' ||
                                           error.code === 'ENOTFOUND' ||
                                           error.message.includes('ECONNRESET') ||
                                           error.message.includes('timeout') ||
                                           (error.response && error.response.status >= 500);

                    console.error(`[SCPlayerProvider] Upload failed for ${fileName} (attempt ${retryCount}/${maxRetries + 1}):`, error.message);

                    if (!isRetryableError || retryCount > maxRetries) {
                        // Non-retryable error or max retries exceeded
                        console.error(`[SCPlayerProvider] Permanent failure for ${fileName}:`, error.message);

                        // For non-critical files (event thumbnails), continue with warning
                        if (sessionFile.file_type === 'event_thumbnail') {
                            console.warn(`[SCPlayerProvider] Skipping failed event thumbnail: ${fileName}`);
                            uploadResult = { multipart_upload: false, upload_duration_ms: 0, retry_count: retryCount - 1, failed: true };
                            uploadSuccess = true; // Continue processing
                            break;
                        } else {
                            // For critical files (video, events_json, main_thumbnail), fail the entire upload
                            throw new Error(`Failed to upload critical file ${fileName}: ${error.message}`);
                        }
                    } else {
                        // Wait before retry with exponential backoff
                        const waitTime = Math.min(1000 * Math.pow(2, retryCount - 1), 10000); // Max 10 seconds
                        console.log(`[SCPlayerProvider] Waiting ${waitTime}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    }
                }
            }

            // Update uploaded bytes counter (only if upload was successful)
            if (uploadResult && !uploadResult.failed) {
                uploadedBytes += currentFileSize;
            }

            // Notify completion with upload result metadata (even for failed event thumbnails)
            try {
                const notifyResponse = await this.notifyFileCompletion(
                    credentials,
                    config,
                    session.session_id,
                    sessionFile.file_id,
                    uploadResult
                );

                completedFiles++;

                if (onProgress) {
                    const progress = Math.min(Math.round((uploadedBytes / totalBytes) * 1000) / 10, 95.0); // Cap at 95% until video creation, round to 1 decimal
                    onProgress({
                        percentage: progress,
                        message: 'Processing uploads...',
                        bytesUploaded: uploadedBytes,
                        totalBytes: totalBytes
                    });
                }

                // Check if this was the last file and if video was created
                console.log(`[SCPlayerProvider] Notification ${completedFiles}/${totalFiles} - Status: ${notifyResponse.session_status || 'unknown'}, Next: ${notifyResponse.next_action || 'unknown'}`);

                if (notifyResponse.next_action && notifyResponse.next_action.startsWith('video_created:')) {
                    const videoId = notifyResponse.next_action.split(':')[1];
                    console.log(`[SCPlayerProvider] Video created with ID: ${videoId}`);

                    if (onProgress) {
                        onProgress({
                            percentage: 100,
                            message: 'Upload completed!',
                            bytesUploaded: totalBytes,
                            totalBytes: totalBytes
                        });
                    }

                    // Clean up session state on success
                    this.currentSession = null;
                    this.uploadInProgress = false;

                    // Return success with video information
                    return {
                        success: true,
                        videoId: videoId,
                        viewUrl: `${baseUrl.replace('/api', '').replace(':8443', ':3000')}/watch?v=${videoId}`,
                        shareUrl: `${baseUrl.replace('/api', '').replace(':8443', ':3000')}/watch?v=${videoId}`,
                        message: `Video uploaded successfully to StarCapture Player with ID: ${videoId}`
                    };
                }
            } catch (notifyError) {
                console.error(`[SCPlayerProvider] Failed to notify completion for ${fileName}:`, notifyError.message);

                // For notification failures, continue with other files but log the error
                if (sessionFile.file_type !== 'event_thumbnail') {
                    console.warn(`[SCPlayerProvider] Notification failure for critical file ${fileName} may cause issues`);
                }
            }
        }

        if (onProgress) {
            onProgress({
                percentage: 100,
                message: 'Upload completed!',
                bytesUploaded: totalBytes,
                totalBytes: totalBytes
            });
        }

            // If we get here without a video creation response, something went wrong
            throw new Error('Upload completed but video was not created');

        } catch (error) {
            // Clean up session state on error
            this.uploadInProgress = false;

            // Only cancel session if it's a client-side error (not server-side issues)
            if (this.currentSession && !error.message.includes('timeout') && !error.message.includes('ECONNRESET')) {
                await this.cancelSession(credentials, config, this.currentSession.session_id);
            }
            this.currentSession = null;

            throw error;
        }
    }

    /**
     * Test account connection
     */
    async testConnection(credentials, config = {}) {
        try {
            const result = await this.validateAccount(credentials, config);

            if (result.valid && result.accountInfo) {
                const info = result.accountInfo;
                let message = `Connected successfully!\n`;
                message += `Found ${info.characterCount} character${info.characterCount !== 1 ? 's' : ''}, `;
                message += `${info.organizationCount} organization${info.organizationCount !== 1 ? 's' : ''}`;

                if (info.hasStorage) {
                    message += `\nStorage: ${info.storageUsedFormatted} / ${info.storageQuotaFormatted} (${info.storagePercentage}% used)`;
                } else {
                    message += `\nNo storage quota (indexing only)`;
                }

                return {
                    success: true,
                    message,
                    details: info
                };
            } else {
                return {
                    success: false,
                    message: 'Connection failed: Invalid response',
                    details: null
                };
            }
        } catch (error) {
            return {
                success: false,
                message: `Connection failed: ${error.message}`,
                details: null
            };
        }
    }
}

module.exports = SCPlayerProvider;