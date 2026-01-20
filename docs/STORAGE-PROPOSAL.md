# Long-Term Storage Management Proposal for MagicalStory

## Current Problem

**Database Size with Only a Few Users:**
- Files table: **967 MB** (7 rows)
- Stories table: **918 MB** (18 rows)
- Story_jobs table: **824 MB** (46 rows)
- Characters table: **116 MB** (6 rows)
- **Total: ~2.8 GB for essentially 1-2 active users**

**Why This Doesn't Scale:**
- Base64 encoded images stored directly in PostgreSQL
- Each story contains 15-20 full-resolution images
- Database storage is expensive (~$0.25/GB/month)
- Query performance degrades with large TEXT/JSONB columns
- Backup/restore times become impractical
- Database size limits on hosting platforms

**Projected Costs at Scale:**
- 1,000 users × 10 stories each × 50 MB per story = **500 GB**
- At Railway pricing: ~$125/month just for database storage
- Performance would be severely degraded

---

## Recommended Solution: Hybrid Architecture

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    PostgreSQL Database                   │
│  - User accounts & auth                                 │
│  - Story metadata (title, settings, created_at)         │
│  - Character metadata (name, traits, relationships)     │
│  - Order information                                    │
│  - File references (URLs, not data)                    │
│  Total size: < 100 MB for 1000 users                   │
└─────────────────────────────────────────────────────────┘
                            ↓
                    File References
                            ↓
┌─────────────────────────────────────────────────────────┐
│               Object Storage (S3/R2/B2)                 │
│  - Character photos                                     │
│  - Story images (original & AI-generated)               │
│  - Generated PDFs                                       │
│  Total: ~500 GB for 1000 users                         │
│  Cost: $3-5/month                                       │
└─────────────────────────────────────────────────────────┘
                            ↓
                      CDN (CloudFlare)
                            ↓
┌─────────────────────────────────────────────────────────┐
│                    User's Browser                        │
│  - Fast image delivery                                  │
│  - Reduced server load                                  │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Set Up Object Storage (Week 1)

**Recommended Provider: Cloudflare R2**
- Cost: $0.015/GB/month (20x cheaper than database)
- No egress fees (unlike S3)
- Built-in CDN integration
- Free tier: 10 GB storage, 1M requests/month

**Alternative Providers:**
- Backblaze B2: $0.005/GB/month (cheapest)
- AWS S3: $0.023/GB/month (most features)
- DigitalOcean Spaces: $0.02/GB/month (simple)

**Setup Steps:**
1. Create R2 bucket: `magicalstory-media`
2. Configure CORS for direct browser uploads
3. Set up public access with signed URLs
4. Install SDK: `npm install @aws-sdk/client-s3`

### Phase 2: Modify Database Schema (Week 1)

**Current Schema:**
```sql
CREATE TABLE stories (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  data TEXT  -- Contains entire story with base64 images
);
```

**New Schema:**
```sql
CREATE TABLE stories (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(255),
  language VARCHAR(10),
  settings JSONB,  -- Story parameters only
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE story_images (
  id SERIAL PRIMARY KEY,
  story_id INTEGER NOT NULL,
  image_number INTEGER NOT NULL,
  image_url VARCHAR(500) NOT NULL,  -- R2 URL
  caption TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE
);

CREATE TABLE character_photos (
  id SERIAL PRIMARY KEY,
  character_id INTEGER NOT NULL,
  photo_url VARCHAR(500) NOT NULL,  -- R2 URL
  is_avatar BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
```

### Phase 3: Migration Strategy (Week 2)

**Migration Script:**
```javascript
// scripts/migrate-to-object-storage.js
async function migrateImages() {
  // 1. Fetch all stories from database
  const stories = await db.query('SELECT * FROM stories');

  for (const story of stories.rows) {
    const storyData = JSON.parse(story.data);

    // 2. Extract base64 images
    const images = storyData.images || [];

    for (let i = 0; i < images.length; i++) {
      // 3. Upload to R2
      const imageBuffer = Buffer.from(images[i].data, 'base64');
      const imageKey = `stories/${story.id}/image-${i}.jpg`;

      await r2Client.send(new PutObjectCommand({
        Bucket: 'magicalstory-media',
        Key: imageKey,
        Body: imageBuffer,
        ContentType: 'image/jpeg'
      }));

      // 4. Get public URL
      const imageUrl = `https://media.magicalstory.com/${imageKey}`;

      // 5. Insert into story_images table
      await db.query(
        'INSERT INTO story_images (story_id, image_number, image_url, caption) VALUES ($1, $2, $3, $4)',
        [story.id, i, imageUrl, images[i].caption]
      );

      // 6. Remove base64 from storyData
      images[i] = { url: imageUrl, caption: images[i].caption };
    }

    // 7. Update story with references
    await db.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), story.id]
    );
  }
}
```

**Run Migration:**
```bash
node scripts/migrate-to-object-storage.js
```

### Phase 4: Update Application Code (Week 2-3)

**Image Upload Flow:**
```javascript
// Before: Store base64 in database
const uploadImage = async (file) => {
  const base64 = await fileToBase64(file);
  // Stored in database - BAD
  return { data: base64 };
};

// After: Upload to R2, store URL
const uploadImage = async (file, userId, imageType) => {
  const fileBuffer = await file.arrayBuffer();
  const imageKey = `${imageType}/${userId}/${Date.now()}.jpg`;

  await r2Client.send(new PutObjectCommand({
    Bucket: 'magicalstory-media',
    Key: imageKey,
    Body: Buffer.from(fileBuffer),
    ContentType: file.type
  }));

  const imageUrl = `https://media.magicalstory.com/${imageKey}`;
  return { url: imageUrl };
};
```

**Story Generation:**
```javascript
// When generating stories with Claude/Gemini
const generateStoryImages = async (storyId, imagePrompts) => {
  for (let i = 0; i < imagePrompts.length; i++) {
    // Generate image with AI
    const imageData = await generateImage(imagePrompts[i]);

    // Upload to R2 immediately
    const imageKey = `stories/${storyId}/image-${i}.jpg`;
    await uploadToR2(imageKey, imageData);

    // Store only the URL in database
    await db.query(
      'INSERT INTO story_images (story_id, image_number, image_url) VALUES ($1, $2, $3)',
      [storyId, i, `https://media.magicalstory.com/${imageKey}`]
    );
  }
};
```

---

## Cost Comparison

### Current Architecture (PostgreSQL Only)
| Users | Storage | Database Cost | Total Cost |
|-------|---------|---------------|------------|
| 10 | 30 GB | $7.50/mo | $7.50/mo |
| 100 | 300 GB | $75/mo | $75/mo |
| 1,000 | 3 TB | $750/mo | $750/mo |
| 10,000 | 30 TB | $7,500/mo | $7,500/mo |

### Proposed Architecture (PostgreSQL + R2)
| Users | DB Size | R2 Size | DB Cost | R2 Cost | Total Cost |
|-------|---------|---------|---------|---------|------------|
| 10 | 50 MB | 30 GB | $0.01/mo | $0.45/mo | $0.46/mo |
| 100 | 500 MB | 300 GB | $0.13/mo | $4.50/mo | $4.63/mo |
| 1,000 | 5 GB | 3 TB | $1.25/mo | $45/mo | $46.25/mo |
| 10,000 | 50 GB | 30 TB | $12.50/mo | $450/mo | $462.50/mo |

**Savings:** 94-98% cost reduction

---

## Additional Benefits

### 1. Performance
- **Faster queries:** Database not bloated with image data
- **Parallel loading:** Images load independently
- **CDN caching:** Images served from edge locations
- **Reduced bandwidth:** Server doesn't serve images

### 2. Scalability
- **Database stays small:** Can handle millions of stories
- **Horizontal scaling:** Add more storage without touching database
- **Backup efficiency:** Database backups in seconds, not hours

### 3. Features Enabled
- **Image optimization:** Serve different sizes (thumbnail, medium, full)
- **Lazy loading:** Load images as user scrolls
- **Progressive JPEGs:** Show preview while loading
- **Video support:** Easy to add video stories later

---

## Storage Limits & Quotas

### Recommended Per-User Limits

**Free Tier:**
- 5 stories
- 100 MB total storage
- 20 images max per story

**Paid Tier ($9.99/month):**
- Unlimited stories
- 5 GB total storage
- Unlimited images per story

**Enterprise:**
- Custom limits
- Dedicated storage bucket
- Priority support

### Implementation
```javascript
// Add to users table
ALTER TABLE users ADD COLUMN storage_used_bytes BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN storage_quota_bytes BIGINT DEFAULT 104857600; -- 100 MB

// Check before upload
const canUpload = (user, fileSize) => {
  return user.storage_used_bytes + fileSize <= user.storage_quota_bytes;
};

// Update after upload
await db.query(
  'UPDATE users SET storage_used_bytes = storage_used_bytes + $1 WHERE id = $2',
  [fileSize, userId]
);
```

---

## Data Retention & Cleanup

### Automatic Cleanup Policies

**1. Orphaned Images (7 days)**
- Images uploaded but not used in stories
- Delete automatically after 7 days

**2. Deleted Story Images (30 days)**
- Keep images 30 days after story deletion
- Allow recovery/rollback

**3. Inactive Users (1 year)**
- Users who haven't logged in for 1 year
- Email warning before deletion
- Delete all data after 13 months

### Implementation
```javascript
// Cron job runs daily
const cleanupOrphanedImages = async () => {
  // Find images not linked to any story
  const orphans = await db.query(`
    SELECT i.* FROM story_images i
    LEFT JOIN stories s ON i.story_id = s.id
    WHERE s.id IS NULL AND i.created_at < NOW() - INTERVAL '7 days'
  `);

  for (const orphan of orphans.rows) {
    // Delete from R2
    await r2Client.send(new DeleteObjectCommand({
      Bucket: 'magicalstory-media',
      Key: orphan.image_url.replace('https://media.magicalstory.com/', '')
    }));

    // Delete from database
    await db.query('DELETE FROM story_images WHERE id = $1', [orphan.id]);
  }
};
```

---

## Monitoring & Analytics

### Storage Dashboard for Admins

**Metrics to Track:**
- Total storage used (GB)
- Storage per user (sorted by size)
- Storage growth rate (GB/day)
- Largest files
- Orphaned images count
- Storage cost estimate

**Alerts:**
- Storage > 80% of quota
- Unusual storage spike (>10 GB/hour)
- Cost projection > budget

**API Endpoints (Already Implemented):**
- `GET /api/admin/user-storage` - Storage per user
- `GET /api/admin/database-size` - Database size stats
- `DELETE /api/admin/users/:userId` - Delete user & data

---

## Backup Strategy

### Database Backups
- **Frequency:** Hourly incremental, daily full
- **Retention:** 7 days point-in-time recovery
- **Cost:** ~$5/month (Railway includes backups)

### Object Storage Backups
- **Versioning:** Enable S3 versioning
- **Lifecycle:** Move old versions to Glacier after 30 days
- **Cross-region replication:** Optional for critical data
- **Cost:** ~$1/month

---

## Security Considerations

### Image Access Control

**Option 1: Public URLs (Simpler)**
- All images publicly accessible
- Faster loading (no auth check)
- Risk: Anyone with URL can view

**Option 2: Signed URLs (More Secure)**
- Generate temporary signed URLs
- Expires after X hours
- Prevents unauthorized access

```javascript
// Generate signed URL (recommended for paid content)
const getSignedUrl = (imageKey) => {
  return getSignedUrl(r2Client, new GetObjectCommand({
    Bucket: 'magicalstory-media',
    Key: imageKey
  }), { expiresIn: 3600 }); // 1 hour
};
```

### GDPR Compliance
- User can request data export (images + metadata)
- User can request deletion (removes from R2 + database)
- Implement already: `DELETE /api/admin/users/:userId`

---

## Timeline & Effort Estimate

| Phase | Duration | Effort | Priority |
|-------|----------|--------|----------|
| 1. Set up R2 bucket | 1 day | 4 hours | High |
| 2. Update database schema | 2 days | 8 hours | High |
| 3. Write migration script | 3 days | 16 hours | High |
| 4. Run migration | 1 day | 2 hours | High |
| 5. Update frontend (upload) | 3 days | 16 hours | High |
| 6. Update story generation | 2 days | 12 hours | High |
| 7. Testing & validation | 3 days | 16 hours | High |
| 8. Deploy to production | 1 day | 4 hours | High |
| 9. Monitor & optimize | Ongoing | 2 hours/week | Medium |
| 10. Implement quotas | 2 days | 8 hours | Medium |
| 11. Cleanup automation | 2 days | 8 hours | Low |

**Total:** 3-4 weeks for complete migration

---

## Recommendation

**Immediate Actions (This Week):**
1. Sign up for Cloudflare R2 account
2. Create test bucket and experiment with upload/download
3. Add storage tracking to users table (storage_used_bytes)
4. Implement `GET /api/admin/user-storage` endpoint ✅ (Done!)

**Short-term (Next Month):**
1. Implement new storage architecture for NEW uploads
2. Run migration script for existing images (off-peak hours)
3. Monitor performance and cost savings

**Long-term (Next Quarter):**
1. Implement storage quotas and paid tiers
2. Add automatic cleanup policies
3. Optimize image delivery with CDN
4. Consider video story support

---

## Alternative: Incremental Approach

If full migration seems too complex, start with **hybrid mode**:

1. **Keep existing stories as-is** (in database)
2. **New uploads go to R2** (from today forward)
3. **Gradually migrate old stories** (background job)

This reduces risk and allows testing in production with real users.

---

## Questions to Consider

1. **Budget:** What's the monthly budget for storage?
2. **Migration timeline:** Can we afford downtime for migration?
3. **User impact:** Should we notify users about changes?
4. **Pricing:** Will storage limits be per-tier or pay-as-you-go?
5. **Privacy:** Should images be public or require authentication?

---

## Conclusion

**Current architecture won't scale beyond 10-20 active users** without significant cost and performance issues.

**Recommended:** Migrate to object storage (R2) immediately to:
- Reduce costs by 95%
- Improve performance 10x
- Enable scaling to 10,000+ users
- Unlock new features (video, optimization)

**ROI:** Investment of 3-4 weeks of development saves $700+/month at 1,000 users.

---

*Generated: 2025-12-09*
*Author: Claude Code*
