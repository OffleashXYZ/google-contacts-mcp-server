# OAuth 2.1 Setup Guide

## Overview

This MCP server now implements **OAuth 2.1** with automatic authentication for a seamless user experience.

**Zero-config user experience:**
```json
{
  "mcpServers": {
    "google-contacts": {
      "url": "https://your-api.amazonaws.com/mcp"
    }
  }
}
```

That's it! No headers, no manual session IDs. Claude handles authentication automatically.

## Architecture

### OAuth 2.1 Flow

1. **User adds MCP server URL to Claude**
2. **Claude discovers OAuth metadata** at `/.well-known/oauth-authorization-server`
3. **Claude registers itself** as an OAuth client (Dynamic Client Registration)
4. **User gets redirected to authorize** → Google OAuth flow
5. **Claude receives access token** automatically
6. **All future requests** use Bearer tokens

### Components

- **MCP OAuth Router**: Standard OAuth 2.1 endpoints (`/authorize`, `/token`, `/register`, `/revoke`)
- **Google OAuth Provider**: Bridges Google OAuth with MCP OAuth
- **Session Manager**: 90-day sessions with sliding expiration
- **OAuth Client Store**: Stores registered OAuth clients (Claude instances)
- **Auth Code Store**: Temporary storage for authorization codes (10-minute TTL)
- **Bearer Auth**: Protects `/mcp` endpoint

## Deployment

### Step 1: Deploy Infrastructure

```bash
npm install
npm run build
npm run build:lambda
npm run cdk:deploy
```

**Save these outputs:**
- `ApiEndpoint`: Your API Gateway URL
- `McpServerUrl`: The MCP endpoint (use in Claude)
- `GoogleCallbackUrl`: Add to Google Cloud Console

### Step 2: Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **People API**
3. Create OAuth 2.0 credentials (Web application)
4. Add the `GoogleCallbackUrl` from CDK outputs to "Authorized redirect URIs"
5. Note your `client_id` and `client_secret`

### Step 3: Store Google Credentials

Update the Parameter Store with your Google OAuth credentials:

```bash
aws ssm put-parameter \
  --name "/google-contacts-mcp/oauth-credentials" \
  --value '{"client_id":"YOUR_GOOGLE_CLIENT_ID","client_secret":"YOUR_GOOGLE_CLIENT_SECRET"}' \
  --type String \
  --overwrite \
  --region us-west-2
```

**Note:** The redirect URI is constructed dynamically as `${API_ENDPOINT}/google/callback` - you don't need to store it.

## Usage

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-contacts": {
      "url": "https://your-api-id.execute-api.region.amazonaws.com/mcp"
    }
  }
}
```

Restart Claude Desktop. On first use, Claude will automatically:
1. Discover OAuth endpoints
2. Register as a client
3. Open your browser for Google authentication
4. Store the access token securely

### Claude Web

1. Add MCP server in Claude settings
2. Enter URL: `https://your-api-id.execute-api.region.amazonaws.com/mcp`
3. Click connect
4. Authenticate with Google when prompted

## How It Works

### Dynamic Client Registration (DCR)

When Claude connects for the first time:

```
Claude → POST /register
       → Receives client_id & client_secret
       → Stores credentials securely
```

### Authorization Flow

When authentication is needed:

```
Claude → GET /authorize?client_id=...&code_challenge=...
       → Redirects to Google OAuth
User   → Authenticates with Google
Google → Redirects to /google/callback?code=...&state=...
Server → Exchanges Google code for tokens
       → Redirects back to Claude with authorization code
Claude → POST /token (exchanges auth code for access token)
       → Stores access token
```

### Making Requests

All MCP requests include Bearer token:

```
POST /mcp
Authorization: Bearer <access_token>

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {...}
}
```

### Token Refresh

- Access tokens expire after 1 hour
- Refresh tokens last 90 days (with sliding expiration)
- Tokens auto-refresh on each use
- With regular use, session never expires!

## OAuth Endpoints

### Metadata Discovery

**GET** `/.well-known/oauth-authorization-server`

Returns OAuth server configuration (automatically discovered by Claude).

### Client Registration

**POST** `/register`

Dynamic Client Registration endpoint. Claude calls this automatically to register itself.

### Authorization

**GET** `/authorize`

OAuth authorization endpoint. Redirects to Google for authentication.

### Token Exchange

**POST** `/token`

Exchanges authorization code for access token, or refresh token for new access token.

### Token Revocation

**POST** `/revoke`

Revokes access or refresh tokens.

## Security

### What's Stored

**DynamoDB Sessions Table:**
- MCP access tokens & refresh tokens
- Google OAuth tokens (access & refresh)
- User email
- Client ID
- 90-day TTL with sliding expiration

**DynamoDB OAuth Clients Table:**
- Claude instance registrations (Dynamic Client Registration)
- Client IDs & secrets
- Client metadata (redirect URIs, etc.)

**DynamoDB Auth Codes Table:**
- Temporary authorization codes during OAuth flow
- Google tokens during code exchange
- 10-minute TTL (auto-cleanup)

**Parameter Store:**
- Google OAuth client ID & secret

### What's NOT Stored

- Contact data (fetched in real-time)
- Search queries
- User passwords

### Encryption

- All tokens encrypted at rest (AWS-managed DynamoDB encryption)
- HTTPS/TLS for all transport
- Bearer tokens for API authentication
- Google OAuth credentials stored in Parameter Store

## Troubleshooting

### "Authentication required" error

First-time connection - Claude will automatically prompt for authentication. Click the link and authenticate with Google.

### "Invalid token" error

Token expired. Claude should automatically refresh. If not, remove and re-add the MCP server.

### "Client not found" error

Dynamic client registration failed. Check Lambda logs and ensure OAuth endpoints are accessible.

### OAuth metadata not found

Ensure `API_ENDPOINT` environment variable is set correctly in Lambda.

### Google callback fails

1. Verify `GoogleCallbackUrl` is added to Google Cloud Console
2. Check that it matches exactly (including https://)
3. Ensure Google OAuth credentials are stored in Parameter Store

## Development

### Local Testing

OAuth 2.1 requires HTTPS and public URLs, so local testing is challenging. Options:

1. **Use ngrok** to expose localhost
2. **Deploy to AWS** for testing
3. **Mock the OAuth flow** (not recommended)

### Debugging

Enable verbose logging:

```typescript
// In src/app.ts
app.use((req, res, next) => {
  console.log('Request:', {
    method: req.method,
    path: req.path,
    headers: req.headers,
    body: req.body,
  });
  next();
});
```

### Monitoring

Check CloudWatch Logs for:
- OAuth flow errors
- Token refresh failures
- Google API errors

## Migration from Header-Based Auth

If you're migrating from the old header-based authentication:

**Old config:**
```json
{
  "url": "https://api/mcp",
  "headers": {
    "Mcp-Session-Id": "abc-123"
  }
}
```

**New config:**
```json
{
  "url": "https://api/mcp"
}
```

Simply remove the headers section. Claude will handle authentication automatically.

## Cost

OAuth 2.1 implementation adds minimal cost:

- **OAuth Clients Table**: ~$0.01/month (infrequent writes)
- **Auth Codes Table**: ~$0.01/month (temporary storage)
- **Sessions Table**: ~$1-2/month (depending on team size)
- **Parameter Store**: Free (standard String parameter)
- **Lambda**: ~$1-2/month
- **API Gateway**: ~$1-3/month

**Total for 50-person team: ~$3-8/month**

## Advantages Over Header-Based Auth

✅ **Zero-config** - Just paste URL, no headers
✅ **Automatic auth** - Claude handles everything
✅ **Standards-compliant** - OAuth 2.1 with PKCE
✅ **Better security** - No manual session IDs
✅ **Longer sessions** - 90 days with sliding expiration
✅ **Auto-refresh** - Tokens refresh automatically
✅ **Professional UX** - Same as commercial MCP servers

## Support

For issues or questions:
- Check Lambda CloudWatch Logs
- Verify OAuth endpoints are accessible
- Ensure Google OAuth is configured correctly
- Check DynamoDB tables exist and have correct permissions

---

**Developed by** [Offleash](https://offleash.xyz)

**Version**: 1.0.0 (OAuth 2.1)
