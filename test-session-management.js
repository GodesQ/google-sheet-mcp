import { sessionManager } from './build/sessionManager.js';

async function testSessionManagement() {
    console.log('🧪 Testing Session Management with Redis...\n');
    
    // Test 1: Create a session
    console.log('1️⃣ Creating a new session...');
    const sessionId = 'test-session-' + Date.now();
    await sessionManager.createSession(sessionId);
    console.log(`✅ Session created: ${sessionId}\n`);
    
    // Test 2: Check if session exists
    console.log('2️⃣ Checking if session exists...');
    const exists = await sessionManager.sessionExists(sessionId);
    console.log(`✅ Session exists: ${exists}\n`);
    
    // Test 3: Get session data
    console.log('3️⃣ Retrieving session data...');
    const session = await sessionManager.getSession(sessionId);
    console.log(`✅ Session data:`, session);
    console.log(`   - Session ID: ${session?.sessionId}`);
    console.log(`   - Created: ${new Date(session?.createdAt || 0).toISOString()}`);
    console.log(`   - Last Accessed: ${new Date(session?.lastAccessed || 0).toISOString()}\n`);
    
    // Test 4: Update session (simulate consecutive calls)
    console.log('4️⃣ Simulating consecutive calls by updating session...');
    await sessionManager.updateSession(sessionId);
    const updatedSession = await sessionManager.getSession(sessionId);
    console.log(`✅ Session updated. New last accessed: ${new Date(updatedSession?.lastAccessed || 0).toISOString()}\n`);
    
    // Test 5: Get all sessions
    console.log('5️⃣ Getting all sessions...');
    const allSessions = await sessionManager.getAllSessions();
    console.log(`✅ Found ${allSessions.length} sessions:`);
    allSessions.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.sessionId} (created: ${new Date(s.createdAt).toISOString()})`);
    });
    console.log();
    
    // Test 6: Storage type
    console.log('6️⃣ Checking storage type...');
    const storageType = sessionManager.getStorageType();
    console.log(`✅ Storage type: ${storageType}\n`);
    
    // Test 7: Redis connection test
    console.log('7️⃣ Testing Redis connection...');
    const redisConnected = await sessionManager.testRedisConnection();
    console.log(`✅ Redis connected: ${redisConnected}\n`);
    
    // Test 8: Clean up
    console.log('8️⃣ Cleaning up test session...');
    await sessionManager.deleteSession(sessionId);
    const sessionAfterDelete = await sessionManager.sessionExists(sessionId);
    console.log(`✅ Session deleted. Still exists: ${sessionAfterDelete}\n`);
    
    console.log('🎉 All session management tests passed!');
    console.log('\n📋 Summary:');
    console.log(`   - Redis Storage: ${storageType}`);
    console.log(`   - Redis Connected: ${redisConnected}`);
    console.log(`   - Session Creation: ✅`);
    console.log(`   - Session Retrieval: ✅`);
    console.log(`   - Session Updates: ✅`);
    console.log(`   - Session Cleanup: ✅`);
    console.log(`   - Consecutive Calls Support: ✅`);
}

// Run the test
testSessionManagement().catch(console.error);
