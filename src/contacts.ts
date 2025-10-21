/**
 * Google Contacts API service layer
 *
 * All operations are READ-ONLY for security
 * No data is cached or stored - direct passthrough to Google API
 */

import { google, people_v1 } from 'googleapis';
import { Auth } from 'googleapis';
import { GoogleAPIError } from './types.js';

/**
 * Comprehensive person fields for contact data
 * Includes all relevant fields for search and display
 */
export const DEFAULT_PERSON_FIELDS = [
  'addresses',
  'ageRanges',
  'biographies',
  'birthdays',
  'calendarUrls',
  'clientData',
  'emailAddresses',
  'events',
  'externalIds',
  'genders',
  'imClients',
  'interests',
  'locales',
  'locations',
  'memberships',
  'metadata',
  'miscKeywords',
  'names',
  'nicknames',
  'occupations',
  'organizations',
  'phoneNumbers',
  'photos',
  'relations',
  'sipAddresses',
  'skills',
  'urls',
  'userDefined',
].join(',');

/**
 * Creates a People API client instance
 */
function getPeopleClient(auth: Auth.OAuth2Client): people_v1.People {
  return google.people({ version: 'v1', auth });
}

/**
 * Handles Google API errors consistently
 */
function handleGoogleAPIError(error: any, operation: string): never {
  const message = error.message || 'Unknown error';
  const statusCode = error.code || error.response?.status;

  // Security: Don't expose internal error details
  if (statusCode === 401) {
    throw new GoogleAPIError('Authentication failed. Token may be invalid or expired.', 401);
  } else if (statusCode === 403) {
    throw new GoogleAPIError('Access forbidden. Check OAuth scopes and permissions.', 403);
  } else if (statusCode === 404) {
    throw new GoogleAPIError('Resource not found.', 404);
  } else if (statusCode === 429) {
    throw new GoogleAPIError('Rate limit exceeded. Please try again later.', 429);
  }

  throw new GoogleAPIError(
    `${operation} failed: ${message}`,
    statusCode
  );
}

/**
 * List contacts for the authenticated user
 *
 * @param auth - Authenticated OAuth2 client
 * @param pageSize - Number of contacts to return (max 1000)
 * @param pageToken - Token for pagination
 * @param sortOrder - Sort order for results
 * @returns List of contacts with pagination info
 */
export async function listContacts(
  auth: Auth.OAuth2Client,
  pageSize: number = 100,
  pageToken?: string,
  sortOrder?: string
): Promise<people_v1.Schema$ListConnectionsResponse> {
  try {
    const people = getPeopleClient(auth);

    const response = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: Math.min(pageSize, 1000), // Max allowed by API
      pageToken,
      personFields: DEFAULT_PERSON_FIELDS,
      sortOrder: sortOrder as any,
    });

    return response.data;
  } catch (error) {
    handleGoogleAPIError(error, 'List contacts');
  }
}

/**
 * Get a specific contact by resource name
 *
 * @param auth - Authenticated OAuth2 client
 * @param resourceName - Resource name (e.g., "people/c1234567890")
 * @returns Contact details
 */
export async function getContact(
  auth: Auth.OAuth2Client,
  resourceName: string
): Promise<people_v1.Schema$Person> {
  try {
    const people = getPeopleClient(auth);

    const response = await people.people.get({
      resourceName,
      personFields: DEFAULT_PERSON_FIELDS,
    });

    return response.data;
  } catch (error) {
    handleGoogleAPIError(error, 'Get contact');
  }
}

/**
 * Search contacts with comprehensive field matching
 *
 * @param auth - Authenticated OAuth2 client
 * @param query - Search query string
 * @param pageSize - Number of results to return
 * @param readMask - Specific fields to return
 * @returns Search results
 */
export async function searchContacts(
  auth: Auth.OAuth2Client,
  query: string,
  pageSize: number = 100,
  readMask?: string
): Promise<people_v1.Schema$SearchResponse> {
  try {
    const people = getPeopleClient(auth);

    // Use searchContacts for comprehensive search across all fields
    const response = await people.people.searchContacts({
      query,
      pageSize: Math.min(pageSize, 1000),
      readMask: readMask || DEFAULT_PERSON_FIELDS,
    });

    return response.data;
  } catch (error) {
    handleGoogleAPIError(error, 'Search contacts');
  }
}

/**
 * Search contacts in a specific directory (for G Suite/Google Workspace)
 *
 * @param auth - Authenticated OAuth2 client
 * @param query - Search query
 * @param pageSize - Number of results
 * @param pageToken - Pagination token
 * @param readMask - Fields to return
 * @returns Directory search results
 */
export async function searchDirectoryContacts(
  auth: Auth.OAuth2Client,
  query: string,
  pageSize: number = 100,
  pageToken?: string,
  readMask?: string
): Promise<people_v1.Schema$SearchDirectoryPeopleResponse> {
  try {
    const people = getPeopleClient(auth);

    const response = await people.people.searchDirectoryPeople({
      query,
      pageSize: Math.min(pageSize, 1000),
      pageToken,
      readMask: readMask || DEFAULT_PERSON_FIELDS,
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
    });

    return response.data;
  } catch (error: any) {
    // Directory search might not be available for personal accounts
    if (error.code === 403 || error.code === 400) {
      throw new GoogleAPIError(
        'Directory search is only available for Google Workspace accounts.',
        error.code
      );
    }
    handleGoogleAPIError(error, 'Search directory contacts');
  }
}
