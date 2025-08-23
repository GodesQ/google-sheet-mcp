import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testRedis() {
    console.log('Testing Redis connection...');
    
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!redisUrl || !redisToken) {
        console.error('❌ Redis credentials not found in environment variables');
        console.log('Please set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
        return;
    }
    
    try {
        const redis = new Redis({
            url: redisUrl,
            token: redisToken,
        });
        
        // Test basic connection
        console.log('🔍 Testing basic connection...');
        const pingResult = await redis.ping();
        console.log('✅ Ping result:', pingResult);
        
        // Test session operations
        console.log('\n🔍 Testing session operations...');
        const testSessionId = 'test-session-' + Date.now();
        const sessionData = {
            sessionId: testSessionId,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
        };
        
        // Store session
        console.log('📝 Storing session...');
        await redis.setex(`mcp_session:${testSessionId}`, 1800, JSON.stringify(sessionData));
        console.log('✅ Session stored');
        
        // Retrieve session
        console.log('📖 Retrieving session...');
        const retrievedData = await redis.get(`mcp_session:${testSessionId}`);
        
        // Handle different response formats
        let retrievedSession;
        if (typeof retrievedData === 'string') {
            retrievedSession = JSON.parse(retrievedData);
        } else if (retrievedData && typeof retrievedData === 'object') {
            // If it's already an object, use it directly
            retrievedSession = retrievedData;
        } else {
            throw new Error(`Unexpected data type: ${typeof retrievedData}`);
        }
        
        console.log('✅ Session retrieved:', retrievedSession);
        
        // Check if session exists
        console.log('🔍 Checking if session exists...');
        const exists = await redis.exists(`mcp_session:${testSessionId}`);
        console.log('✅ Session exists:', exists === 1);
        
        // Update session
        console.log('🔄 Updating session...');
        retrievedSession.lastAccessed = Date.now();
        await redis.setex(`mcp_session:${testSessionId}`, 1800, JSON.stringify(retrievedSession));
        console.log('✅ Session updated');
        
        // Get all session keys
        console.log('📋 Getting all session keys...');
        const keys = await redis.keys('mcp_session:*');
        console.log('✅ Found session keys:', keys);
        
        // Clean up test session
        console.log('🧹 Cleaning up test session...');
        await redis.del(`mcp_session:${testSessionId}`);
        console.log('✅ Test session deleted');
        
        console.log('\n🎉 All Redis tests passed!');
        
    } catch (error) {
        console.error('❌ Redis test failed:', error);
        console.error('Error details:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
    }
}

// Run the test
testRedis().catch(console.error);
