#!/usr/bin/env node
/**
 * Setup script to:
 * 1. Make the first user an admin
 * 2. Add default print products
 */

const fs = require('fs').promises;
const path = require('path');

async function setupFileMode() {
  console.log('📁 Setting up in FILE MODE...\n');

  const usersFile = path.join(__dirname, 'data', 'users.json');
  const usersDir = path.dirname(usersFile);

  // Ensure data directory exists
  try {
    await fs.mkdir(usersDir, { recursive: true });
  } catch (err) {
    // Directory already exists
  }

  // Read users
  let users = [];
  try {
    const data = await fs.readFile(usersFile, 'utf-8');
    users = JSON.parse(data);
  } catch (err) {
    console.log('⚠️  No users file found or empty. Please register a user first.');
    return;
  }

  if (users.length === 0) {
    console.log('⚠️  No users found. Please register a user first.');
    return;
  }

  // Make first user admin
  const firstUser = users[0];
  if (firstUser.role === 'admin') {
    console.log(`✓ User "${firstUser.username}" is already admin`);
  } else {
    firstUser.role = 'admin';
    firstUser.storyQuota = -1; // Unlimited stories
    await fs.writeFile(usersFile, JSON.stringify(users, null, 2));
    console.log(`✅ Made "${firstUser.username}" an admin with unlimited stories`);
  }

  console.log('\n📋 Current users:');
  users.forEach(u => {
    console.log(`- ${u.username} (role: ${u.role || 'user'}, quota: ${u.storyQuota === -1 ? '∞' : u.storyQuota || 2})`);
  });

  console.log('\n⚠️  NOTE: Print products management requires DATABASE mode.');
  console.log('File mode does not support print products table.');
  console.log('Please set DATABASE_URL environment variable to use product management.');
}

async function setupDatabaseMode() {
  console.log('💾 Setting up in DATABASE MODE...\n');

  const pg = require('pg');
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;

  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Get first user
    const usersResult = await pool.query('SELECT id, username, email, role FROM users ORDER BY created_at ASC LIMIT 1');

    if (usersResult.rows.length === 0) {
      console.log('⚠️  No users found. Please register a user first.');
      return;
    }

    const firstUser = usersResult.rows[0];

    // Make first user admin
    if (firstUser.role === 'admin') {
      console.log(`✓ User "${firstUser.email || firstUser.username}" is already admin`);
    } else {
      await pool.query('UPDATE users SET role = $1, story_quota = $2 WHERE id = $3', ['admin', -1, firstUser.id]);
      console.log(`✅ Made "${firstUser.email || firstUser.username}" an admin with unlimited stories`);
    }

    // Check if gelato_products table exists and has products
    const productsResult = await pool.query('SELECT COUNT(*) as count FROM gelato_products');
    const productCount = parseInt(productsResult.rows[0].count);

    if (productCount > 0) {
      console.log(`\n✓ Found ${productCount} print products in database`);
    } else {
      console.log('\n📦 Adding default print product...');

      // Add default product
      await pool.query(`
        INSERT INTO gelato_products
        (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        'photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
        '14x14cm Softcover Photobook - 24 pages',
        'Square softcover photobook, perfect for children\'s stories',
        '14x14cm (5.5x5.5 inch)',
        'Softcover',
        24,
        24,
        '[24]',
        true
      ]);

      console.log('✅ Added default print product (24 pages)');
    }

    // Show all users
    const allUsers = await pool.query('SELECT id, username, email, role, story_quota FROM users ORDER BY created_at ASC');
    console.log('\n📋 Current users:');
    allUsers.rows.forEach(u => {
      const quota = u.story_quota === -1 ? '∞' : u.story_quota;
      console.log(`- ${u.email || u.username} (role: ${u.role || 'user'}, quota: ${quota})`);
    });

    // Show all products
    const allProducts = await pool.query('SELECT * FROM gelato_products ORDER BY created_at ASC');
    console.log('\n📦 Print Products:');
    allProducts.rows.forEach(p => {
      const status = p.is_active ? '✓ Active' : '✕ Inactive';
      console.log(`- ${p.product_name} (${status}, pages: ${p.min_pages}-${p.max_pages})`);
    });

    console.log('\n✅ Setup complete!');
    console.log('\n📝 Next steps:');
    console.log('1. Login to your account');
    console.log('2. Open the menu (☰) in top-right corner');
    console.log('3. Click "Manage Users" to access admin panel');
    console.log('4. Go to "Print Products" tab to manage print products');

  } catch (err) {
    console.error('❌ Error:', err.message);
    throw err;
  } finally {
    await pool.end();
  }
}

// Main
async function main() {
  const dbUrl = process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;

  if (dbUrl) {
    await setupDatabaseMode();
  } else {
    await setupFileMode();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
