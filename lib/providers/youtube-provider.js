const EventEmitter = require('events');
const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * YouTube Upload Provider
 * Handles video uploads to YouTube using OAuth2 tokens
 */
class YouTubeProvider extends EventEmitter {
    constructor() {
        super();
        this.name = 'youtube';
        this.displayName = 'YouTube';
        this.maxFileSize = 128 * 1024 * 1024 * 1024; // 128GB YouTube limit
    }

    /**
     * Validate account credentials
     * @param {Object} credentials - OAuth credentials object
     * @param {Object} config - Account configuration
     */
    async validateAccount(credentials, config) {
        if (!credentials?.accessToken) {
            throw new Error('Missing access token');
        }

        // Since youtube.upload scope doesn't allow GET methods to test,
        // we simply trust that having a token means it's valid.
        // The actual validation will happen when we try to upload.
        return {
            valid: true,
            userInfo: {
                id: 'youtube-user',
                name: 'YouTube Account',
                email: ''
            }
        };
    }

    /**
     * Check if token is expired or about to expire
     * @param {Object} credentials - OAuth credentials with expiresAt timestamp
     * @returns {boolean} true if token is expired or will expire in next 5 minutes
     */
    isTokenExpired(credentials) {
        if (!credentials?.expiresAt) {
            // If no expiry time stored, assume expired to force refresh
            console.log('[YouTube] No token expiry time found, assuming expired');
            return true;
        }

        const now = Date.now();
        const expiryTime = credentials.expiresAt;
        const fiveMinutesFromNow = now + (5 * 60 * 1000); // 5 minutes buffer

        const isExpired = expiryTime <= fiveMinutesFromNow;

        if (isExpired) {
            console.log('[YouTube] Token expired or about to expire', {
                now: new Date(now).toISOString(),
                expiresAt: new Date(expiryTime).toISOString()
            });
        }

        return isExpired;
    }

    /**
     * Ensure we have a valid access token, refreshing if necessary
     * @param {Object} credentials - OAuth credentials object
     * @returns {Promise<Object>} Updated credentials with fresh token if needed
     */
    async ensureValidToken(credentials) {
        if (!credentials?.refreshToken) {
            console.log('[YouTube] No refresh token available');
            return credentials;
        }

        // Check if token is expired
        if (!this.isTokenExpired(credentials)) {
            return credentials;
        }

        console.log('[YouTube] Token expired, refreshing...');

        try {
            // Refresh the token
            const newTokens = await this.refreshToken(credentials.refreshToken);

            // Calculate new expiry time
            const expiresIn = newTokens.expiresIn || 3600; // Default to 1 hour
            const expiresAt = Date.now() + (expiresIn * 1000);

            // Merge new tokens with existing credentials
            const updatedCredentials = {
                ...credentials,
                accessToken: newTokens.accessToken,
                expiresIn: expiresIn,
                expiresAt: expiresAt,
                tokenType: newTokens.tokenType || credentials.tokenType,
                scope: newTokens.scope || credentials.scope
            };

            console.log('[YouTube] Token refreshed successfully', {
                expiresAt: new Date(expiresAt).toISOString()
            });

            return updatedCredentials;
        } catch (error) {
            console.error('[YouTube] Failed to refresh token:', error);
            // Return original credentials and let the upload fail with proper error
            return credentials;
        }
    }

    /**
     * Upload a video to YouTube
     * @param {Object} credentials - OAuth credentials with accessToken and refreshToken
     * @param {Object} config - Account config with privacy settings and playlist
     * @param {string} filePath - Path to the video file
     * @param {Object} metadata - Upload metadata (title, description, tags, etc.)
     * @param {Function} onProgress - Progress callback
     */
    async upload(credentials, config, filePath, metadata = {}, onProgress) {
        const fileSize = (await fs.promises.stat(filePath)).size;

        if (fileSize > this.maxFileSize) {
            throw new Error(`File exceeds YouTube's maximum size of 128GB`);
        }

        // Ensure we have a valid token before attempting upload
        const validCredentials = await this.ensureValidToken(credentials);

        // Check if credentials were updated
        const credentialsUpdated = validCredentials.accessToken !== credentials.accessToken;
        if (credentialsUpdated) {
            console.log('[YouTube] Using refreshed access token for upload');
        }

        // Prepare video metadata
        const videoMetadata = {
            snippet: {
                title: metadata.title || 'StarCapture Video',
                description: metadata.description || '',
                tags: metadata.tags || ['Star Citizen', 'Gaming'],
                categoryId: metadata.categoryId || '20', // Gaming category
            },
            status: {
                privacyStatus: metadata.privacy || config?.privacy || 'private',
                selfDeclaredMadeForKids: false
            }
        };

        // If playlist specified, prepare to add video after upload
        const playlistId = metadata.playlist || config?.playlist;

        // Start resumable upload with valid token
        const uploadUrl = await this.initiateUpload(
            validCredentials.accessToken,
            videoMetadata,
            fileSize
        );

        // Upload the file
        const videoId = await this.uploadFile(
            uploadUrl,
            filePath,
            fileSize,
            onProgress
        );

        // Add to playlist if specified
        if (playlistId && videoId) {
            try {
                await this.addToPlaylist(
                    validCredentials.accessToken,
                    videoId,
                    playlistId
                );
            } catch (error) {
                console.error('Failed to add video to playlist:', error);
                // Don't fail the upload if playlist addition fails
            }
        }

        const result = {
            success: true,
            videoId,
            url: `https://youtube.com/watch?v=${videoId}`
        };

        // Include updated credentials if they were refreshed
        if (credentialsUpdated) {
            result.updatedCredentials = validCredentials;
        }

        return result;
    }

    /**
     * Initiate resumable upload
     */
    async initiateUpload(accessToken, metadata, fileSize) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(metadata);

            const options = {
                hostname: 'www.googleapis.com',
                path: '/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'X-Upload-Content-Length': fileSize,
                    'X-Upload-Content-Type': 'video/*'
                }
            };

            const req = https.request(options, (res) => {
                if (res.statusCode === 200) {
                    const uploadUrl = res.headers.location;
                    resolve(uploadUrl);
                } else {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        reject(new Error(`Failed to initiate upload: ${res.statusCode} - ${body}`));
                    });
                }
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    /**
     * Upload file using resumable upload
     */
    async uploadFile(uploadUrl, filePath, fileSize, onProgress) {
        return new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath);
            const url = new URL(uploadUrl);

            let uploadedBytes = 0;

            const options = {
                hostname: url.hostname,
                path: url.pathname + url.search,
                method: 'PUT',
                headers: {
                    'Content-Length': fileSize,
                    'Content-Type': 'video/*'
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        try {
                            const response = JSON.parse(body);
                            resolve(response.id);
                        } catch (error) {
                            reject(new Error('Failed to parse upload response'));
                        }
                    } else {
                        reject(new Error(`Upload failed: ${res.statusCode} - ${body}`));
                    }
                });
            });

            stream.on('data', (chunk) => {
                uploadedBytes += chunk.length;
                if (onProgress) {
                    onProgress({
                        uploadedBytes,
                        totalBytes: fileSize,
                        percentage: Math.round((uploadedBytes / fileSize) * 100)
                    });
                }
            });

            stream.on('error', reject);
            req.on('error', reject);

            stream.pipe(req);
        });
    }

    /**
     * Add video to playlist
     */
    async addToPlaylist(accessToken, videoId, playlistId) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                snippet: {
                    playlistId: playlistId,
                    resourceId: {
                        kind: 'youtube#video',
                        videoId: videoId
                    }
                }
            });

            const options = {
                hostname: 'www.googleapis.com',
                path: '/youtube/v3/playlistItems?part=snippet',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    'Content-Length': postData.length
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200 || res.statusCode === 201) {
                        resolve(JSON.parse(body));
                    } else {
                        reject(new Error(`Failed to add to playlist: ${res.statusCode} - ${body}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }

    // Removed getChannelInfo - not needed since youtube.upload scope doesn't allow channel queries

    /**
     * Refresh OAuth token using the OAuth proxy server
     */
    async refreshToken(refreshToken) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                service: 'google',
                refresh_token: refreshToken
            });

            const options = {
                hostname: 'auth.sc-recorder.video',
                port: 443,
                path: '/auth/refresh',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length
                }
            };

            const req = https.request(options, (res) => {
                let body = '';

                res.on('data', (chunk) => {
                    body += chunk;
                });

                res.on('end', () => {
                    try {
                        const result = JSON.parse(body);
                        if (result.error) {
                            reject(new Error(result.message || 'Token refresh failed'));
                        } else {
                            // Return new tokens
                            resolve({
                                accessToken: result.access_token,
                                expiresIn: result.expires_in,
                                tokenType: result.token_type,
                                scope: result.scope
                            });
                        }
                    } catch (error) {
                        reject(new Error('Failed to parse refresh response'));
                    }
                });
            });

            req.on('error', (error) => {
                reject(error);
            });

            req.write(data);
            req.end();
        });
    }

    /**
     * Cancel an upload
     */
    async cancelUpload(uploadId) {
        // YouTube doesn't provide a direct cancel API
        // Simply stop the upload stream
        return true;
    }
}

module.exports = YouTubeProvider;