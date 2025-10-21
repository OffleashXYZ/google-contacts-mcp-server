/**
 * MCP Service with Streamable HTTP Transport
 *
 * Handles MCP protocol requests over HTTP for Lambda deployment
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Request, Response } from 'express';
import { z } from 'zod';
import { GoogleOAuthProvider } from './oauth-provider.js';
import { SessionManager } from './session-manager.js';
import {
  listContacts,
  getContact,
  searchContacts,
  searchDirectoryContacts,
} from './contacts.js';
import { AuthenticationError, GoogleAPIError } from './types.js';

// Zod schemas for tool input validation
const ListContactsSchema = z.object({
  pageSize: z.number().min(1).max(1000).optional().default(100),
  pageToken: z.string().optional(),
  sortOrder: z
    .enum([
      'LAST_MODIFIED_ASCENDING',
      'LAST_MODIFIED_DESCENDING',
      'FIRST_NAME_ASCENDING',
      'LAST_NAME_ASCENDING',
    ])
    .optional(),
});

const GetContactSchema = z.object({
  resourceName: z.string().min(1).describe('Resource name of the contact (e.g., people/c1234567890)'),
});

const SearchContactsSchema = z.object({
  query: z.string().min(1).describe('Search query (searches across all contact fields)'),
  pageSize: z.number().min(1).max(1000).optional().default(100),
  readMask: z.string().optional().describe('Comma-separated list of fields to return'),
});

const SearchDirectorySchema = z.object({
  query: z.string().min(1).describe('Search query for directory contacts'),
  pageSize: z.number().min(1).max(1000).optional().default(100),
  pageToken: z.string().optional(),
  readMask: z.string().optional(),
});

export class McpService {
  private server: Server;
  private oauthProvider: GoogleOAuthProvider;
  private sessionManager: SessionManager;

  constructor(oauthProvider: GoogleOAuthProvider) {
    this.oauthProvider = oauthProvider;
    this.sessionManager = new SessionManager();

    // Create MCP server instance
    const apiEndpoint = process.env.API_ENDPOINT;
    if (!apiEndpoint) {
      throw new Error('API_ENDPOINT environment variable is required');
    }
    this.server = new Server(
      {
        name: 'google-contacts-mcp',
        title: 'Google Contacts',
        version: '1.0.0',
        websiteUrl: 'https://github.com/OffleashXYZ/google-contacts-mcp-server',
        icons: [
          {
            src: `${apiEndpoint}/logo.png`,
            mimeType: 'image/png',
            sizes: ['1024x1024'],
          },
        ],
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // Handler: List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'list_contacts',
            description:
              'List contacts for the authenticated user. Returns a paginated list of contacts.',
            inputSchema: {
              type: 'object',
              properties: {
                pageSize: {
                  type: 'number',
                  description: 'Number of contacts to return (1-1000, default: 100)',
                  minimum: 1,
                  maximum: 1000,
                },
                pageToken: {
                  type: 'string',
                  description: 'Token for pagination',
                },
                sortOrder: {
                  type: 'string',
                  enum: [
                    'LAST_MODIFIED_ASCENDING',
                    'LAST_MODIFIED_DESCENDING',
                    'FIRST_NAME_ASCENDING',
                    'LAST_NAME_ASCENDING',
                  ],
                  description: 'Sort order for contacts',
                },
              },
            },
          },
          {
            name: 'get_contact',
            description: 'Get detailed information about a specific contact by resource name.',
            inputSchema: {
              type: 'object',
              properties: {
                resourceName: {
                  type: 'string',
                  description: 'Resource name of the contact (e.g., people/c1234567890)',
                },
              },
              required: ['resourceName'],
            },
          },
          {
            name: 'search_contacts',
            description:
              'Search contacts across all fields including names, emails, phone numbers, organizations, and more.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query',
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results to return (1-1000, default: 100)',
                  minimum: 1,
                  maximum: 1000,
                },
                readMask: {
                  type: 'string',
                  description: 'Comma-separated list of specific fields to return (optional)',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'search_directory',
            description:
              'Search directory contacts (Google Workspace only). Only available for Google Workspace accounts.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Search query for directory people',
                },
                pageSize: {
                  type: 'number',
                  description: 'Number of results to return (1-1000, default: 100)',
                  minimum: 1,
                  maximum: 1000,
                },
                pageToken: {
                  type: 'string',
                  description: 'Token for pagination',
                },
                readMask: {
                  type: 'string',
                  description: 'Comma-separated list of fields to return (optional)',
                },
              },
              required: ['query'],
            },
          },
        ],
      };
    });

    // Handler: Execute tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        // Get auth info from extra parameter (passed by transport from req.auth)
        const authInfo = extra?.authInfo;

        if (!authInfo || !authInfo.token) {
          throw new AuthenticationError(
            'Missing authentication. Please authenticate via OAuth.'
          );
        }

        // Get the session using the bearer token
        const session = await this.sessionManager.getSession(authInfo.token);
        if (!session) {
          throw new AuthenticationError('Session not found or expired');
        }

        // Create authenticated Google OAuth client
        const googleOAuthClient = await (this.oauthProvider as any).getGoogleOAuthClient();
        googleOAuthClient.setCredentials({
          access_token: session.accessToken,
          refresh_token: session.refreshToken,
        });

        // Check if token needs refresh
        const expiryBuffer = 5 * 60 * 1000; // 5 minutes
        if (session.expiresAt - Date.now() < expiryBuffer && session.refreshToken) {
          try {
            const { credentials } = await googleOAuthClient.refreshAccessToken();
            if (credentials.access_token) {
              const expiresAt = credentials.expiry_date || Date.now() + ((credentials.expires_in || 3600) * 1000);
              await this.sessionManager.updateAccessToken(authInfo.token, credentials.access_token, expiresAt);
              googleOAuthClient.setCredentials(credentials);
            }
          } catch (error) {
            console.error('Token refresh failed:', error);
            throw new AuthenticationError('Failed to refresh access token');
          }
        }

        const auth = googleOAuthClient;

        // Route to appropriate tool handler
        switch (request.params.name) {
          case 'list_contacts': {
            const args = ListContactsSchema.parse(request.params.arguments || {});
            const result = await listContacts(auth, args.pageSize, args.pageToken, args.sortOrder);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'get_contact': {
            const args = GetContactSchema.parse(request.params.arguments);
            const result = await getContact(auth, args.resourceName);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'search_contacts': {
            const args = SearchContactsSchema.parse(request.params.arguments);
            const result = await searchContacts(auth, args.query, args.pageSize, args.readMask);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'search_directory': {
            const args = SearchDirectorySchema.parse(request.params.arguments);
            const result = await searchDirectoryContacts(
              auth,
              args.query,
              args.pageSize,
              args.pageToken,
              args.readMask
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error: any) {
        if (error instanceof AuthenticationError) {
          throw new McpError(ErrorCode.InvalidRequest, error.message);
        }

        if (error instanceof GoogleAPIError) {
          throw new McpError(ErrorCode.InternalError, `Google API error: ${error.message}`);
        }

        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid parameters: ${error.errors.map((e) => e.message).join(', ')}`
          );
        }

        throw new McpError(ErrorCode.InternalError, `Unexpected error: ${error.message || 'Unknown error'}`);
      }
    });
  }

  /**
   * Handle incoming MCP request via HTTP
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless per-request
      enableJsonResponse: true,
    });

    // Set auth on request object per SDK spec (not in body metadata)
    (req as any).auth = (req as any).authInfo;

    // Cleanup on response close
    res.on('close', () => {
      transport.close();
      // Note: We don't close the server as it's reused across requests
    });

    // Connect transport and handle request
    await this.server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
