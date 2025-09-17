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

        // Test the token by fetching user info
        try {
            const userInfo = await this.getUserInfo(credentials.accessToken);
            return {
                valid: true,
                userInfo
            };
        } catch (error) {
            if (error.statusCode === 401) {
                // Try to refresh token if available
                if (credentials?.refreshToken) {
                    const newTokens = await this.refreshToken(credentials.refreshToken);
                    return {
                        valid: true,
                        newTokens
                    };
                }
            }
            throw error;
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

        // Start resumable upload
        const uploadUrl = await this.initiateUpload(
            credentials.accessToken,
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
                    credentials.accessToken,
                    videoId,
                    playlistId
                );
            } catch (error) {
                console.error('Failed to add video to playlist:', error);
                // Don't fail the upload if playlist addition fails
            }
        }

        return {
            success: true,
            videoId,
            url: `https://youtube.com/watch?v=${videoId}`
        };
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

    /**
     * Get user info
     */
    async getUserInfo(accessToken) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'www.googleapis.com',
                path: '/oauth2/v2/userinfo',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(JSON.parse(body));
                    } else {
                        const error = new Error(`Failed to get user info: ${res.statusCode}`);
                        error.statusCode = res.statusCode;
                        reject(error);
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }

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
                hostname: 'localhost',
                port: 3000,
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