# Database Access Denied Fix

## Error: #1044 - Access denied for user to database

This error means your database user doesn't have permission to access the database.

---

## Quick Fix for Web Hosting

Most web hosts use **prefixed database names**. Your database name must include your user prefix.

### Check Your Database Name Format

Your error shows user: `o15037617`

Your database name is likely:
- ❌ **Wrong**: `magicalstory`
- ✅ **Correct**: `o15037617_magicalstory`

### How to Fix:

#### Step 1: Find Your Correct Database Name
1. Log into your hosting control panel (cPanel/Plesk)
2. Go to **MySQL Databases**
3. Look under "Current Databases" section
4. Your database name will be: `o15037617_something`

Common formats:
```
o15037617_magicalstory
o15037617_db1
o15037617_default
```

#### Step 2: Update Your .env File
```env
# Update this line with your ACTUAL database name from control panel
DB_NAME=o15037617_magicalstory

# Also verify these:
DB_HOST=localhost
DB_USER=o15037617
DB_PASSWORD=your_password_here
```

#### Step 3: Restart Server
```bash
npm start
```

You should now see:
```
✅ Database connection successful
```

---

## Alternative: Create Database with Correct Name

If the database doesn't exist:

### Using cPanel:
1. Go to **MySQL Databases**
2. Under "Create New Database"
3. Enter: `magicalstory` (system will add prefix automatically)
4. Click **Create Database**
5. Your actual database name will be: `o15037617_magicalstory`

### Grant User Access:
1. Scroll to "Add User To Database"
2. User: `o15037617`
3. Database: `o15037617_magicalstory`
4. Click **Add**
5. Check **ALL PRIVILEGES**
6. Click **Make Changes**

---

## Import Schema After Fixing Access

Once you have the correct database name and access:

1. **Open phpMyAdmin**
2. **Select your database** (o15037617_magicalstory)
3. Click **Import** tab
4. Choose file: `database/schema.sql`
5. Click **Go**

---

## Still Getting Errors?

### Check Database User Privileges
In phpMyAdmin:
1. Go to **User Accounts**
2. Find user `o15037617`
3. Click **Edit Privileges**
4. Verify these are checked:
   - ✅ SELECT
   - ✅ INSERT
   - ✅ UPDATE
   - ✅ DELETE
   - ✅ CREATE
   - ✅ DROP
   - ✅ INDEX
   - ✅ ALTER

### Contact Hosting Support
If still not working, ask your hosting provider:
- "What is my MySQL database name format?"
- "How do I grant my user access to the database?"
- "What is the correct DB_HOST value?" (might not be 'localhost')

---

## Example Working Configuration

For user `o15037617`, your `.env` should look like:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=o15037617
DB_PASSWORD=your_actual_password
DB_NAME=o15037617_magicalstory
STORAGE_MODE=database
```

---

## Test Your Connection

After fixing, test with this simple script:

Create `test-db.js`:
```javascript
require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log('✅ Connection successful!');
    await connection.end();
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
  }
}

testConnection();
```

Run it:
```bash
node test-db.js
```
