/**
 * Google OAuth Provider for MCP OAuth 2.1
 *
 * Implements the OAuthServerProvider interface to integrate
 * Google OAuth with MCP's standardized OAuth flow.
 */

import { Response } from 'express';
import { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { google, Auth } from 'googleapis';
import { SessionManager } from './session-manager.js';
import { AuthCodeStore } from './auth-code-store.js';
import { AuthenticationError } from './types.js';
import * as crypto from 'crypto';

interface AuthorizationParams {
  state?: string;
  scopes?: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: URL;
}

export class GoogleOAuthProvider implements OAuthServerProvider {
  private readonly clientStore: OAuthRegisteredClientsStore;
  private readonly sessionManager: SessionManager;
  private readonly authCodeStore: AuthCodeStore;
  private googleOAuthClient: Auth.OAuth2Client | null = null;

  constructor(clientStore: OAuthRegisteredClientsStore, sessionManager: SessionManager) {
    this.clientStore = clientStore;
    this.sessionManager = sessionManager;
    this.authCodeStore = new AuthCodeStore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clientStore;
  }

  /**
   * Load Google OAuth credentials from Parameter Store
   */
  private async getGoogleOAuthClient(): Promise<Auth.OAuth2Client> {
    if (this.googleOAuthClient) {
      return this.googleOAuthClient;
    }

    // Import SSM client dynamically to get credentials
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const ssmClient = new SSMClient({});
    const parameterName = process.env.GOOGLE_OAUTH_PARAMETER_NAME || '/google-contacts-mcp/oauth-credentials';

    try {
      const response = await ssmClient.send(
        new GetParameterCommand({
          Name: parameterName,
          WithDecryption: true,
        })
      );

      if (!response.Parameter?.Value) {
        throw new Error('Parameter value is empty');
      }

      const credentials = JSON.parse(response.Parameter.Value);

      // Use /google/callback endpoint for OAuth redirect
      const apiEndpoint = process.env.API_ENDPOINT;
      if (!apiEndpoint) {
        throw new Error('API_ENDPOINT environment variable is required');
      }
      const redirectUri = `${apiEndpoint}/google/callback`;

      this.googleOAuthClient = new google.auth.OAuth2(
        credentials.client_id,
        credentials.client_secret,
        redirectUri
      );

      return this.googleOAuthClient;
    } catch (error: any) {
      throw new AuthenticationError(`Failed to load OAuth credentials: ${error.message}`);
    }
  }

  /**
   * Begin authorization flow - redirect to Google OAuth
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const oauth2Client = await this.getGoogleOAuthClient();

    // Generate our own authorization code
    const authCode = crypto.randomUUID();

    // Store the authorization request details in DynamoDB
    await this.authCodeStore.saveAuthCode(authCode, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes,
    });

    // Generate Google OAuth URL with our auth code as state
    const googleAuthUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/userinfo.email'
      ],
      state: authCode, // Pass our auth code as state
      prompt: 'consent',
    });

    // Redirect user to Google for authentication
    res.redirect(googleAuthUrl);
  }

  /**
   * Returns the code challenge for the given authorization code
   */
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const authData = await this.authCodeStore.getAuthCode(authorizationCode);
    if (!authData || authData.clientId !== client.client_id) {
      throw new Error('Invalid authorization code');
    }
    return authData.codeChallenge;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL
  ): Promise<OAuthTokens> {
    const authData = await this.authCodeStore.getAuthCode(authorizationCode);

    if (!authData || authData.clientId !== client.client_id) {
      throw new Error('Invalid authorization code');
    }

    if (!authData.googleTokens) {
      throw new Error('Google authentication not completed');
    }

    // Verify PKCE challenge
    if (codeVerifier) {
      const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      if (hash !== authData.codeChallenge) {
        throw new Error('Invalid code verifier');
      }
    }

    // Generate our own access and refresh tokens for MCP
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const mcpRefreshToken = crypto.randomBytes(32).toString('base64url');
    const expiresIn = 30 * 24 * 60 * 60; // 30 days
    const mcpTokenExpiresAt = Date.now() + (expiresIn * 1000);

    // Store tokens in session manager for later use
    // The session ID IS the access token, so we can verify it later
    if (authData.googleTokens.userEmail) {
      await this.sessionManager.saveSession({
        sessionId: accessToken, // Use our access token as session ID
        clientId: client.client_id,
        userEmail: authData.googleTokens.userEmail,
        accessToken: authData.googleTokens.accessToken, // Google access token
        refreshToken: authData.googleTokens.refreshToken, // Google refresh token
        mcpRefreshToken: mcpRefreshToken, // MCP refresh token for Claude
        expiresAt: authData.googleTokens.expiresAt, // Google token expiry (~1 hour)
        mcpTokenExpiresAt: mcpTokenExpiresAt, // MCP token expiry (30 days)
        tokenType: 'Bearer',
        scope: 'https://www.googleapis.com/auth/contacts.readonly',
      });
    }

    // Clean up authorization code
    await this.authCodeStore.deleteAuthCode(authorizationCode);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: mcpRefreshToken, // Return MCP refresh token to Claude
      scope: authData.scopes?.join(' '),
    };
  }

  /**
   * Exchange refresh token for new access token
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL
  ): Promise<OAuthTokens> {
    // Look up the session by refresh token
    const session = await this.sessionManager.getSessionByRefreshToken(refreshToken);
    if (!session) {
      throw new Error('Invalid refresh token');
    }

    // Use Google's OAuth client to refresh the access token
    const oauth2Client = await this.getGoogleOAuthClient();
    oauth2Client.setCredentials({
      refresh_token: session.refreshToken,
    });

    const { credentials } = await oauth2Client.refreshAccessToken();
    if (!credentials.access_token) {
      throw new Error('Failed to refresh Google access token');
    }

    // Generate new MCP access token (keep same refresh token)
    const newAccessToken = crypto.randomBytes(32).toString('base64url');
    const expiresIn = 30 * 24 * 60 * 60; // 30 days
    const googleTokenExpiresAt = credentials.expiry_date || Date.now() + (3600 * 1000); // Google token ~1 hour
    const mcpTokenExpiresAt = Date.now() + (expiresIn * 1000); // MCP token 30 days

    // Update old session with new Google access token
    await this.sessionManager.updateAccessToken(
      session.sessionId,
      credentials.access_token,
      googleTokenExpiresAt
    );

    // Save new MCP access token session
    await this.sessionManager.saveSession({
      sessionId: newAccessToken,
      clientId: session.clientId,
      userEmail: session.userEmail,
      accessToken: credentials.access_token, // New Google access token
      refreshToken: session.refreshToken, // Keep same Google refresh token
      mcpRefreshToken: refreshToken, // Keep same MCP refresh token
      expiresAt: googleTokenExpiresAt, // Google token expiry (~1 hour)
      mcpTokenExpiresAt: mcpTokenExpiresAt, // MCP token expiry (30 days)
      tokenType: 'Bearer',
      scope: session.scope,
    });

    return {
      access_token: newAccessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken, // Return same MCP refresh token to Claude
      scope: session.scope,
    };
  }

  /**
   * Verify access token and return auth info
   * Automatically refreshes Google tokens if expired
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Check if session exists in DynamoDB (sessionId = access token)
    const session = await this.sessionManager.getSession(token);

    if (!session) {
      throw new Error('Invalid or expired access token');
    }

    // Check if Google token needs refresh (expired or within 5 minutes of expiry)
    const expiryBuffer = 5 * 60 * 1000; // 5 minutes
    const needsRefresh = session.expiresAt - Date.now() < expiryBuffer;

    if (needsRefresh && session.refreshToken) {
      try {
        // Refresh Google access token
        const oauth2Client = await this.getGoogleOAuthClient();
        oauth2Client.setCredentials({
          refresh_token: session.refreshToken,
        });

        const { credentials } = await oauth2Client.refreshAccessToken();
        if (credentials.access_token) {
          const newExpiresAt = credentials.expiry_date || Date.now() + (3600 * 1000);

          // Update session with new Google token
          await this.sessionManager.updateAccessToken(
            token,
            credentials.access_token,
            newExpiresAt
          );
        }
      } catch (error) {
        // Log error but don't fail - let the current token be used
        console.error('Failed to auto-refresh Google token:', error);
      }
    }

    // Extend MCP token expiry (sliding window - 30 days from now)
    // This keeps the same MCP access token valid indefinitely as long as it's used
    await this.sessionManager.extendSession(token, 30);

    // Return auth info from session
    return {
      token: token,
      clientId: session.clientId || 'unknown',
      scopes: session.scope.split(' '),
    };
  }

  /**
   * Revoke access or refresh token
   */
  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const token = request.token;

    // Revoke the Google token and delete session
    try {
      const session = await this.sessionManager.getSession(token);
      if (session) {
        const oauth2Client = await this.getGoogleOAuthClient();
        await oauth2Client.revokeToken(session.accessToken);
        await this.sessionManager.deleteSession(token);
      }
    } catch (error) {
      // Continue even if revocation fails
      console.error('Failed to revoke Google token:', error);
    }
  }

  /**
   * Get authorization code data (for use in callback handler)
   */
  async getAuthCodeData(authCode: string) {
    return await this.authCodeStore.getAuthCode(authCode);
  }

  /**
   * Handle Google OAuth callback
   * This should be called from your /oauth/callback route
   */
  async handleGoogleCallback(code: string, state: string): Promise<void> {
    const authData = await this.authCodeStore.getAuthCode(state);

    if (!authData) {
      throw new Error('Invalid state parameter');
    }

    // Exchange Google's code for tokens
    const oauth2Client = await this.getGoogleOAuthClient();

    // Explicitly construct and pass redirect_uri to match Google's requirements
    const apiEndpoint = process.env.API_ENDPOINT;
    if (!apiEndpoint) {
      throw new Error('API_ENDPOINT environment variable is required');
    }
    const redirectUri = `${apiEndpoint}/google/callback`;

    const { tokens } = await oauth2Client.getToken({
      code: code,
      redirect_uri: redirectUri,
    });

    if (!tokens.access_token) {
      throw new Error('No access token received from Google');
    }

    // Get user info
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();

    // Update authorization code with Google tokens in DynamoDB
    await this.authCodeStore.updateWithGoogleTokens(state, code, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      expiresAt: tokens.expiry_date || Date.now() + (3600 * 1000),
      userEmail: userInfo.data.email || undefined,
    });
  }
}
