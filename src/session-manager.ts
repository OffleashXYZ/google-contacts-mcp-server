/**
 * DynamoDB Session Manager for OAuth Token Storage
 *
 * Privacy-First Design:
 * - Stores ONLY OAuth tokens (access_token, refresh_token, expiry)
 * - NO contact data is ever stored
 * - Tokens auto-expire via DynamoDB TTL
 * - Minimal PII (user email for indexing)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export interface SessionData {
  sessionId: string;
  clientId?: string;
  userEmail?: string;
  accessToken: string; // Google access token
  refreshToken?: string; // Google refresh token
  mcpRefreshToken?: string; // MCP refresh token (given to Claude)
  expiresAt: number; // Unix timestamp
  tokenType: string;
  scope: string;
  ttl: number; // DynamoDB TTL (auto-delete expired sessions)
  createdAt: number;
  updatedAt: number;
}

export class SessionManager {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string) {
    const dynamoClient = new DynamoDBClient({});
    this.client = DynamoDBDocumentClient.from(dynamoClient);
    this.tableName = tableName || process.env.SESSIONS_TABLE_NAME || 'google-contacts-mcp-sessions';
  }

  /**
   * Save OAuth session data (tokens only!)
   */
  async saveSession(sessionData: Omit<SessionData, 'ttl' | 'createdAt' | 'updatedAt'>): Promise<void> {
    const now = Date.now();
    // Set TTL to 90 days from now (not tied to access token expiry)
    // This allows sessions to persist even as access tokens are refreshed
    const NINETY_DAYS = 90 * 24 * 60 * 60; // 90 days in seconds
    const ttl = Math.floor(now / 1000) + NINETY_DAYS;

    const item: SessionData = {
      ...sessionData,
      ttl,
      createdAt: now,
      updatedAt: now,
    };

    // Save main session with sessionId = access token
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      })
    );

    // Also save a mapping from MCP refresh token to access token for refresh lookups
    if (sessionData.mcpRefreshToken) {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            sessionId: `refresh:${sessionData.mcpRefreshToken}`, // Prefix to avoid collisions
            accessTokenSessionId: sessionData.sessionId, // Points to the real session
            ttl,
            createdAt: now,
            updatedAt: now,
          },
        })
      );
    }
  }

  /**
   * Retrieve session by sessionId
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { sessionId },
      })
    );

    if (!result.Item) {
      return null;
    }

    const session = result.Item as SessionData;

    // Check if token is expired
    if (session.expiresAt < Date.now()) {
      // Token expired, delete it
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  /**
   * Update access token (after refresh)
   * Also extends the session TTL by 90 days (sliding expiration)
   */
  async updateAccessToken(
    sessionId: string,
    accessToken: string,
    expiresAt: number
  ): Promise<void> {
    const now = Date.now();
    // Extend TTL by 90 days on each token refresh (sliding expiration)
    const NINETY_DAYS = 90 * 24 * 60 * 60;
    const ttl = Math.floor(now / 1000) + NINETY_DAYS;

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { sessionId },
        UpdateExpression: 'SET accessToken = :token, expiresAt = :expires, ttl = :ttl, updatedAt = :updated',
        ExpressionAttributeValues: {
          ':token': accessToken,
          ':expires': expiresAt,
          ':ttl': ttl,
          ':updated': now,
        },
      })
    );
  }

  /**
   * Delete session (logout or expired)
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { sessionId },
      })
    );
  }

  /**
   * Check if session exists and is valid
   */
  async isSessionValid(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    return session !== null;
  }

  /**
   * Get session by refresh token
   */
  async getSessionByRefreshToken(refreshToken: string): Promise<SessionData | null> {
    // Look up the mapping from refresh token to access token session
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { sessionId: `refresh:${refreshToken}` },
      })
    );

    if (!result.Item || !(result.Item as any).accessTokenSessionId) {
      return null;
    }

    // Get the actual session using the access token session ID
    const accessTokenSessionId = (result.Item as any).accessTokenSessionId;
    return await this.getSession(accessTokenSessionId);
  }
}
