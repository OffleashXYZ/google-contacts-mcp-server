/**
 * Express Application Setup for Google Contacts MCP Server
 * With OAuth 2.1 Support
 *
 * Developed by Offleash (offleash.xyz)
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { McpService } from './mcp-service.js';
import { SessionManager } from './session-manager.js';
import { OAuthClientStore } from './oauth-client-store.js';
import { GoogleOAuthProvider } from './oauth-provider.js';
import { fileURLToPath } from 'url';
import path from 'path';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

// Trust proxy - required for Lambda behind API Gateway
app.set('trust proxy', true);

// Initialize services
const sessionManager = new SessionManager();
const clientStore = new OAuthClientStore();
const oauthProvider = new GoogleOAuthProvider(clientStore, sessionManager);
const mcpService = new McpService(oauthProvider);

// Get API endpoint from environment (required)
const apiEndpoint = process.env.API_ENDPOINT;
if (!apiEndpoint) {
  throw new Error('API_ENDPOINT environment variable is required');
}

// Middleware: Parse JSON bodies
app.use(express.json());

// Middleware: Parse URL-encoded bodies (for OAuth token endpoint)
app.use(express.urlencoded({ extended: true }));

// Middleware: Serve static files (logo, etc.)
// Use absolute path for Lambda compatibility
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Middleware: Logging (only in development)
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`${req.method} ${req.path}`);
  }
  next();
});

// Install MCP OAuth 2.1 router at root
// This creates standard endpoints: /.well-known/oauth-authorization-server, /register, /token, etc.
app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(apiEndpoint),
    resourceServerUrl: new URL(`${apiEndpoint}/mcp`), // Resource at /mcp path
    scopesSupported: ['contacts.readonly'],
    resourceName: 'Google Contacts MCP',
    serviceDocumentationUrl: new URL('https://offleash.xyz'),
    tokenOptions: {
      rateLimit: { validate: { trustProxy: false } }, // Disable trust proxy validation
    },
    clientRegistrationOptions: {
      rateLimit: { validate: { trustProxy: false } },
    },
    authorizationOptions: {
      rateLimit: { validate: { trustProxy: false } },
    },
    revocationOptions: {
      rateLimit: { validate: { trustProxy: false } },
    },
  })
);

// Health check endpoint with DynamoDB connectivity test
app.get('/health', async (_req: Request, res: Response) => {
  try {
    // Test DynamoDB connectivity by attempting a read
    await sessionManager.getSession('__health_check__');
    res.json({
      status: 'healthy',
      service: 'Google Contacts MCP Server',
      version: '1.0.0',
      provider: 'Offleash',
      checks: {
        dynamodb: 'ok',
      },
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'unhealthy',
      service: 'Google Contacts MCP Server',
      error: 'Database connectivity failed',
    });
  }
});

// Google OAuth callback handler
// This bridges Google OAuth with MCP OAuth flow
app.get('/google/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(`
        <html>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h1 style="color: #d32f2f;">Authentication Failed</h1>
            <p>Error: ${error}</p>
            <p>Please try connecting again from Claude.</p>
          </body>
        </html>
      `);
    }

    if (!code || typeof code !== 'string' || !state || typeof state !== 'string') {
      return res.status(400).send(`
        <html>
          <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h1 style="color: #d32f2f;">Authentication Failed</h1>
            <p>Missing authorization code or state parameter</p>
            <p>Please try connecting again from Claude.</p>
          </body>
        </html>
      `);
    }

    // Handle Google callback and complete the OAuth flow
    await oauthProvider.handleGoogleCallback(code, state);

    // Get the authorization data to retrieve redirect URI
    const authData = await oauthProvider.getAuthCodeData(state);
    if (!authData) {
      throw new Error('Authorization session expired');
    }

    // Redirect back to MCP client with authorization code (state)
    const redirectUrl = new URL(authData.redirectUri);
    redirectUrl.searchParams.set('code', state); // Use the state as our authorization code
    redirectUrl.searchParams.set('state', authData.state || '');

    return res.redirect(redirectUrl.toString());
  } catch (error: any) {
    console.error('Google callback error:', error);
    return res.status(500).send(`
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h1 style="color: #d32f2f;">Authentication Error</h1>
          <p>${error.message}</p>
          <p>Please try connecting again from Claude.</p>
        </body>
      </html>
    `);
  }
});

// MCP: Handle all MCP protocol requests (protected with Bearer auth)
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    // Extract bearer token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401)
        .header('WWW-Authenticate', `Bearer realm="${apiEndpoint}"`)
        .json({
          error: 'unauthorized',
          message: 'Missing or invalid Authorization header',
        });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token with OAuth provider
    try {
      const authInfo = await oauthProvider.verifyAccessToken(token);
      // Store auth info in request for MCP service to use
      (req as any).authInfo = authInfo;
    } catch (error) {
      return res.status(401)
        .header('WWW-Authenticate', `Bearer realm="${apiEndpoint}", error="invalid_token"`)
        .json({
          error: 'invalid_token',
          message: 'The access token is invalid or expired',
        });
    }

    // Handle MCP request
    return await mcpService.handleRequest(req, res);
  } catch (error: any) {
    // Only send error response if headers haven't been sent yet
    // (the MCP transport may have already sent a response)
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'MCP request failed',
        message: error.message,
      });
    }
    // If headers were already sent, just log the error
    console.error('Error after response sent:', error);
  }
});

// MCP: Handle GET - Return 401 with OAuth metadata to trigger authentication
app.get('/mcp', (_req: Request, res: Response) => {
  res.status(401)
    .header('WWW-Authenticate', `Bearer realm="${apiEndpoint}"`)
    .json({
      error: 'unauthorized',
      message: 'Authentication required. Please connect via Claude Desktop or Claude Web.',
      oauth_metadata_url: `${apiEndpoint}/.well-known/oauth-authorization-server`,
    });
});

// MCP: Handle DELETE (not used in stateless MCP)
app.delete('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    error: 'Method not allowed',
    message: 'Use the OAuth token revocation endpoint instead',
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    message: `Endpoint ${req.path} not found`,
    availableEndpoints: [
      'GET /health',
      'GET /.well-known/oauth-authorization-server (OAuth metadata)',
      'POST /register (Dynamic client registration)',
      'GET /authorize (OAuth authorization)',
      'POST /token (Token exchange)',
      'POST /revoke (Token revocation)',
      'GET /google/callback (Google OAuth callback)',
      'POST /mcp (MCP server - requires Bearer token)',
    ],
  });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message,
  });
});

export default app;
