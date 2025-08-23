# Redis Solution for Consecutive MCP Calls Issue

## Problem Description

The original implementation was experiencing errors when MCP tools were called consecutively (e.g., 5 times in a row). The error pattern was:

- **First 2 calls**: Successful
- **Remaining calls**: Failed with `"Server not initialized"` error

This happened because:
1. Sessions were stored only in memory
2. Serverless environments (like Vercel) don't share memory between invocations
3. Transport objects were lost between requests
4. No persistent session storage mechanism

## Solution: Upstash Redis Integration

### What Was Implemented

1. **Redis-based Session Manager** (`src/sessionManager.ts`)
   - Replaced in-memory session storage with Redis
   - Automatic session expiration (30 minutes)
   - Session persistence across server restarts
   - Fallback to in-memory storage if Redis is not configured

2. **Enhanced API Logic** (`api/index.ts`)
   - Session existence checking in Redis before creating new transports
   - Transport recreation from Redis session data
   - Better error handling and logging
   - Support for both serverless and traditional environments

3. **Debug Endpoints**
   - `/debug/sessions` - View all active sessions
   - `/debug/redis` - Test Redis connection status

### Key Features

#### Session Persistence
```typescript
// Sessions are stored in Redis with expiration
await this.redis.setex(
    this.getSessionKey(sessionId),
    Math.floor(this.SESSION_TIMEOUT / 1000), // 30 minutes
    JSON.stringify(sessionData)
);
```

#### Session Recovery
```typescript
// Check if session exists in Redis before creating new transport
if (sessionId && await sessionManager.sessionExists(sessionId)) {
    // Recreate transport from existing session
    transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        // ... transport configuration
    });
}
```

#### Automatic Cleanup
- Redis handles session expiration automatically
- No manual cleanup needed
- Sessions expire after 30 minutes of inactivity

## Setup Instructions

### 1. Environment Variables
```env
# Required for Redis functionality
UPSTASH_REDIS_REST_URL=https://your-redis-url.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_redis_token_here

# Existing Google Sheets variables
GOOGLE_SHEETS_PRIVATE_KEY=your_private_key_here
GOOGLE_SHEETS_CLIENT_EMAIL=your_client_email_here
GOOGLE_SHEETS_SPREADSHEET_ID=your_spreadsheet_id_here
```

### 2. Upstash Redis Setup
1. Go to [Upstash Console](https://console.upstash.com/)
2. Create a new Redis database
3. Copy the REST URL and token
4. Add to your environment variables

### 3. Testing
```bash
# Test Redis connection
npm run test:redis

# Test session management
npm run test:sessions

# Test consecutive calls (requires running server)
npm run test:consecutive
```

## How It Solves the Problem

### Before (In-Memory Only)
```
Request 1: Create session in memory ✅
Request 2: Session found in memory ✅
Request 3: Session lost (serverless restart) ❌
Request 4: Session lost (serverless restart) ❌
Request 5: Session lost (serverless restart) ❌
```

### After (Redis + Memory)
```
Request 1: Create session in Redis + memory ✅
Request 2: Session found in memory ✅
Request 3: Session found in Redis, recreate transport ✅
Request 4: Session found in Redis, recreate transport ✅
Request 5: Session found in Redis, recreate transport ✅
```

## Session Flow

1. **Initial Request**
   - Creates new session in Redis
   - Stores transport in memory
   - Returns session ID to client

2. **Consecutive Requests**
   - Client sends session ID in header
   - Server checks Redis for session existence
   - If found: Recreates transport, updates access time
   - If not found: Returns appropriate error

3. **Session Cleanup**
   - Redis automatically expires sessions after 30 minutes
   - Memory transports are cleaned up on close
   - No manual cleanup required

## Error Handling

### Graceful Fallback
If Redis is not configured:
- Server falls back to in-memory storage
- Logs warning messages
- Still functions but without persistence

### Detailed Error Messages
```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Bad Request: Session ID provided but not found: abc123"
  },
  "id": null
}
```

## Performance Considerations

### Redis Operations
- **Session Creation**: O(1) - Single SETEX operation
- **Session Retrieval**: O(1) - Single GET operation
- **Session Update**: O(1) - Single SETEX operation
- **Session Deletion**: O(1) - Single DEL operation

### Memory Usage
- Only active transports stored in memory
- Session data stored in Redis
- Automatic cleanup prevents memory leaks

## Monitoring and Debugging

### Debug Endpoints
```bash
# Check all sessions
curl http://localhost:3000/debug/sessions

# Test Redis connection
curl http://localhost:3000/debug/redis
```

### Logging
- Session creation/deletion events
- Transport recreation events
- Redis connection status
- Error details with context

## Deployment Considerations

### Vercel Serverless
- Sessions persist across cold starts
- Redis handles session storage
- No memory limitations

### Traditional Servers
- Sessions persist across restarts
- Better performance with memory caching
- Redis provides backup storage

## Testing Results

The solution has been tested to handle:
- ✅ 5+ consecutive MCP tool calls
- ✅ Server restarts without session loss
- ✅ Serverless cold starts
- ✅ High concurrent usage
- ✅ Session expiration and cleanup

## Migration Guide

### From In-Memory to Redis
1. Add Redis environment variables
2. Deploy updated code
3. Existing sessions will be lost (expected)
4. New sessions will use Redis storage

### Backward Compatibility
- Code works without Redis (fallback to memory)
- No breaking changes to API
- Same session ID format
- Same error codes

## Conclusion

The Redis implementation successfully solves the consecutive MCP calls issue by:

1. **Providing persistent session storage**
2. **Enabling session recovery across server restarts**
3. **Supporting serverless environments**
4. **Maintaining backward compatibility**
5. **Offering automatic cleanup and monitoring**

This solution ensures reliable MCP tool execution even in challenging serverless environments where memory is not shared between invocations.
