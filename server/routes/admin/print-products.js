/**
 * Admin Print Products Routes
 *
 * Gelato/print provider product management endpoints.
 * Extracted from admin.js for better code organization.
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { logActivity } = require('../../services/database');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/print-products
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const selectQuery = 'SELECT * FROM gelato_products ORDER BY created_at DESC';
    const products = await dbQuery(selectQuery, []);

    res.json({ products });
  } catch (err) {
    console.error('Error fetching print provider products:', err);
    res.status(500).json({ error: 'Failed to fetch print provider products' });
  }
});

// POST /api/admin/print-products
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const {
      product_uid,
      product_name,
      description,
      size,
      cover_type,
      min_pages,
      max_pages,
      available_page_counts,
      is_active
    } = req.body;

    if (!product_uid || !product_name || min_pages === undefined || max_pages === undefined) {
      return res.status(400).json({ error: 'Missing required fields: product_uid, product_name, min_pages, max_pages' });
    }

    let pageCounts;
    try {
      pageCounts = typeof available_page_counts === 'string'
        ? JSON.parse(available_page_counts)
        : available_page_counts;
      if (!Array.isArray(pageCounts)) {
        throw new Error('Must be an array');
      }
    } catch (err) {
      return res.status(400).json({ error: 'available_page_counts must be a valid JSON array' });
    }

    const insertQuery = `INSERT INTO gelato_products
         (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`;

    const pageCountsJson = JSON.stringify(pageCounts);
    const params = [
      product_uid,
      product_name,
      description || null,
      size || null,
      cover_type || null,
      min_pages,
      max_pages,
      pageCountsJson,
      is_active !== false
    ];

    const result = await dbQuery(insertQuery, params);
    const newProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_CREATED', {
      productId: newProduct.id,
      productName: product_name
    });

    res.json({ product: newProduct, message: 'Product created successfully' });
  } catch (err) {
    console.error('Error creating print provider product:', err);
    res.status(500).json({ error: 'Failed to create print provider product' });
  }
});

// PUT /api/admin/print-products/:id
router.put('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;
    const updates = req.body;

    const allowedFields = ['product_uid', 'product_name', 'description', 'size', 'cover_type', 'min_pages', 'max_pages', 'available_page_counts', 'is_active'];
    const setClauses = [];
    const params = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        let value = updates[field];

        if (field === 'available_page_counts') {
          try {
            const pageCounts = typeof value === 'string' ? JSON.parse(value) : value;
            if (!Array.isArray(pageCounts)) {
              throw new Error('Must be an array');
            }
            value = JSON.stringify(pageCounts);
          } catch (err) {
            return res.status(400).json({ error: 'available_page_counts must be a valid JSON array' });
          }
        }

        setClauses.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const updateQuery = `UPDATE gelato_products SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    const result = await dbQuery(updateQuery, params);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_UPDATED', {
      productId: id,
      productName: updatedProduct.product_name
    });

    res.json({ product: updatedProduct, message: 'Product updated successfully' });
  } catch (err) {
    console.error('Error updating print provider product:', err);
    res.status(500).json({ error: 'Failed to update print provider product' });
  }
});

// PUT /api/admin/print-products/:id/toggle
router.put('/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;
    const { is_active } = req.body;

    const updateQuery = 'UPDATE gelato_products SET is_active = $1 WHERE id = $2 RETURNING *';

    const result = await dbQuery(updateQuery, [!is_active, id]);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_TOGGLED', {
      productId: id,
      isActive: !is_active
    });

    res.json({ product: updatedProduct, message: 'Product status updated successfully' });
  } catch (err) {
    console.error('Error toggling print provider product status:', err);
    res.status(500).json({ error: 'Failed to toggle product status' });
  }
});

// DELETE /api/admin/print-products/:id
router.delete('/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;

    const selectQuery = 'SELECT product_name FROM gelato_products WHERE id = $1';
    const rows = await dbQuery(selectQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const productName = rows[0].product_name;

    const deleteQuery = 'DELETE FROM gelato_products WHERE id = $1';
    await dbQuery(deleteQuery, [id]);

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_DELETED', {
      productId: id,
      productName: productName
    });

    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error('Error deleting print provider product:', err);
    res.status(500).json({ error: 'Failed to delete print provider product' });
  }
});

module.exports = router;
