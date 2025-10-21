# Google Contacts MCP Server

**Serverless MCP server for Google Contacts with per-user OAuth authentication on AWS Lambda**

Developed by **[Offleash](https://offleash.xyz)**

## Overview

A production-ready Model Context Protocol (MCP) server that enables AI assistants like Claude to access Google Contacts via a secure, serverless architecture. Each employee authenticates with their own Google account, and contact data flows through in real-time without storage.

### Key Features

- **Per-User OAuth 2.1 Authentication** - Each employee uses their own Google Contacts
- **Zero Contact Data Storage** - Only OAuth tokens stored, contacts fetched in real-time
- **Serverless AWS Lambda** - Auto-scaling, pay-per-use, zero infrastructure management
- **Privacy-First DynamoDB** - Stores only tokens with automatic expiration (TTL)
- **Works with Claude Web & Desktop** - Single URL works for both access methods
- **Read-Only Access** - Uses `contacts.readonly` scope only

## Architecture

```
Employee → Claude (Web/Desktop) → API Gateway → Lambda → Google Contacts API
                                       ↓
                                   DynamoDB
                                (OAuth tokens only)
```

### Components

- **AWS Lambda** - Hosts Express.js MCP server with Streamable HTTP transport
- **API Gateway HTTP API** - Exposes `/mcp` endpoint with CORS and OAuth 2.1 endpoints
- **DynamoDB Tables:**
  - `sessions` - Stores OAuth tokens with TTL (no contact data!)
  - `oauth-clients` - Dynamic client registration (DCR)
  - `auth-codes` - Temporary authorization codes (10-minute TTL)
- **AWS Systems Manager Parameter Store** - Stores Google OAuth client credentials
- **AWS CDK** - Infrastructure as Code for deployment

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- AWS Account with CLI configured
- Google Cloud Project with People API enabled
- AWS CDK installed: `npm install -g aws-cdk`

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **People API**
3. Create OAuth 2.0 credentials (Web application type)
4. Note your `client_id` and `client_secret`
5. Add redirect URI (you'll get this after deployment): `https://your-api-id.execute-api.region.amazonaws.com/google/callback`

### 3. Deploy to AWS

```bash
# Build TypeScript
npm run build

# Build Lambda package
npm run build:lambda

# Deploy with CDK
npm run cdk:deploy
```

### 4. Configure OAuth Credentials

After deployment, update the Google OAuth credentials in AWS Systems Manager Parameter Store:

```bash
aws ssm put-parameter \
  --name "/google-contacts-mcp/oauth-credentials" \
  --value '{"client_id":"YOUR_CLIENT_ID","client_secret":"YOUR_CLIENT_SECRET"}' \
  --type String \
  --overwrite \
  --region us-west-2
```

> **Note:** The redirect URI is constructed dynamically as `${API_ENDPOINT}/google/callback` - you don't need to include it in the parameter.

### 5. Add Redirect URI to Google

Copy the `GoogleCallbackUrl` from CDK outputs and add it to your Google OAuth credentials:
- Go to Google Cloud Console → APIs & Services → Credentials
- Edit your OAuth 2.0 Client ID
- Add the callback URL to "Authorized redirect URIs" (e.g., `https://abc123.execute-api.us-west-2.amazonaws.com/google/callback`)

## Usage

### Claude Web

1. Go to Claude.ai → Settings → Integrations
2. Click "Add server"
3. Enter your MCP server URL: `https://your-api-id.execute-api.region.amazonaws.com/mcp`
4. Click "Connect"
5. Authenticate with your Google account when prompted

That's it! Claude will handle the OAuth 2.1 flow automatically.

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

Restart Claude Desktop. When you first use the server, you'll be redirected to authenticate with Google.

## Available Tools

### 1. `list_contacts`

List contacts with pagination.

**Parameters:**
- `pageSize` (optional): Number of contacts (1-1000, default: 100)
- `pageToken` (optional): Pagination token
- `sortOrder` (optional): Sort order (FIRST_NAME_ASCENDING, etc.)

### 2. `get_contact`

Get details for a specific contact.

**Parameters:**
- `resourceName` (required): Contact ID (e.g., `people/c1234567890`)

### 3. `search_contacts`

Search across all contact fields.

**Parameters:**
- `query` (required): Search term
- `pageSize` (optional): Number of results (default: 100)
- `readMask` (optional): Specific fields to return

### 4. `search_directory`

Search Google Workspace directory (Workspace accounts only).

**Parameters:**
- `query` (required): Search term
- `pageSize` (optional): Number of results (default: 100)
- `pageToken` (optional): Pagination token

## Privacy & Security

### What We Store
✅ OAuth access tokens (encrypted, auto-expire)
✅ OAuth refresh tokens (encrypted, auto-expire)
✅ User email (for session management)
✅ Token expiration timestamps

### What We DON'T Store
❌ Contact names, emails, phone numbers
❌ Search queries
❌ Any contact data whatsoever

All contact data flows through the server in real-time and is never persisted.

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Build Lambda package
npm run build:lambda

# Type checking
npm run typecheck

# Deploy to AWS
npm run cdk:deploy

# Destroy AWS resources
npm run cdk:destroy
```

## Project Structure

```
google-contacts-mcp/
├── bin/
│   └── app.ts                    # CDK app entry point
├── lib/
│   └── google-contacts-mcp-stack.ts  # CDK infrastructure definition
├── src/
│   ├── lambda.ts                 # Lambda handler entry point
│   ├── app.ts                    # Express application setup
│   ├── mcp-service.ts            # MCP protocol implementation
│   ├── oauth-provider.ts         # OAuth 2.1 provider implementation
│   ├── oauth-client-store.ts     # DynamoDB OAuth client registry
│   ├── auth-code-store.ts        # DynamoDB authorization code storage
│   ├── session-manager.ts        # DynamoDB session/token storage
│   ├── contacts.ts               # Google Contacts API calls
│   └── types.ts                  # TypeScript type definitions
├── public/
│   └── logo.png                  # Server icon
├── package.json
├── tsconfig.json
├── cdk.json                      # CDK configuration
└── README.md
```

## Costs

With AWS Lambda's pay-per-use model:

- **Lambda**: ~$0.20 per 1M requests
- **API Gateway**: ~$1.00 per 1M requests
- **DynamoDB**: ~$0.25 per 1M read/write requests
- **Parameter Store (Standard String parameter)**: Free (standard throughput)

**Typical monthly cost for a 50-person team: ~$3-8/month**

## Troubleshooting

### "Authentication required"
Click the "Connect" button in Claude and authenticate with your Google account.

### "Invalid or expired access token"
Your session expired. Click "Connect" again to re-authenticate.

### "Failed to load OAuth credentials"
Update the parameter in AWS Systems Manager Parameter Store with your correct Google OAuth client ID and secret.

### "Request is missing required authentication credential" (Google error)
Check that your Google Cloud Console OAuth consent screen includes the correct scopes:
- `https://www.googleapis.com/auth/contacts.readonly`
- `https://www.googleapis.com/auth/userinfo.email`

### "Directory search only available for Google Workspace"
`search_directory` requires a Workspace account. Use `search_contacts` instead.

## Support

- **Documentation**: See [QUICKSTART.md](./QUICKSTART.md)
- **Issues**: [GitHub Issues](https://github.com/OffleashXYZ/google-contacts-mcp-server/issues)
- **Commercial Support**: Contact [Offleash](https://offleash.xyz)

## License

This project is licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**.

**What this means:**
- ✅ Free to use for personal and internal company purposes
- ✅ Must give credit to Offleash
- ❌ Cannot be sold or used commercially
- ❌ Modifications must use the same license

See [LICENSE](./LICENSE) file for full terms or visit https://creativecommons.org/licenses/by-nc-sa/4.0/

## About Offleash

Built by [Offleash](https://offleash.xyz) - Empowering teams with AI-powered tools.

---

**Version**: 1.0.0
**Last Updated**: October 2025
