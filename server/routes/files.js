/**
 * File Routes - /api/files/*
 *
 * File upload, serving, and deletion
 */

const express = require('express');
const router = express.Router();

const { dbQuery, getPool } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');

// Helper to check if using database mode
const isDatabaseMode = () => {
  return process.env.STORAGE_MODE === 'database' && getPool();
};

// Helper to log activity
async function logActivity(userId, username, action, details) {
  try {
    if (isDatabaseMode()) {
      await dbQuery(
        'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
        [userId, username, action, JSON.stringify(details)]
      );
    }
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

// POST /api/files - Upload a file
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { fileData, fileType, storyId, mimeType, filename } = req.body;

    if (!fileData || !fileType || !mimeType) {
      return res.status(400).json({ error: 'Missing required fields: fileData, fileType, mimeType' });
    }

    // Extract base64 data (remove data URL prefix if present)
    const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const fileSize = buffer.length;

    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    if (isDatabaseMode()) {
      const insertQuery = 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';

      await dbQuery(insertQuery, [
        fileId,
        req.user.id,
        fileType,
        storyId || null,
        mimeType,
        buffer,
        fileSize,
        filename || null
      ]);
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'FILE_UPLOADED', {
      fileId,
      fileType,
      fileSize
    });

    res.json({
      success: true,
      fileId,
      fileUrl: `${req.protocol}://${req.get('host')}/api/files/${fileId}`,
      fileSize
    });

  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: 'Failed to upload file', details: err.message });
  }
});

// GET /api/files/:fileId - Serve a file
router.get('/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    if (isDatabaseMode()) {
      const rows = await dbQuery('SELECT mime_type, file_data, filename FROM files WHERE id = $1', [fileId]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = rows[0];

      res.set('Content-Type', file.mime_type);
      if (file.filename) {
        // Sanitize filename for Content-Disposition header
        const safeFilename = file.filename.replace(/[^\x20-\x7E]/g, '_');
        const encodedFilename = encodeURIComponent(file.filename).replace(/'/g, '%27');
        res.set('Content-Disposition', `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
      }

      // Handle various file_data formats
      let fileBuffer;
      if (Buffer.isBuffer(file.file_data)) {
        const str = file.file_data.toString('utf8');
        if (str.startsWith('data:')) {
          fileBuffer = Buffer.from(str.split(',')[1], 'base64');
        } else if (/^[A-Za-z0-9+/=]+$/.test(str.substring(0, 100))) {
          fileBuffer = Buffer.from(str, 'base64');
        } else {
          fileBuffer = file.file_data;
        }
      } else if (typeof file.file_data === 'string') {
        if (file.file_data.startsWith('data:')) {
          fileBuffer = Buffer.from(file.file_data.split(',')[1], 'base64');
        } else {
          fileBuffer = Buffer.from(file.file_data, 'base64');
        }
      } else {
        fileBuffer = file.file_data;
      }

      res.send(fileBuffer);
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

  } catch (err) {
    console.error('Error serving file:', err);
    res.status(500).json({ error: 'Failed to serve file', details: err.message });
  }
});

// DELETE /api/files/:fileId - Delete a file
router.delete('/:fileId', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.params;

    if (isDatabaseMode()) {
      const result = await dbQuery('DELETE FROM files WHERE id = $1 AND user_id = $2', [fileId, req.user.id]);

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'File not found or unauthorized' });
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'FILE_DELETED', { fileId });
    res.json({ success: true, message: 'File deleted successfully' });

  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Failed to delete file', details: err.message });
  }
});

module.exports = router;
