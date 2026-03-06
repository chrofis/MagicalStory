/**
 * Test script to check and cleanup orphaned data via API
 * Usage:
 *   node test-cleanup-api.js check    - Just check for orphaned data
 *   node test-cleanup-api.js delete   - Check and delete orphaned data
 */

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function testCleanup(action) {
  try {
    // First, login as admin to get auth token
    console.log('🔐 Logging in as admin...');
    const loginResponse = await fetch(`${API_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'admin@local.dev',
        password: 'admin123'
      })
    });

    if (!loginResponse.ok) {
      throw new Error('Login failed');
    }

    const loginData = await loginResponse.json();
    const token = loginData.token;
    console.log('✓ Logged in successfully\n');

    // Call cleanup endpoint
    console.log(`🔍 ${action === 'delete' ? 'Checking and deleting' : 'Checking for'} orphaned data...\n`);

    const cleanupResponse = await fetch(`${API_URL}/api/admin/cleanup-orphaned-data`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        action: action === 'delete' ? 'delete' : 'check'
      })
    });

    if (!cleanupResponse.ok) {
      const error = await cleanupResponse.json();
      throw new Error(error.error || 'Cleanup failed');
    }

    const result = await cleanupResponse.json();
    console.log('Result:', JSON.stringify(result, null, 2));

    if (result.action === 'check') {
      console.log(`\n📊 Found:`);
      console.log(`   Characters: ${result.found.characters}`);
      console.log(`   Stories: ${result.found.stories}`);

      if (result.found.characters > 0 || result.found.stories > 0) {
        console.log(`\n💡 Run with 'delete' parameter to remove orphaned data`);
      } else {
        console.log(`\n✅ No orphaned data found!`);
      }
    } else if (result.action === 'deleted') {
      console.log(`\n🗑️  Deleted:`);
      console.log(`   Characters: ${result.deleted.characters}`);
      console.log(`   Stories: ${result.deleted.stories}`);
      console.log(`\n✅ Cleanup complete!`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

const action = process.argv[2] || 'check';
if (action !== 'check' && action !== 'delete') {
  console.error('Usage: node test-cleanup-api.js [check|delete]');
  process.exit(1);
}

testCleanup(action);
