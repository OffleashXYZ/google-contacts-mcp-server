/**
 * DynamoDB Authorization Code Storage
 *
 * Stores OAuth authorization codes temporarily during the OAuth flow.
 * Authorization codes are short-lived (10 minutes) and automatically cleaned up via TTL.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

export interface AuthorizationCodeData {
  authCode: string; // Primary key
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state?: string;
  googleAuthCode?: string;
  googleTokens?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    userEmail?: string;
  };
  scopes?: string[];
  createdAt: number;
  ttl: number; // DynamoDB TTL (auto-delete after 10 minutes)
}

export class AuthCodeStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string) {
    const dynamoClient = new DynamoDBClient({});
    this.client = DynamoDBDocumentClient.from(dynamoClient);
    this.tableName = tableName || process.env.AUTH_CODES_TABLE_NAME || 'google-contacts-mcp-auth-codes';
  }

  /**
   * Store authorization code data
   */
  async saveAuthCode(
    authCode: string,
    data: Omit<AuthorizationCodeData, 'authCode' | 'ttl' | 'createdAt'>
  ): Promise<void> {
    const now = Date.now();
    // Authorization codes expire after 10 minutes
    const TEN_MINUTES = 10 * 60; // 10 minutes in seconds
    const ttl = Math.floor(now / 1000) + TEN_MINUTES;

    const item: AuthorizationCodeData = {
      authCode,
      ...data,
      createdAt: now,
      ttl,
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      })
    );
  }

  /**
   * Retrieve authorization code data
   */
  async getAuthCode(authCode: string): Promise<AuthorizationCodeData | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { authCode },
      })
    );

    if (!result.Item) {
      return null;
    }

    const data = result.Item as AuthorizationCodeData;

    // Check if code is expired (older than 10 minutes)
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    if (Date.now() - data.createdAt > TEN_MINUTES_MS) {
      // Code expired, delete it
      await this.deleteAuthCode(authCode);
      return null;
    }

    return data;
  }

  /**
   * Update authorization code with Google tokens
   */
  async updateWithGoogleTokens(
    authCode: string,
    googleAuthCode: string,
    googleTokens: {
      accessToken: string;
      refreshToken?: string;
      expiresAt: number;
      userEmail?: string;
    }
  ): Promise<void> {
    // Retrieve existing data
    const existingData = await this.getAuthCode(authCode);
    if (!existingData) {
      throw new Error('Authorization code not found or expired');
    }

    // Update with Google tokens
    const updatedData: AuthorizationCodeData = {
      ...existingData,
      googleAuthCode,
      googleTokens,
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: updatedData,
      })
    );
  }

  /**
   * Delete authorization code (after use or expiration)
   */
  async deleteAuthCode(authCode: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { authCode },
      })
    );
  }
}
