/**
 * Type definitions for Google Contacts MCP Server
 */

export interface ServerConfig {
  name: string;
  version: string;
}

export interface ContactSearchParams {
  query?: string;
  pageSize?: number;
  pageToken?: string;
  readMask?: string;
}

export interface ContactListParams {
  pageSize?: number;
  pageToken?: string;
  sortOrder?: 'LAST_MODIFIED_ASCENDING' | 'LAST_MODIFIED_DESCENDING' | 'FIRST_NAME_ASCENDING' | 'LAST_NAME_ASCENDING';
}

export interface AuthContext {
  accessToken: string;
  tokenType?: string;
}

/**
 * Error types for better error handling
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class GoogleAPIError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'GoogleAPIError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
