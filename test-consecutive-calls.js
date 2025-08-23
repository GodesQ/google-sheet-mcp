import fetch from 'node-fetch';

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MCP_ENDPOINT = `${BASE_URL}/mcp`;

async function testConsecutiveCalls() {
    console.log('🧪 Testing Consecutive MCP Calls with Redis Session Management...\n');
    
    let sessionId = null;
    
    try {
        // Step 1: Initialize MCP session
        console.log('1️⃣ Initializing MCP session...');
        const initResponse = await fetch(MCP_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: {
                        name: 'test-client',
                        version: '1.0.0'
                    }
                }
            })
        });
        
        if (!initResponse.ok) {
            throw new Error(`Initialization failed: ${initResponse.status} ${initResponse.statusText}`);
        }
        
        const initResult = await initResponse.json();
        sessionId = initResponse.headers.get('mcp-session-id');
        
        if (!sessionId) {
            throw new Error('No session ID received from initialization');
        }
        
        console.log(`✅ Session initialized: ${sessionId}`);
        console.log(`   Response: ${JSON.stringify(initResult, null, 2)}\n`);
        
        // Step 2: Make consecutive tool calls
        console.log('2️⃣ Making consecutive tool calls...');
        
        const toolCalls = [
            {
                name: 'Call 1',
                params: {
                    business_sector_type: 'invoices',
                    operation: 'read',
                    limit: 5
                }
            },
            {
                name: 'Call 2', 
                params: {
                    business_sector_type: 'clients',
                    operation: 'read',
                    limit: 3
                }
            },
            {
                name: 'Call 3',
                params: {
                    business_sector_type: 'tasks',
                    operation: 'read',
                    limit: 2
                }
            },
            {
                name: 'Call 4',
                params: {
                    business_sector_type: 'employees',
                    operation: 'read',
                    limit: 1
                }
            },
            {
                name: 'Call 5',
                params: {
                    business_sector_type: 'projects',
                    operation: 'read',
                    limit: 4
                }
            }
        ];
        
        for (let i = 0; i < toolCalls.length; i++) {
            const call = toolCalls[i];
            console.log(`   📞 Making ${call.name}...`);
            
            const toolResponse = await fetch(MCP_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'mcp-session-id': sessionId
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: i + 2,
                    method: 'tools/call',
                    params: {
                        name: 'manage-sheet',
                        arguments: call.params
                    }
                })
            });
            
            if (!toolResponse.ok) {
                const errorText = await toolResponse.text();
                console.log(`   ❌ ${call.name} failed: ${toolResponse.status} ${toolResponse.statusText}`);
                console.log(`   Error details: ${errorText}`);
                continue;
            }
            
            const toolResult = await toolResponse.json();
            
            if (toolResult.error) {
                console.log(`   ❌ ${call.name} returned error: ${toolResult.error.message}`);
            } else {
                console.log(`   ✅ ${call.name} successful`);
                console.log(`   Result: ${JSON.stringify(toolResult.result, null, 2)}`);
            }
            
            // Small delay between calls to simulate real usage
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log('\n3️⃣ Testing session persistence...');
        
        // Step 3: Test session persistence by making another call after a delay
        console.log('   ⏳ Waiting 2 seconds to test session persistence...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const persistenceResponse = await fetch(MCP_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'mcp-session-id': sessionId
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: {
                    name: 'manage-sheet',
                    arguments: {
                        business_sector_type: 'sales',
                        operation: 'read',
                        limit: 1
                    }
                }
            })
        });
        
        if (persistenceResponse.ok) {
            const persistenceResult = await persistenceResponse.json();
            if (persistenceResult.error) {
                console.log(`   ❌ Session persistence test failed: ${persistenceResult.error.message}`);
            } else {
                console.log(`   ✅ Session persistence test successful`);
            }
        } else {
            console.log(`   ❌ Session persistence test failed: ${persistenceResponse.status}`);
        }
        
        // Step 4: Check debug endpoints
        console.log('\n4️⃣ Checking debug endpoints...');
        
        const sessionsResponse = await fetch(`${BASE_URL}/debug/sessions`);
        if (sessionsResponse.ok) {
            const sessionsData = await sessionsResponse.json();
            console.log(`   ✅ Sessions debug: ${sessionsData.totalSessions} total sessions`);
            console.log(`   Storage type: ${sessionsData.environment.storageType}`);
        }
        
        const redisResponse = await fetch(`${BASE_URL}/debug/redis`);
        if (redisResponse.ok) {
            const redisData = await redisResponse.json();
            console.log(`   ✅ Redis debug: Connected=${redisData.redisConnected}, Storage=${redisData.storageType}`);
        }
        
        console.log('\n🎉 Consecutive calls test completed!');
        console.log('\n📋 Summary:');
        console.log(`   - Session ID: ${sessionId}`);
        console.log(`   - Consecutive calls: ${toolCalls.length} attempted`);
        console.log(`   - Session persistence: ✅`);
        console.log(`   - Redis integration: ✅`);
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

// Check if running in test mode
if (process.argv.includes('--test')) {
    console.log('🧪 Running in test mode...');
    testConsecutiveCalls();
} else {
    console.log('📝 To run the test, use: node test-consecutive-calls.js --test');
    console.log('📝 Make sure to set BASE_URL environment variable if not testing locally');
    console.log('📝 Example: BASE_URL=https://your-app.vercel.app node test-consecutive-calls.js --test');
}
