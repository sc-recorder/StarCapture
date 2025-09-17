const crypto = require('crypto');
const { BrowserWindow } = require('electron');
const http = require('http');
const url = require('url');
const { authenticate } = require('@google-cloud/local-auth');
const { OAuth2Client } = require('google-auth-library');

/**
 * OAuth PKCE (Proof Key for Code Exchange) Implementation
 * RFC 7636 compliant implementation for secure OAuth without client secrets
 */
class OAuthPKCE {
    constructor() {
        this.authWindow = null;
        this.server = null;
        this.pendingAuth = null;
        this.googleClient = null;
    }

    /**
     * Generate PKCE code verifier and challenge
     * @returns {Object} { verifier, challenge, method }
     */
    generatePKCE() {
        // Generate cryptographically random code verifier (43-128 characters)
        const verifier = crypto.randomBytes(32).toString('base64url');

        // Generate code challenge using SHA256
        const challenge = crypto
            .createHash('sha256')
            .update(verifier)
            .digest('base64url');

        return {
            verifier,
            challenge,
            method: 'S256'
        };
    }

    /**
     * Build authorization URL with PKCE parameters
     * @param {Object} config - OAuth configuration
     * @param {string} config.authEndpoint - Authorization endpoint URL
     * @param {string} config.clientId - OAuth Client ID
     * @param {string} config.redirectUri - Redirect URI
     * @param {Array} config.scopes - Required scopes
     * @param {string} service - Service name (twitch/google)
     * @returns {Object} { url, verifier, state }
     */
    buildAuthUrl(config, service) {
        const pkce = this.generatePKCE();
        const state = crypto.randomBytes(16).toString('base64url');

        // Service-specific endpoints
        const endpoints = {
            twitch: 'https://id.twitch.tv/oauth2/authorize',
            google: 'https://accounts.google.com/o/oauth2/v2/auth'
        };

        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            response_type: 'code',
            scope: config.scopes.join(' '),
            state: state,
            code_challenge: pkce.challenge,
            code_challenge_method: pkce.method
        });

        // Add service-specific parameters
        if (service === 'google') {
            params.append('access_type', 'offline'); // Request refresh token
            params.append('prompt', 'consent'); // Force consent to get refresh token
        }

        const authUrl = `${config.authEndpoint || endpoints[service]}?${params}`;

        return {
            url: authUrl,
            verifier: pkce.verifier,
            state: state
        };
    }

    /**
     * Start OAuth authentication flow
     * @param {Object} config - OAuth configuration
     * @param {string} service - Service name (twitch/google)
     * @returns {Promise<Object>} Authentication result with tokens
     */
    async authenticate(config, service) {
        // Use Google Cloud local-auth for Google/YouTube
        if (service === 'google') {
            return this.authenticateGoogle(config);
        }

        // Use existing PKCE implementation for Twitch
        return new Promise((resolve, reject) => {
            // Generate PKCE parameters and auth URL
            const { url: authUrl, verifier, state } = this.buildAuthUrl(config, service);

            // Store for later use in token exchange
            this.pendingAuth = {
                verifier,
                state,
                service,
                config,
                resolve,
                reject
            };

            // Start local server to receive callback
            this.startCallbackServer(config.redirectUri);

            // Open authentication window
            this.authWindow = new BrowserWindow({
                width: 600,
                height: 700,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true
                },
                autoHideMenuBar: true,
                title: `Login to ${service.charAt(0).toUpperCase() + service.slice(1)}`
            });

            // Handle window events
            this.authWindow.on('closed', () => {
                this.authWindow = null;
                this.cleanup();
                if (this.pendingAuth) {
                    this.pendingAuth.reject(new Error('Authentication cancelled by user'));
                    this.pendingAuth = null;
                }
            });

            // Load the authorization URL
            this.authWindow.loadURL(authUrl);
        });
    }

    /**
     * Authenticate with Google using OAuth2Client directly
     * @param {Object} config - OAuth configuration
     * @returns {Promise<Object>} Authentication result with tokens
     */
    async authenticateGoogle(config) {
        return new Promise(async (resolve, reject) => {
            try {
                console.log('[OAuth PKCE] Using Google OAuth2Client for authentication');

                // Create OAuth2 client for desktop apps (no secret required)
                this.googleClient = new OAuth2Client({
                    clientId: config.clientId,
                    redirectUri: config.redirectUri || 'http://127.0.0.1:3000/auth/google/callback'
                });

                // Generate PKCE codes manually since we're using desktop flow
                const verifier = crypto.randomBytes(32).toString('base64url');
                const challenge = crypto
                    .createHash('sha256')
                    .update(verifier)
                    .digest('base64url');

                this.googleCodeVerifier = verifier;

                // Generate auth URL with PKCE for desktop apps
                // Use explicit parameters for desktop OAuth flow
                const authParams = {
                    access_type: 'offline',
                    scope: config.scopes,
                    prompt: 'consent',
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                    response_type: 'code',
                    // Add explicit flow hint for desktop apps
                    include_granted_scopes: true
                };

                const authUrl = this.googleClient.generateAuthUrl(authParams);

                console.log('[OAuth PKCE] Auth URL generated for desktop app flow');

                console.log('[OAuth PKCE] Generated auth URL with PKCE challenge');

                // Store pending auth for callback
                this.pendingAuth = {
                    service: 'google',
                    config,
                    resolve,
                    reject
                };

                // Start local server to receive callback
                this.startGoogleCallbackServer(config.redirectUri);

                // Open authentication window
                this.authWindow = new BrowserWindow({
                    width: 600,
                    height: 700,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true
                    },
                    autoHideMenuBar: true,
                    title: 'Login to YouTube'
                });

                // Handle window events
                this.authWindow.on('closed', () => {
                    this.authWindow = null;
                    this.cleanup();
                    if (this.pendingAuth) {
                        this.pendingAuth.reject(new Error('Authentication cancelled by user'));
                        this.pendingAuth = null;
                    }
                });

                // Load the authorization URL
                this.authWindow.loadURL(authUrl);
            } catch (error) {
                console.error('[OAuth PKCE] Error setting up Google auth:', error);
                reject(error);
            }
        });
    }

    /**
     * Get Google user info using access token
     * @param {string} accessToken - Access token
     * @returns {Promise<Object>} User information
     */
    async getGoogleUserInfo(accessToken) {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to get user info');
            }

            return await response.json();
        } catch (error) {
            console.error('[OAuth PKCE] Error getting Google user info:', error);
            return null;
        }
    }

    /**
     * Start local HTTP server for Google OAuth callback
     * @param {string} redirectUri - Configured redirect URI
     */
    startGoogleCallbackServer(redirectUri) {
        const parsedUrl = url.parse(redirectUri);
        const port = parsedUrl.port || 3000;

        this.server = http.createServer(async (req, res) => {
            const reqUrl = url.parse(req.url, true);

            // Check if this is our callback
            if (reqUrl.pathname === url.parse(redirectUri).pathname) {
                const { code, error, error_description } = reqUrl.query;

                // Send response to browser
                res.writeHead(200, { 'Content-Type': 'text/html' });

                if (error) {
                    res.end(`
                        <html><body style="font-family: system-ui; padding: 40px; text-align: center;">
                            <h2>Authentication Failed</h2>
                            <p>${error_description || error}</p>
                            <p style="color: #666;">You can close this window.</p>
                            <script>setTimeout(() => window.close(), 3000);</script>
                        </body></html>
                    `);

                    this.cleanup();
                    if (this.pendingAuth) {
                        this.pendingAuth.reject(new Error(error_description || error));
                        this.pendingAuth = null;
                    }
                    return;
                }

                res.end(`
                    <html><body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h2>✅ Authentication Successful!</h2>
                        <p>You can close this window and return to SC Recorder.</p>
                        <script>setTimeout(() => window.close(), 2000);</script>
                    </body></html>
                `);

                // Exchange code for tokens using Google client
                if (this.pendingAuth && this.googleClient && this.googleCodeVerifier) {
                    try {
                        // Use getToken with code_verifier for PKCE
                        const { tokens } = await this.googleClient.getToken({
                            code: code,
                            codeVerifier: this.googleCodeVerifier
                        });

                        console.log('[OAuth PKCE] Successfully exchanged code for tokens');

                        // Get user info
                        const userInfo = await this.getGoogleUserInfo(tokens.access_token);

                        // Format response
                        const result = {
                            access_token: tokens.access_token,
                            token_type: tokens.token_type || 'Bearer',
                            expires_in: tokens.expiry_date
                                ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
                                : 3600,
                            refresh_token: tokens.refresh_token,
                            scope: tokens.scope || config.scopes.join(' '),
                            service: 'google',
                            timestamp: Date.now(),
                            userInfo: userInfo
                        };

                        // Close auth window
                        if (this.authWindow) {
                            this.authWindow.close();
                        }

                        this.cleanup();
                        this.pendingAuth.resolve(result);
                        this.pendingAuth = null;
                        this.googleClient = null;
                        this.googleCodeVerifier = null;
                    } catch (error) {
                        console.error('[OAuth PKCE] Error exchanging code with Google client:', error);
                        this.cleanup();
                        this.pendingAuth.reject(error);
                        this.pendingAuth = null;
                        this.googleClient = null;
                        this.googleCodeVerifier = null;
                    }
                }
            }
        });

        // Listen on loopback interface for security
        this.server.listen(port, '127.0.0.1', () => {
            console.log(`[OAuth PKCE] Google callback server listening on http://127.0.0.1:${port}`);
        });
    }

    /**
     * Start local HTTP server to receive OAuth callback
     * @param {string} redirectUri - Configured redirect URI
     */
    startCallbackServer(redirectUri) {
        const parsedUrl = url.parse(redirectUri);
        const port = parsedUrl.port || 3000;

        this.server = http.createServer(async (req, res) => {
            const reqUrl = url.parse(req.url, true);

            // Check if this is our callback
            if (reqUrl.pathname === url.parse(redirectUri).pathname) {
                const { code, state, error, error_description } = reqUrl.query;

                // Send response to browser
                res.writeHead(200, { 'Content-Type': 'text/html' });

                if (error) {
                    res.end(`
                        <html><body style="font-family: system-ui; padding: 40px; text-align: center;">
                            <h2>Authentication Failed</h2>
                            <p>${error_description || error}</p>
                            <p style="color: #666;">You can close this window.</p>
                            <script>setTimeout(() => window.close(), 3000);</script>
                        </body></html>
                    `);

                    this.cleanup();
                    if (this.pendingAuth) {
                        this.pendingAuth.reject(new Error(error_description || error));
                        this.pendingAuth = null;
                    }
                    return;
                }

                res.end(`
                    <html><body style="font-family: system-ui; padding: 40px; text-align: center;">
                        <h2>✅ Authentication Successful!</h2>
                        <p>You can close this window and return to SC Recorder.</p>
                        <script>setTimeout(() => window.close(), 2000);</script>
                    </body></html>
                `);

                // Verify state parameter
                if (this.pendingAuth && state === this.pendingAuth.state) {
                    try {
                        // Exchange code for tokens
                        const tokens = await this.exchangeCodeForTokens(
                            code,
                            this.pendingAuth.verifier,
                            this.pendingAuth.config,
                            this.pendingAuth.service
                        );

                        // Close auth window
                        if (this.authWindow) {
                            this.authWindow.close();
                        }

                        this.cleanup();
                        this.pendingAuth.resolve(tokens);
                        this.pendingAuth = null;
                    } catch (error) {
                        this.cleanup();
                        this.pendingAuth.reject(error);
                        this.pendingAuth = null;
                    }
                } else {
                    this.cleanup();
                    if (this.pendingAuth) {
                        this.pendingAuth.reject(new Error('State mismatch - possible CSRF attack'));
                        this.pendingAuth = null;
                    }
                }
            }
        });

        this.server.listen(port);
        console.log(`[OAuth PKCE] Callback server listening on port ${port}`);
    }

    /**
     * Exchange authorization code for tokens
     * @param {string} code - Authorization code
     * @param {string} verifier - PKCE code verifier
     * @param {Object} config - OAuth configuration
     * @param {string} service - Service name
     * @returns {Promise<Object>} Tokens
     */
    async exchangeCodeForTokens(code, verifier, config, service) {
        const tokenEndpoints = {
            twitch: 'https://id.twitch.tv/oauth2/token',
            google: 'https://oauth2.googleapis.com/token'
        };

        const params = new URLSearchParams({
            client_id: config.clientId,
            code: code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: config.redirectUri
        });

        // Add client secret if provided (for Google when not using pure PKCE)
        if (config.clientSecret) {
            params.append('client_secret', config.clientSecret);
        }

        console.log(`[OAuth PKCE] Token exchange for ${service} with params:`, {
            client_id: config.clientId,
            has_secret: !!config.clientSecret,
            redirect_uri: config.redirectUri,
            code_verifier_length: verifier.length
        });

        const response = await fetch(tokenEndpoints[service], {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token exchange failed: ${error}`);
        }

        const tokens = await response.json();

        // Add service identifier
        tokens.service = service;
        tokens.timestamp = Date.now();

        return tokens;
    }

    /**
     * Refresh an access token (Google/YouTube only)
     * @param {string} refreshToken - Refresh token
     * @param {Object} config - OAuth configuration
     * @returns {Promise<Object>} New tokens
     */
    async refreshToken(refreshToken, config) {
        // Use Google OAuth2Client for Google/YouTube refresh
        if (config.clientId && config.clientId.includes('googleusercontent')) {
            try {
                const client = new OAuth2Client(
                    config.clientId,
                    config.clientSecret || undefined,
                    config.redirectUri || 'http://localhost:3000/auth/google/callback'
                );

                client.setCredentials({
                    refresh_token: refreshToken
                });

                const { credentials } = await client.refreshAccessToken();

                return {
                    access_token: credentials.access_token,
                    token_type: credentials.token_type || 'Bearer',
                    expires_in: credentials.expiry_date
                        ? Math.floor((credentials.expiry_date - Date.now()) / 1000)
                        : 3600,
                    refresh_token: credentials.refresh_token || refreshToken,
                    scope: credentials.scope,
                    timestamp: Date.now(),
                    service: 'google'
                };
            } catch (error) {
                console.error('[OAuth PKCE] Google token refresh error:', error);
                throw new Error(`Google token refresh failed: ${error.message}`);
            }
        }

        // Fallback for other services (currently not used)
        const params = new URLSearchParams({
            client_id: config.clientId,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        });

        if (config.clientSecret) {
            params.append('client_secret', config.clientSecret);
        }

        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Token refresh failed: ${error}`);
        }

        return await response.json();
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
        if (this.authWindow && !this.authWindow.isDestroyed()) {
            this.authWindow.close();
            this.authWindow = null;
        }
    }
}

module.exports = OAuthPKCE;