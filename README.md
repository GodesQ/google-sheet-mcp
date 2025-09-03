# Google Sheets MCP Server

A Model Context Protocol (MCP) server for managing Google Sheets with business sector data like invoices, tasks, employees, clients, sales, projects, and marketing.

## Features

- **Redis Session Management**: Persistent session storage using Upstash Redis
- **Concurrent Request Support**: Handles multiple consecutive MCP tool calls without session loss
- **Serverless Ready**: Optimized for Vercel serverless deployment
- **Business Sector Management**: CRUD operations for various business data types
- **Data Source Extraction**: Fetches Google Sheets data sources from your backend, extracts OAuth credentials and spreadsheets
- **Dynamic Spreadsheet Mapping**: Resolves sheetId by matching `category` to the requested business sector, with static fallback
- **Auth Flexibility**: Uses OAuth2 (access/refresh tokens) when available, otherwise falls back to service account (JWT)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file with the following variables:

```env
# Google Service Account (JWT fallback)
GOOGLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
GOOGLE_SERVICE_ACCOUNT_EMAIL=svc-account@project.iam.gserviceaccount.com

# Optional: OAuth2 client info (used when OAuth tokens are provided)
GOOGLE_CLIENT_ID=your_google_oauth_client_id
GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret

# Optional: registry-based static fallback (see src/data/sheets.ts)
# e.g., per-type sheet IDs if not resolved dynamically from data sources
# SHEET_ID_INVOICES=
# SHEET_ID_SALES=
# SHEET_ID_MARKETING=
# SHEET_ID_CLIENTS=
# SHEET_ID_TASKS=
# SHEET_ID_PROJECTS=
# SHEET_ID_EMPLOYEES=

# Upstash Redis (Required for session management)
UPSTASH_REDIS_REST_URL=https://your-redis-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_redis_token_here
```

### 3. Upstash Redis Setup

1. Go to [Upstash Console](https://console.upstash.com/)
2. Create a new Redis database
3. Copy the `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from your database settings
4. Add them to your `.env` file

### 4. Test Redis Connection

Run the Redis test script to verify your setup:

```bash
node test-redis.js
```

You should see output like:
```
Testing Redis connection...
🔍 Testing basic connection...
✅ Ping result: PONG
🔍 Testing session operations...
📝 Storing session...
✅ Session stored
📖 Retrieving session...
✅ Session retrieved: { sessionId: 'test-session-1234567890', createdAt: 1234567890, lastAccessed: 1234567890 }
🔍 Checking if session exists...
✅ Session exists: true
🔄 Updating session...
✅ Session updated
📋 Getting all session keys...
✅ Found session keys: ['mcp_session:test-session-1234567890']
🧹 Cleaning up test session...
✅ Test session deleted

🎉 All Redis tests passed!
```

## Development

### Local Development

```bash
npm run dev
```

### Build for Production

```bash
npm run build
```

## API Endpoints

### MCP Endpoint
- `POST /mcp` - Main MCP communication endpoint
- `GET /mcp` - Server-sent events for notifications
- `DELETE /mcp` - Session termination

### Debug Endpoints
- `GET /debug/sessions` - View all active sessions
- `GET /debug/redis` - Test Redis connection status

## Session Management

The server now uses Upstash Redis for persistent session storage, which solves the consecutive MCP tool calls issue. Sessions are:

- **Stored in Redis** with 30-minute expiration
- **Automatically refreshed** on each access
- **Recreated** when transport is lost (e.g., in serverless environments)
- **Cleaned up** automatically by Redis expiration

### Session Flow

1. **Initial Request**: Creates new session in Redis
2. **Consecutive Requests**: 
   - Checks if session exists in Redis
   - Recreates transport if needed
   - Updates session access time
3. **Session Cleanup**: Automatic expiration after 30 minutes of inactivity

## Troubleshooting

### "Server not initialized" Error

This error occurs when consecutive MCP calls lose session context. The Redis implementation fixes this by:

1. **Persistent Storage**: Sessions are stored in Redis, not just in memory
2. **Session Recovery**: Missing transports are recreated from Redis session data
3. **Access Tracking**: Session access times are updated on each request

### Redis Connection Issues

If Redis is not configured:
- The server falls back to in-memory storage
- Sessions will be lost on server restarts
- Consecutive calls may still fail

Check your Redis connection:
```bash
curl http://localhost:3000/debug/redis
```

### Environment Variables

Ensure all required environment variables are set:
```bash
echo $UPSTASH_REDIS_REST_URL
echo $UPSTASH_REDIS_REST_TOKEN
echo $GOOGLE_PRIVATE_KEY
echo $GOOGLE_SERVICE_ACCOUNT_EMAIL
echo $GOOGLE_CLIENT_ID
echo $GOOGLE_CLIENT_SECRET
```

## Deployment

### Vercel

The server is optimized for Vercel serverless deployment. Sessions persist across cold starts thanks to Redis storage.

### Environment Variables in Production

Set the following environment variables in your Vercel project:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `GOOGLE_PRIVATE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

## License

ISC
