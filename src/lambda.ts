/**
 * AWS Lambda Handler for Google Contacts MCP Server
 *
 * Developed by Offleash (offleash.xyz)
 *
 * Entry point for Lambda function that wraps Express app
 * with serverless-http for AWS Lambda compatibility
 */

import serverless from 'serverless-http';
import { Context } from 'aws-lambda';
import app from './app.js';

// Wrap Express app with serverless-http
// Enable binary media type support for images
const serverlessHandler = serverless(app, {
  binary: ['image/*', 'application/octet-stream'],
});

/**
 * Lambda handler function
 * Supports both API Gateway HTTP API (v2) and REST API (v1) formats
 */
export const handler = async (event: any, context: Context): Promise<any> => {
  // Log request for debugging (sanitize sensitive headers)
  const sanitizedHeaders = { ...event.headers };
  delete sanitizedHeaders.authorization;
  delete sanitizedHeaders.Authorization;

  // Support both HTTP API v2 and REST API v1 formats
  const path = event.rawPath || event.path;
  const method = event.requestContext?.http?.method || event.httpMethod;

  console.log('Incoming request:', {
    path,
    method,
    headers: sanitizedHeaders,
  });

  // Call serverless handler
  const result = await serverlessHandler(event, context);

  return result;
};
