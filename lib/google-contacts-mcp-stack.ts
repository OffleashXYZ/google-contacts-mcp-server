import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GoogleContactsMcpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Use RETAIN by default to preserve data on stack deletion
    const removalPolicy = cdk.RemovalPolicy.RETAIN;

    // DynamoDB table for storing OAuth tokens (NO contact data)
    const sessionsTable = new dynamodb.Table(this, 'McpSessionsTable', {
      tableName: 'google-contacts-mcp-sessions',
      partitionKey: {
        name: 'sessionId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', // Auto-delete expired tokens
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: removalPolicy,
    });

    // Add GSI for querying by user email (optional)
    sessionsTable.addGlobalSecondaryIndex({
      indexName: 'userEmailIndex',
      partitionKey: {
        name: 'userEmail',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // DynamoDB table for OAuth client registrations (DCR - Dynamic Client Registration)
    const oauthClientsTable = new dynamodb.Table(this, 'OAuthClientsTable', {
      tableName: 'google-contacts-mcp-oauth-clients',
      partitionKey: {
        name: 'client_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: removalPolicy,
    });

    // DynamoDB table for authorization codes (temporary storage during OAuth flow)
    const authCodesTable = new dynamodb.Table(this, 'AuthCodesTable', {
      tableName: 'google-contacts-mcp-auth-codes',
      partitionKey: {
        name: 'authCode',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', // Auto-delete expired codes (10 minutes)
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: removalPolicy,
    });

    // Parameter Store for Google OAuth client credentials
    // Note: redirect_uri is constructed dynamically as {API_ENDPOINT}/google/callback
    // IMPORTANT: After deployment, update this parameter manually via AWS Console/CLI with
    // actual credentials. To make it SecureString, use:
    // aws ssm put-parameter --name "/google-contacts-mcp/oauth-credentials" --value '{"client_id":"...","client_secret":"..."}' --type SecureString --overwrite
    const googleOAuthParameter = new ssm.StringParameter(this, 'GoogleOAuthParameter', {
      parameterName: '/google-contacts-mcp/oauth-credentials',
      description: 'Google OAuth 2.0 client ID and secret for MCP server',
      stringValue: JSON.stringify({
        client_id: 'REPLACE_WITH_YOUR_CLIENT_ID',
        client_secret: 'REPLACE_WITH_YOUR_CLIENT_SECRET'
      }),
      tier: ssm.ParameterTier.STANDARD,
    });

    // Lambda function for MCP server
    const mcpLambda = new lambda.Function(this, 'McpServerFunction', {
      functionName: 'google-contacts-mcp-server',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'dist/lambda.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda-package')),
      timeout: cdk.Duration.seconds(29), // API Gateway timeout is 29s
      memorySize: 512,
      environment: {
        SESSIONS_TABLE_NAME: sessionsTable.tableName,
        OAUTH_CLIENTS_TABLE_NAME: oauthClientsTable.tableName,
        AUTH_CODES_TABLE_NAME: authCodesTable.tableName,
        GOOGLE_OAUTH_PARAMETER_NAME: googleOAuthParameter.parameterName,
        API_ENDPOINT: '', // Will be set after deployment
        NODE_ENV: 'production',
      },
      tracing: lambda.Tracing.ACTIVE, // Enable X-Ray
    });

    // Grant Lambda permissions to DynamoDB tables
    sessionsTable.grantReadWriteData(mcpLambda);
    oauthClientsTable.grantReadWriteData(mcpLambda);
    authCodesTable.grantReadWriteData(mcpLambda);

    // Grant Lambda permissions to read Google OAuth parameter from Parameter Store
    googleOAuthParameter.grantRead(mcpLambda);

    // API Gateway HTTP API with CORS
    const httpApi = new apigatewayv2.HttpApi(this, 'McpHttpApi', {
      apiName: 'google-contacts-mcp-api',
      description: 'HTTP API for Google Contacts MCP Server',
      corsPreflight: {
        allowOrigins: [
          'https://claude.ai',
          'https://anthropic.ai',
        ],
        allowHeaders: [
          'Content-Type',
          'Mcp-Session-Id',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: cdk.Duration.days(1),
      },
    });

    // Lambda integration (defaults to HTTP API v2 payload format)
    const mcpIntegration = new integrations.HttpLambdaIntegration(
      'McpLambdaIntegration',
      mcpLambda
    );

    // Add root route for base path
    httpApi.addRoutes({
      path: '/',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.DELETE,
        apigatewayv2.HttpMethod.HEAD,
      ],
      integration: mcpIntegration,
    });

    // Add catch-all route to forward all requests to Lambda
    httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.DELETE,
        apigatewayv2.HttpMethod.HEAD,
      ],
      integration: mcpIntegration,
    });

    // Update Lambda environment with API endpoint URL
    mcpLambda.addEnvironment('API_ENDPOINT', httpApi.apiEndpoint);

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API Gateway endpoint URL',
      exportName: 'GoogleContactsMcpApiEndpoint',
    });

    new cdk.CfnOutput(this, 'McpServerUrl', {
      value: `${httpApi.apiEndpoint}/mcp`,
      description: 'MCP Server URL (use this in Claude configuration)',
      exportName: 'GoogleContactsMcpServerUrl',
    });

    new cdk.CfnOutput(this, 'GoogleCallbackUrl', {
      value: `${httpApi.apiEndpoint}/google/callback`,
      description: 'Google OAuth callback URL (add this to Google Cloud Console)',
      exportName: 'GoogleContactsMcpGoogleCallbackUrl',
    });

    new cdk.CfnOutput(this, 'OAuthMetadataUrl', {
      value: `${httpApi.apiEndpoint}/.well-known/oauth-authorization-server`,
      description: 'OAuth 2.1 metadata endpoint for MCP clients',
      exportName: 'GoogleContactsMcpOAuthMetadataUrl',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: sessionsTable.tableName,
      description: 'DynamoDB table for session storage',
    });

    new cdk.CfnOutput(this, 'OAuthClientsTableName', {
      value: oauthClientsTable.tableName,
      description: 'DynamoDB table for OAuth client registrations',
    });

    new cdk.CfnOutput(this, 'GoogleOAuthParameterName', {
      value: googleOAuthParameter.parameterName,
      description: 'Parameter Store name for Google OAuth credentials',
    });

    new cdk.CfnOutput(this, 'AuthCodesTableName', {
      value: authCodesTable.tableName,
      description: 'DynamoDB table for authorization code storage',
    });
  }
}
