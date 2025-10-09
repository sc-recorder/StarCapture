/**
 * OAuth authentication handlers
 * Handles OAuth flow, token management, and callback processing
 */

const { ipcMain, shell, app } = require('electron');
const path = require('path');
const OAuthPKCE = require('../oauth-pkce');
const oauthConfigLoader = require('../oauth-config-loader');

class OAuthHandlers {
  constructor(mainWindowGetter) {
    this.getMainWindow = mainWindowGetter;
    this.oauthHandler = null;
    this.OAUTH_PROXY_URL = 'https://auth.sc-recorder.video';
  }

  /**
   * Register OAuth protocol handler
   */
  registerProtocolHandler() {
    // Register sc-recorder:// protocol
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('sc-recorder', process.execPath, [path.resolve(process.argv[1])]);
      }
    } else {
      app.setAsDefaultProtocolClient('sc-recorder');
    }
  }

  /**
   * Register all OAuth-related IPC handlers
   */
  registerHandlers() {
    ipcMain.handle('oauth:authenticate', async (event, service) => this.handleAuthenticate(service));
    ipcMain.handle('oauth:refresh-token', async (event, { refreshToken, service }) =>
      this.handleRefreshToken(refreshToken, service));
    ipcMain.handle('oauth:check-config', async () => this.handleCheckConfig());
  }

  /**
   * Handle OAuth callback URLs
   */
  handleOAuthCallback(url) {
    const mainWindow = this.getMainWindow();

    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.host === 'auth' && parsedUrl.pathname === '/callback') {
        const params = parsedUrl.searchParams;
        const success = params.get('success') === 'true';
        const service = params.get('service');

        if (success) {
          const tokens = {
            access_token: params.get('access_token'),
            refresh_token: params.get('refresh_token'),
            expires_in: parseInt(params.get('expires_in')) || 3600,
            service: service
          };

          // Add client ID for Twitch (needed for API calls)
          if (service === 'twitch') {
            const oauthConfig = oauthConfigLoader.load();
            if (oauthConfig?.twitch?.clientId) {
              tokens.client_id = oauthConfig.twitch.clientId;
            }
          }

          // Extract user info if present
          const userInfo = params.get('user_info') ? JSON.parse(decodeURIComponent(params.get('user_info'))) : null;

          // Send tokens and user info to renderer
          if (mainWindow) {
            mainWindow.webContents.send('oauth-callback', {
              success: true,
              service: service,
              tokens: tokens,
              userInfo: userInfo
            });
          }

        } else {
          const error = params.get('error');
          if (mainWindow) {
            mainWindow.webContents.send('oauth-callback', {
              success: false,
              error: error
            });
          }
          console.error('[OAuth] Authentication failed:', error);
        }

        // Focus the app window
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      }
    } catch (error) {
      console.error('[OAuth] Error handling callback:', error);
    }
  }

  async handleAuthenticate(service) {
    try {
      // Use OAuth proxy server for authentication
      const authUrl = `${this.OAUTH_PROXY_URL}/auth/${service === 'google' ? 'google' : 'twitch'}`;

      // Open the OAuth URL in the default browser
      await shell.openExternal(authUrl);

      // Return a pending status - the actual tokens will come via the protocol handler
      return {
        success: true,
        pending: true,
        message: 'Authentication window opened. Please complete login in your browser.'
      };
    } catch (error) {
      console.error(`[OAuth] Authentication failed for ${service}:`, error);
      return { success: false, error: error.message };
    }
  }

  async handleRefreshToken(refreshToken, service) {
    try {
      // Use OAuth proxy server for token refresh
      const response = await fetch(`${this.OAUTH_PROXY_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          service: service,
          refresh_token: refreshToken
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Token refresh failed');
      }

      const tokens = await response.json();
      return { success: true, tokens };
    } catch (error) {
      console.error('[OAuth] Token refresh failed:', error);
      return { success: false, error: error.message };
    }
  }

  async handleCheckConfig() {
    // OAuth is now handled by the proxy server
    return {
      configured: true,
      twitch: true,
      google: true,
      proxyUrl: this.OAUTH_PROXY_URL
    };
  }
}

module.exports = OAuthHandlers;
