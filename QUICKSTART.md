# Quick Start Guide

Deploy your Google Contacts MCP Server with **OAuth 2.1** automatic authentication in ~30 minutes.

**Developed by [Offleash](https://offleash.xyz)**

---

## What You're Building

A serverless MCP server that allows Claude to access Google Contacts with:
- **Zero-config authentication** - Users just paste a URL, no headers needed
- **OAuth 2.1 with PKCE** - Industry-standard secure authentication
- **90-day sessions** - Auto-refreshing tokens, minimal re-authentication
- **Serverless AWS** - Auto-scaling, pay-per-use infrastructure

**User experience:**
```json
{
  "mcpServers": {
    "google-contacts": {
      "url": "https://your-api.amazonaws.com/mcp"
    }
  }
}
```
That's it! Claude handles authentication automatically.

---

## Prerequisites

- ✅ AWS account with CLI configured (`aws configure`)
- ✅ Node.js 18+ installed
- ✅ Google Cloud account
- ✅ AWS CDK installed: `npm install -g aws-cdk`

**Time required**: 30 minutes (first time), 15 minutes (if experienced with CDK)

---

## Step 1: Google Cloud Setup (10 min)

### 1.1 Enable People API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select existing)
3. Navigate to **APIs & Services → Library**
4. Search for "People API" and click **Enable**

### 1.2 Create OAuth Credentials

1. Go to **APIs & Services → OAuth consent screen**
2. Choose **Internal** (for Google Workspace) or **External**
3. Fill in:
   - App name: "Google Contacts MCP"
   - User support email
   - Developer contact email
4. Click "Save and Continue"

5. **Add Scopes**:
   - Click "Add or Remove Scopes"
   - Add these scopes:
     - `https://www.googleapis.com/auth/contacts.readonly`
     - `https://www.googleapis.com/auth/userinfo.email`
   - Click "Update" and "Save and Continue"

6. **Create OAuth Client**:
   - Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**
   - Choose **Web application**
   - Name: "Google Contacts MCP Server"
   - **Authorized redirect URIs**: Leave empty for now (will add after deployment)
   - Click **Create**

7. **Save credentials**:
   - Copy the `Client ID`
   - Copy the `Client secret`
   - You'll need these in Step 3

---

## Step 2: Deploy to AWS (5 min)

### 2.1 Install Dependencies

```bash
cd google-contacts-mcp
npm install
```

### 2.2 Build TypeScript

```bash
npm run build
```

### 2.3 Build Lambda Package

```bash
npm run build:lambda
```

### 2.4 Bootstrap CDK (First time only)

If you've never used CDK in this AWS account/region:

```bash
cdk bootstrap
```

### 2.5 Deploy

```bash
npm run cdk:deploy
```

Review the changes and type `y` to confirm.

### 2.6 Save CDK Outputs

**IMPORTANT**: Save these outputs - you'll need them!

```
✅ ApiEndpoint = https://abc123xyz.execute-api.YOUR-REGION.amazonaws.com
✅ McpServerUrl = https://abc123xyz.execute-api.YOUR-REGION.amazonaws.com/mcp
✅ GoogleCallbackUrl = https://abc123xyz.execute-api.YOUR-REGION.amazonaws.com/google/callback
✅ OAuthMetadataUrl = https://abc123xyz.execute-api.YOUR-REGION.amazonaws.com/.well-known/oauth-authorization-server
```

---

## Step 3: Configure Google OAuth (5 min)

### 3.1 Add Redirect URI to Google

1. Go back to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click on your OAuth 2.0 Client ID
3. Under **Authorized redirect URIs**, click "Add URI"
4. Paste the **GoogleCallbackUrl** from CDK outputs (e.g., `https://abc123xyz.execute-api.YOUR-REGION.amazonaws.com/google/callback`)
5. Click **Save**

### 3.2 Store Credentials in Parameter Store

**Important**: Only store `client_id` and `client_secret` (redirect_uri is constructed automatically)

```bash
aws ssm put-parameter \
  --name "/google-contacts-mcp/oauth-credentials" \
  --value '{"client_id":"YOUR_CLIENT_ID_FROM_GOOGLE","client_secret":"YOUR_CLIENT_SECRET_FROM_GOOGLE"}' \
  --type String \
  --overwrite \
  --region us-west-2
```

Replace `YOUR_CLIENT_ID_FROM_GOOGLE` and `YOUR_CLIENT_SECRET_FROM_GOOGLE` with the values from Step 1, and update the region if needed.

---

## Step 4: Test in Claude (5 min)

### Claude Desktop

**Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add this configuration:

```json
{
  "mcpServers": {
    "google-contacts": {
      "url": "https://abc123xyz.execute-api.YOUR-REGION.amazonaws.com/mcp"
    }
  }
}
```

Replace with your **McpServerUrl** from Step 2.

**Restart Claude Desktop.**

### Claude Web

1. Go to Claude settings
2. Click "Add MCP Server"
3. Enter the **McpServerUrl** from Step 2
4. Click "Connect"

### First Use - Authentication

When you first try to use the MCP server:

1. **Claude will prompt**: "Authentication required for google-contacts"
2. **Click "Authenticate"**
3. **Browser opens** → Sign in with Google
4. **Grant permissions** → Allow access to contacts (read-only)
5. **Done!** Claude stores the access token securely

You only do this once. The session lasts 90 days and auto-refreshes with use.

---

## Test It!

In Claude, try these commands:

**List Contacts:**
```
List my Google contacts
```

**Search Contacts:**
```
Search my contacts for anyone at Acme Corporation
```

**Get Contact Details:**
```
Show me details for John Smith in my contacts
```

**Search Directory** (Google Workspace only):
```
Search our company directory for "engineering"
```

---

## How It Works

### OAuth 2.1 Flow (Automatic)

1. **Claude discovers** your OAuth endpoints via `/.well-known/oauth-authorization-server`
2. **Claude registers** itself as an OAuth client (Dynamic Client Registration)
3. **User authenticates** with Google (one-time)
4. **Claude receives** access token and refresh token
5. **All future requests** use Bearer authentication
6. **Tokens auto-refresh** before expiring

### What's Stored

**DynamoDB (Sessions)**:
- OAuth access tokens (MCP & Google)
- Refresh tokens (MCP & Google)
- User email
- 90-day TTL with sliding expiration

**DynamoDB (OAuth Clients)**:
- Claude instance registrations (Dynamic Client Registration)
- Client IDs & secrets

**DynamoDB (Auth Codes)**:
- Temporary authorization codes during OAuth flow
- 10-minute TTL (short-lived)

**Parameter Store**:
- Google OAuth client ID and secret

**What's NOT stored**:
- Contact data (fetched in real-time)
- Search queries
- Passwords

---

## Troubleshooting

### "Authentication required" on first use

**Expected!** Click the authentication link, sign in with Google, and grant permissions. This only happens once.

### "Invalid token" error

Token expired. Claude should auto-refresh. If not:
1. Remove the MCP server from Claude
2. Re-add it
3. Authenticate again

### "Failed to load OAuth credentials"

Parameter Store issue. Check:
```bash
aws ssm get-parameter \
  --name "/google-contacts-mcp/oauth-credentials" \
  --with-decryption
```

Verify it contains `client_id` and `client_secret`.

### "Invalid redirect URI" during Google auth

1. Go to Google Cloud Console → Credentials
2. Verify the **GoogleCallbackUrl** is added exactly as shown in CDK outputs
3. Must include `https://` and match exactly

### OAuth metadata not found

Lambda doesn't know its URL. Check:
```bash
aws lambda get-function-configuration \
  --function-name google-contacts-mcp-server \
  --query 'Environment.Variables.API_ENDPOINT'
```

Should return your API Gateway URL. If empty, repeat Step 4.

### Claude can't connect

1. Verify the MCP URL matches **McpServerUrl** from CDK outputs
2. Check Lambda CloudWatch Logs for errors
3. Test the endpoint: `curl https://your-api.amazonaws.com/health`

---

## Available Tools

### 1. `list_contacts`
Lists contacts with pagination and sorting.

**Parameters:**
- `pageSize` (optional): 1-1000, default 100
- `pageToken` (optional): For pagination
- `sortOrder` (optional): FIRST_NAME_ASCENDING, LAST_NAME_ASCENDING, etc.

### 2. `get_contact`
Get detailed info for a specific contact.

**Parameters:**
- `resourceName` (required): Contact ID like `people/c1234567890`

### 3. `search_contacts`
Search across all contact fields.

**Parameters:**
- `query` (required): Search term
- `pageSize` (optional): Default 100
- `readMask` (optional): Specific fields to return

### 4. `search_directory`
Search Google Workspace directory (Workspace accounts only).

**Parameters:**
- `query` (required): Search term
- `pageSize` (optional): Default 100
- `pageToken` (optional): For pagination

---

## Monitoring & Operations

### Check Logs

```bash
aws logs tail /aws/lambda/google-contacts-mcp-server --follow
```

### Monitor Costs

Check AWS Cost Explorer for:
- Lambda invocations
- API Gateway requests
- DynamoDB operations

**Expected monthly cost** (50-person team): $3-8/month

### Update Google Credentials

```bash
aws ssm put-parameter \
  --name "/google-contacts-mcp/oauth-credentials" \
  --value '{"client_id":"NEW_ID","client_secret":"NEW_SECRET"}' \
  --type String \
  --overwrite \
  --region us-west-2
```

### Scale

Everything auto-scales:
- **Lambda**: Handles thousands of concurrent requests
- **DynamoDB**: On-demand billing, scales automatically
- **API Gateway**: Unlimited throughput

---

## Advanced Topics

For detailed information on:
- OAuth 2.1 architecture
- Token management
- Security model
- Custom configurations

See [OAUTH2.1-SETUP.md](./OAUTH2.1-SETUP.md)

---

## Costs Breakdown

For a 50-person team with moderate usage (100 requests/day per person):

- **Lambda**: ~$1-2/month
- **API Gateway**: ~$1-3/month
- **DynamoDB**: ~$1-2/month (3 tables: sessions, clients, auth-codes)
- **Parameter Store**: Free (standard String parameter)
- **Data transfer**: Negligible

**Total: $3-7/month**

Scales linearly with usage.

---

## Need Help?

- **Check logs**: CloudWatch Logs for Lambda function
- **Verify config**: `aws ssm get-parameter --name /google-contacts-mcp/oauth-credentials --with-decryption`
- **Test endpoint**: `curl https://your-api.amazonaws.com/health`
- **Deep dive**: See [OAUTH2.1-SETUP.md](./OAUTH2.1-SETUP.md)

**Commercial support**: [Offleash](https://offleash.xyz)

---

## What's Next?

✅ **You're done!** The MCP server is live and accessible from Claude.

**Optional enhancements:**
- Add CloudWatch alarms for errors
- Set up AWS WAF for DDoS protection
- Configure custom domain with Route 53
- Add monitoring with X-Ray (already enabled)

---

**Built by [Offleash](https://offleash.xyz)** | Version 1.0.0 (OAuth 2.1)
