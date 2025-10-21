/**
 * DynamoDB-backed OAuth Client Store for MCP OAuth 2.1
 *
 * Stores registered OAuth clients (Claude Desktop, Claude Web, etc.)
 * Supports Dynamic Client Registration (DCR)
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import * as crypto from 'crypto';

export class OAuthClientStore implements OAuthRegisteredClientsStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName?: string) {
    const dynamoClient = new DynamoDBClient({});
    this.client = DynamoDBDocumentClient.from(dynamoClient);
    this.tableName = tableName || process.env.OAUTH_CLIENTS_TABLE_NAME || 'google-contacts-mcp-oauth-clients';
  }

  /**
   * Get registered client by client ID
   */
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    try {
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { client_id: clientId },
        })
      );

      if (!result.Item) {
        return undefined;
      }

      return result.Item as OAuthClientInformationFull;
    } catch (error) {
      console.error('Error getting client:', error);
      return undefined;
    }
  }

  /**
   * Register a new OAuth client (Dynamic Client Registration)
   */
  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    const issuedAt = Math.floor(Date.now() / 1000);

    // Client secrets expire after 1 year (can be adjusted)
    const expiresAt = issuedAt + (365 * 24 * 60 * 60);

    // Get API endpoint for logo URL
    const apiEndpoint = process.env.API_ENDPOINT;
    if (!apiEndpoint) {
      throw new Error('API_ENDPOINT environment variable is required');
    }

    const fullClient: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_secret: clientSecret,
      client_secret_expires_at: expiresAt,
      // Default to 'client_secret_post' if not specified
      token_endpoint_auth_method: client.token_endpoint_auth_method || 'client_secret_post',
      // Add logo URI if not already provided
      logo_uri: client.logo_uri || `${apiEndpoint}/logo.png`,
    };

    // Store in DynamoDB
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: fullClient,
      })
    );

    return fullClient;
  }
}
