#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { GoogleContactsMcpStack } from '../lib/google-contacts-mcp-stack';

const app = new cdk.App();

new GoogleContactsMcpStack(app, 'GoogleContactsMcpStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  description: 'Serverless Google Contacts MCP Server with Lambda, API Gateway, and DynamoDB',
});

app.synth();
