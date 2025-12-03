# Database Setup Guide for MagicalStory

This guide will help you set up **MySQL 8.0** for your MagicalStory application.

## Why MySQL 8.0?

✅ **Better JSON Support** - Perfect for storing story data, scene descriptions, and character manifests
✅ **Modern Features** - Window functions, CTEs, improved performance
✅ **Wide Compatibility** - Works with most hosting providers
✅ **Production Ready** - Battle-tested for high-traffic applications

---

## Step 1: Create the Database on Your Web Host

### Access Your Hosting Control Panel
1. Log in to your web hosting control panel (cPanel, Plesk, etc.)
2. Find the **MySQL Databases** or **Database Management** section
3. Click **Create New Database**

### Database Details
- **Database Type**: MySQL 8.0
- **Database Name**: `magicalstory` (or your preferred name)
- **Character Set**: `utf8mb4` ✅
- **Collation**: `utf8mb4_unicode_ci` ✅

### Create Database User
1. Create a new database user
   - **Username**: Choose a secure username (e.g., `magicalstory_user`)
   - **Password**: Generate a strong password (save it!)
2. Grant **ALL PRIVILEGES** to the user for the `magicalstory` database

### Save Connection Details
Write down these details - you'll need them later:
```
DB_HOST: (usually 'localhost' or an IP address from your host)
DB_PORT: 3306
DB_USER: magicalstory_user
DB_PASSWORD: (your generated password)
DB_NAME: magicalstory
```

---

## Step 2: Import the Database Schema

### Option A: Using phpMyAdmin (Easiest)
1. Open **phpMyAdmin** from your hosting control panel
2. Select your `magicalstory` database from the left sidebar
3. Click the **Import** tab at the top
4. Click **Choose File** and select `database/schema.sql`
5. Click **Go** at the bottom
6. Wait for "Import has been successfully finished" message ✅

### Option B: Using MySQL Command Line
If you have SSH access:
```bash
mysql -u magicalstory_user -p magicalstory < database/schema.sql
```

### Verify Tables Were Created
In phpMyAdmin, you should see these tables:
- ✅ users
- ✅ characters
- ✅ character_relationships
- ✅ stories
- ✅ activity_logs
- ✅ config

---

## Step 3: Configure Your Application

### Create .env File
1. Copy the example file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your database credentials:
   ```env
   # Database Configuration
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=magicalstory_user
   DB_PASSWORD=your_strong_password_here
   DB_NAME=magicalstory

   # Set storage mode to database
   STORAGE_MODE=database
   ```

3. **IMPORTANT**: Never commit `.env` to Git! (it's already in .gitignore)

---

## Step 4: Test the Database Connection

### Start Your Server
```bash
npm start
```

### Check the Logs
You should see:
```
✅ MySQL connection pool created
✅ Database connection successful
🚀 MagicalStory Server Running
```

If you see errors:
- ❌ **Access denied**: Check your username/password
- ❌ **Unknown database**: Make sure database exists and name is correct
- ❌ **Connection refused**: Check host and port (usually `localhost:3306`)

---

## Step 5: Migration from File Storage (Optional)

If you have existing data in JSON files, you can migrate it:

### Automatic Migration (Coming Soon)
Run the migration script:
```bash
node database/migrate-from-files.js
```

This will:
1. Read all data from `data/*.json` files
2. Import users, characters, and stories to database
3. Create a backup of your JSON files
4. Preserve all relationships and timestamps

### Manual Verification
After migration:
1. Check user count: `SELECT COUNT(*) FROM users;`
2. Check stories: `SELECT COUNT(*) FROM stories;`
3. Test login with your existing username/password

---

## Database Features

### Character Consistency
The database stores the **character manifest** (from the character consistency system) in the `stories` table:
- Detailed appearance descriptions
- Secondary character information
- Visual consistency guides

### Relationships
Character relationships are stored in `character_relationships` table with:
- Full relationship history
- Custom relationship text
- Bidirectional support (A→B and B→A stored as one relationship)

### JSON Support
MySQL 8.0's JSON support allows efficient storage of:
- Character traits (strengths, weaknesses, fears)
- Scene descriptions and images
- Story metadata
- Character manifests

---

## Backup Strategy

### Automated Backups
Set up automated backups through your hosting control panel:
1. Go to **Backup** section
2. Enable **Daily Automated Backups**
3. Set retention period (7-30 days recommended)

### Manual Backup
Using phpMyAdmin:
1. Select `magicalstory` database
2. Click **Export** tab
3. Choose **Quick** export method
4. Format: **SQL**
5. Click **Go** to download backup file

### Restore from Backup
1. In phpMyAdmin, select your database
2. Click **Import** tab
3. Upload your backup `.sql` file
4. Click **Go**

---

## Performance Optimization

### Index Optimization
The schema includes optimized indexes for:
- User lookups (username, email)
- Story queries by user
- Character relationships
- Activity logs by date

### Connection Pooling
The app uses connection pooling (10 connections) for optimal performance:
```javascript
connectionLimit: 10
```

Adjust in `database/config.js` if needed based on your hosting plan.

---

## Troubleshooting

### "Too many connections" Error
- Reduce `connectionLimit` in `database/config.js`
- Check your hosting plan's connection limit
- Close unused connections

### Slow Queries
- Check indexes: `SHOW INDEX FROM stories;`
- Analyze query performance: `EXPLAIN SELECT ...`
- Consider upgrading hosting plan for more resources

### Character Encoding Issues
- Verify database charset: `utf8mb4`
- Check table collation: `utf8mb4_unicode_ci`
- Re-import schema if needed

---

## Security Checklist

✅ Use strong database password (20+ characters)
✅ Never commit `.env` file to Git
✅ Restrict database user to only necessary privileges
✅ Use your hosting's firewall to limit database access
✅ Enable SSL for database connections (if supported by host)
✅ Regularly backup your database
✅ Keep MySQL updated (web host handles this)

---

## Database vs File Storage Comparison

| Feature | File Storage (JSON) | Database (MySQL) |
|---------|-------------------|------------------|
| **Performance** | Good for small data | Excellent for any size |
| **Concurrency** | Limited | Excellent |
| **Backups** | Manual file copies | Automated + professional |
| **Scalability** | Not scalable | Highly scalable |
| **Search** | Slow | Fast with indexes |
| **Relationships** | Manual tracking | Native support |
| **Production Ready** | ❌ No | ✅ Yes |

**Recommendation**: Use file storage for local development, database for production.

---

## Next Steps

Once your database is set up:

1. ✅ Create your first user account
2. ✅ Create characters with photos
3. ✅ Generate a story with character consistency
4. ✅ Verify data is saved in database (check phpMyAdmin)
5. ✅ Set up automated backups
6. ✅ Configure SSL/HTTPS for your site

---

## Support

If you encounter issues:
1. Check server logs: `npm start` (look for error messages)
2. Verify database connection in phpMyAdmin
3. Ensure `.env` file has correct credentials
4. Check your hosting plan supports MySQL 8.0
5. Contact your hosting provider for database-specific issues

---

**Congratulations!** Your MagicalStory database is now ready for production! 🎉
