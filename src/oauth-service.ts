/**
 * OAuth Service for Google Authentication
 *
 * Handles the complete OAuth 2.1 flow:
 * 1. Generate authorization URL
 * 2. Exchange authorization code for tokens
 * 3. Refresh expired tokens
 * 4. Validate tokens
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { google, Auth } from 'googleapis';
import { SessionManager } from './session-manager.js';
import { AuthenticationError } from './types.js';
import * as crypto from 'crypto';

interface GoogleOAuthCredentials {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
}

export class OAuthService {
  private credentials: GoogleOAuthCredentials | null = null;
  private sessionManager: SessionManager;
  private readonly ssmClient: SSMClient;
  private readonly parameterName: string;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.ssmClient = new SSMClient({});
    this.parameterName = process.env.GOOGLE_OAUTH_PARAMETER_NAME || '/google-contacts-mcp/oauth-credentials';
  }

  /**
   * Load Google OAuth credentials from AWS Systems Manager Parameter Store
   */
  private async loadCredentials(): Promise<GoogleOAuthCredentials> {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      const response = await this.ssmClient.send(
        new GetParameterCommand({
          Name: this.parameterName,
          WithDecryption: true, // Required for SecureString parameters
        })
      );

      if (!response.Parameter?.Value) {
        throw new Error('Parameter value is empty');
      }

      this.credentials = JSON.parse(response.Parameter.Value);
      return this.credentials!;
    } catch (error: any) {
      throw new AuthenticationError(`Failed to load OAuth credentials: ${error.message}`);
    }
  }

  /**
   * Create OAuth2 client
   */
  private async createOAuth2Client(): Promise<Auth.OAuth2Client> {
    const credentials = await this.loadCredentials();
    return new google.auth.OAuth2(
      credentials.client_id,
      credentials.client_secret,
      credentials.redirect_uri
    );
  }

  /**
   * Generate authorization URL for user to authenticate with Google
   */
  async getAuthorizationUrl(state?: string): Promise<string> {
    const oauth2Client = await this.createOAuth2Client();

    // Generate secure state parameter if not provided
    const stateParam = state || crypto.randomBytes(32).toString('hex');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline', // Get refresh token
      scope: ['https://www.googleapis.com/auth/contacts.readonly'],
      state: stateParam,
      prompt: 'consent', // Force consent screen to get refresh token
    });

    return authUrl;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code: string): Promise<{
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }> {
    const oauth2Client = await this.createOAuth2Client();

    try {
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token) {
        throw new AuthenticationError('No access token received from Google');
      }

      // Get user info to store email (minimal PII)
      oauth2Client.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      const userEmail = userInfo.data.email || undefined;

      // Generate session ID
      const sessionId = crypto.randomUUID();

      // Calculate expiry
      const expiresAt = tokens.expiry_date || Date.now() + (3600 * 1000);

      // Save session to DynamoDB
      await this.sessionManager.saveSession({
        sessionId,
        userEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        expiresAt,
        tokenType: tokens.token_type || 'Bearer',
        scope: tokens.scope || 'https://www.googleapis.com/auth/contacts.readonly',
      });

      return {
        sessionId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt,
      };
    } catch (error: any) {
      throw new AuthenticationError(`Failed to exchange code for tokens: ${error.message}`);
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(sessionId: string): Promise<string> {
    const session = await this.sessionManager.getSession(sessionId);

    if (!session) {
      throw new AuthenticationError('Session not found or expired');
    }

    if (!session.refreshToken) {
      throw new AuthenticationError('No refresh token available');
    }

    const oauth2Client = await this.createOAuth2Client();
    oauth2Client.setCredentials({
      refresh_token: session.refreshToken,
    });

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();

      if (!credentials.access_token) {
        throw new AuthenticationError('No access token received from refresh');
      }

      const expiresAt = credentials.expiry_date || Date.now() + (3600 * 1000);

      // Update session with new token
      await this.sessionManager.updateAccessToken(sessionId, credentials.access_token, expiresAt);

      return credentials.access_token;
    } catch (error: any) {
      // If refresh fails, delete the session (user needs to re-authenticate)
      await this.sessionManager.deleteSession(sessionId);
      throw new AuthenticationError(`Failed to refresh token: ${error.message}`);
    }
  }

  /**
   * Get valid access token for session (refreshes if expired)
   */
  async getValidAccessToken(sessionId: string): Promise<string> {
    const session = await this.sessionManager.getSession(sessionId);

    if (!session) {
      throw new AuthenticationError('Session not found. Please authenticate.');
    }

    // Check if token is close to expiry (within 5 minutes)
    const expiryBuffer = 5 * 60 * 1000; // 5 minutes
    if (session.expiresAt - Date.now() < expiryBuffer) {
      // Token expired or close to expiry, refresh it
      return await this.refreshAccessToken(sessionId);
    }

    return session.accessToken;
  }

  /**
   * Get authenticated OAuth2 client for a session
   */
  async getAuthenticatedClient(sessionId: string): Promise<Auth.OAuth2Client> {
    const accessToken = await this.getValidAccessToken(sessionId);
    const oauth2Client = await this.createOAuth2Client();
    oauth2Client.setCredentials({ access_token: accessToken });
    return oauth2Client;
  }

  /**
   * Revoke token and delete session (logout)
   */
  async revokeSession(sessionId: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);

    if (session) {
      try {
        // Revoke token with Google
        const oauth2Client = await this.createOAuth2Client();
        await oauth2Client.revokeToken(session.accessToken);
      } catch (error) {
        // Continue even if revocation fails
        console.error('Failed to revoke token:', error);
      }

      // Delete session from DynamoDB
      await this.sessionManager.deleteSession(sessionId);
    }
  }
}
