// Database Connection Test Script
require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  console.log('\n=================================');
  console.log('🔍 Testing Database Connection');
  console.log('=================================\n');

  console.log('Configuration:');
  console.log(`  Host: ${process.env.DB_HOST || 'localhost'}`);
  console.log(`  Port: ${process.env.DB_PORT || 3306}`);
  console.log(`  User: ${process.env.DB_USER}`);
  console.log(`  Database: ${process.env.DB_NAME}`);
  console.log(`  Password: ${process.env.DB_PASSWORD ? '***hidden***' : 'NOT SET'}\n`);

  if (!process.env.DB_USER || !process.env.DB_NAME) {
    console.error('❌ Error: DB_USER or DB_NAME not set in .env file\n');
    console.log('Please create a .env file with:');
    console.log('  DB_HOST=localhost');
    console.log('  DB_USER=your_database_user');
    console.log('  DB_PASSWORD=your_password');
    console.log('  DB_NAME=your_database_name\n');
    return;
  }

  try {
    console.log('Attempting connection...\n');

    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log('✅ Connection successful!\n');

    // Test a simple query
    const [rows] = await connection.execute('SELECT 1 as test');
    console.log('✅ Query test successful!\n');

    // Check tables
    const [tables] = await connection.execute('SHOW TABLES');
    console.log(`📊 Found ${tables.length} tables in database:\n`);

    if (tables.length > 0) {
      tables.forEach(table => {
        const tableName = Object.values(table)[0];
        console.log(`  - ${tableName}`);
      });
      console.log('\n✅ Database schema is set up!\n');
    } else {
      console.log('⚠️  No tables found. You need to import schema.sql\n');
      console.log('Steps to import:');
      console.log('  1. Open phpMyAdmin');
      console.log('  2. Select your database');
      console.log('  3. Click Import tab');
      console.log('  4. Upload database/schema.sql');
      console.log('  5. Click Go\n');
    }

    await connection.end();

    console.log('=================================');
    console.log('✅ All tests passed!');
    console.log('=================================\n');

  } catch (error) {
    console.error('❌ Connection failed!\n');
    console.error(`Error: ${error.message}\n`);

    // Provide helpful hints based on error
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.log('💡 Possible fixes:');
      console.log('  1. Check your DB_USER and DB_PASSWORD in .env');
      console.log('  2. Verify user has privileges for this database');
      console.log('  3. In cPanel/Plesk: MySQL Databases → Add User to Database\n');
    } else if (error.code === 'ER_DBACCESS_DENIED_ERROR') {
      console.log('💡 Database access denied!');
      console.log('  Your user exists but has no access to this database.\n');
      console.log('  Common issue: Database name needs user prefix');
      console.log(`  Try: DB_NAME=${process.env.DB_USER}_magicalstory\n`);
      console.log('  Steps to fix:');
      console.log('  1. Go to cPanel/Plesk → MySQL Databases');
      console.log('  2. Check "Current Databases" for the exact name');
      console.log(`  3. Grant user "${process.env.DB_USER}" ALL PRIVILEGES\n`);
    } else if (error.code === 'ECONNREFUSED') {
      console.log('💡 Connection refused!');
      console.log('  Database server is not responding.\n');
      console.log('  Possible fixes:');
      console.log('  1. Check DB_HOST in .env (might not be "localhost")');
      console.log('  2. Check DB_PORT (might not be 3306)');
      console.log('  3. Contact hosting support for correct host/port\n');
    } else if (error.code === 'ER_BAD_DB_ERROR') {
      console.log('💡 Database does not exist!');
      console.log(`  Database "${process.env.DB_NAME}" not found.\n`);
      console.log('  Steps to create:');
      console.log('  1. Go to cPanel/Plesk → MySQL Databases');
      console.log('  2. Create New Database');
      console.log('  3. Name it: magicalstory');
      console.log(`  4. System will create: ${process.env.DB_USER}_magicalstory\n`);
      console.log(`  5. Update .env: DB_NAME=${process.env.DB_USER}_magicalstory\n`);
    }

    console.log('=================================\n');
    process.exit(1);
  }
}

testConnection();
