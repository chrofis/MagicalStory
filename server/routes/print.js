/**
 * Print & Payment Routes — Extracted from server.js
 *
 * Contains: Gelato print orders, PDF generation, Stripe checkout,
 * pricing, and admin product management endpoints.
 */

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

// Middleware
const { authenticateToken } = require('../middleware/auth');

// Config
const { CREDIT_CONFIG } = require('../config/credits');

// Services
const { log } = require('../utils/logger');
const { getPool, rehydrateStoryImages, logActivity } = require('../services/database');

// Lib modules
const { generatePrintPdf, generateViewPdf, generateCombinedBookPdf } = require('../lib/pdf');
const { processBookOrder, getCoverDimensions } = require('../lib/gelato');
const email = require('../../email');

function getDbPool() { return getPool(); }

// Simple wrapper for dbPool.query that returns rows
async function dbQuery(sql, params = []) {
  const result = await getDbPool().query(sql, params);
  result.rows.rowCount = result.rowCount;
  result.rows.command = result.command;
  return result.rows;
}

// Stripe clients — initialized lazily from environment
const stripeTest = process.env.STRIPE_TEST_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_TEST_SECRET_KEY) : null;
const stripeLive = process.env.STRIPE_LIVE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_LIVE_SECRET_KEY) : null;
const stripeLegacy = (!stripeTest && process.env.STRIPE_TEST_API_KEY)
  ? require('stripe')(process.env.STRIPE_TEST_API_KEY) : null;

function getStripeForUser(user) {
  if (isUserTestMode(user)) {
    return stripeTest || stripeLegacy;
  }
  return stripeLive || stripeTest || stripeLegacy;
}

function isUserTestMode(user) {
  return user?.role === 'admin' || user?.impersonating === true;
}

// Legacy file-based storage helpers (for non-database fallback)
const STORIES_FILE = path.join(__dirname, '../../data/stories.json');
async function readJSON(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// STORAGE_MODE from environment
const STORAGE_MODE = (process.env.STORAGE_MODE === 'database' && process.env.DATABASE_URL)
  ? 'database' : 'file';


// Print Provider API - Create photobook order
// Accepts bookFormat: 'square' (default) or 'A4'
router.post('/print-provider/order', authenticateToken, async (req, res) => {
  try {
    let { storyId, pdfUrl, shippingAddress, orderReference, productUid, pageCount, bookFormat = 'square' } = req.body;

    // If storyId provided, look up story to get pdfUrl and pageCount
    if (storyId && !pdfUrl) {
      let storyData = null;
      if (STORAGE_MODE === 'database' && getDbPool()) {
        const rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [storyId, req.user.id]);
        if (rows.length > 0) {
          // Parse JSON data from database
          storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        }
      } else {
        const allStories = await readJSON(STORIES_FILE);
        const userStories = allStories[req.user.id] || [];
        storyData = userStories.find(s => s.id === storyId);
      }

      if (!storyData) {
        return res.status(404).json({ error: 'Story not found' });
      }

      // Generate fresh PDF using the shared print function (same as Buy Book)
      log.debug(`🖨️ [PRINT] Generating fresh print PDF for story: ${storyId}, format: ${bookFormat}`);
      try {
        const { pdfBuffer, pageCount: generatedPageCount } = await generatePrintPdf(storyData, bookFormat);
        pageCount = generatedPageCount;

        // Save PDF temporarily to database for Gelato to fetch
        const pdfFileId = `pdf-print-${storyId}-${Date.now()}`;
        const pdfBase64 = pdfBuffer.toString('base64');

        // Delete any existing print PDFs for this story first
        await dbQuery("DELETE FROM files WHERE story_id = $1 AND file_type = 'print_pdf'", [storyId]);

        await dbQuery(
          'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [pdfFileId, req.user.id, 'print_pdf', storyId, 'application/pdf', pdfBase64, pdfBuffer.length, `story-${storyId}-print.pdf`]
        );

        const baseUrl = process.env.BASE_URL || 'https://www.magicalstory.ch';
        pdfUrl = `${baseUrl}/api/files/${pdfFileId}`;
        log.debug(`🖨️ [PRINT] PDF generated and saved with URL: ${pdfUrl}, pageCount: ${pageCount}`);
      } catch (pdfErr) {
        log.error(`🖨️ [PRINT] Error generating PDF:`, pdfErr.message);
        return res.status(500).json({ error: 'Failed to generate print PDF', details: pdfErr.message });
      }
    }

    // Default productUid for hardcover photobook if not provided
    if (!productUid) {
      // Try to get an active product from the database that supports the page count
      if (STORAGE_MODE === 'database' && getDbPool()) {
        const productResult = await dbQuery(
          `SELECT product_uid FROM gelato_products
           WHERE is_active = true
           AND (min_pages IS NULL OR min_pages <= $1)
           AND (max_pages IS NULL OR max_pages >= $1)
           ORDER BY created_at DESC LIMIT 1`,
          [pageCount]
        );
        if (productResult.length > 0) {
          productUid = productResult[0].product_uid;
          console.log(`🖨️ [PRINT] Using product from database: ${productUid} for ${pageCount} pages`);
        }
      }

      // Fallback to environment variable or error if no database product found
      if (!productUid) {
        productUid = process.env.GELATO_PHOTOBOOK_UID;
        if (productUid) {
          console.log(`🖨️ [PRINT] Using environment fallback product`);
        } else {
          return res.status(500).json({ error: 'No active products configured. Please add products in admin dashboard.' });
        }
      }
    }

    if (!pdfUrl || !shippingAddress || !pageCount) {
      return res.status(400).json({ error: 'Missing required fields: pdfUrl (or storyId), shippingAddress, pageCount' });
    }

    // Validate and normalize shipping address
    if (!shippingAddress.country || typeof shippingAddress.country !== 'string') {
      return res.status(400).json({ error: 'Country code is required in shipping address' });
    }

    shippingAddress.country = shippingAddress.country.trim().toUpperCase();

    if (shippingAddress.country.length !== 2 || !/^[A-Z]{2}$/.test(shippingAddress.country)) {
      return res.status(400).json({
        error: 'Country must be a valid 2-letter ISO code (e.g., US, DE, CH, FR)',
        hint: 'Please update your shipping address with a valid country code'
      });
    }

    // Validate email
    if (!shippingAddress.email || typeof shippingAddress.email !== 'string') {
      return res.status(400).json({ error: 'Email is required in shipping address' });
    }

    shippingAddress.email = shippingAddress.email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(shippingAddress.email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address',
        hint: 'Email format should be like: user@example.com'
      });
    }

    const printApiKey = process.env.GELATO_API_KEY;
    // Use user role to determine Gelato order type: admin = draft, regular user = real order
    const orderType = isUserTestMode(req.user) ? 'draft' : 'order';

    if (!printApiKey || printApiKey === 'your_print_api_key_here') {
      return res.status(500).json({
        error: 'Print provider API not configured. Please add GELATO_API_KEY to .env file',
        setupUrl: 'https://dashboard.gelato.com/'
      });
    }

    log.debug(`📦 [GELATO] Creating ${orderType} (user role: ${req.user.role})`);

    // Prepare print provider order payload
    const orderPayload = {
      orderType: orderType, // 'draft' for preview only, 'order' for actual printing
      orderReferenceId: orderReference || `magical-story-${Date.now()}`,
      customerReferenceId: req.user.id,
      currency: 'CHF',
      items: [
        {
          itemReferenceId: `item-${Date.now()}`,
          productUid: productUid,
          pageCount: parseInt(pageCount), // Add page count as item attribute
          files: [
            {
              type: 'default',
              url: pdfUrl
            }
          ],
          quantity: 1
        }
      ],
      shipmentMethodUid: 'standard',
      shippingAddress: {
        firstName: shippingAddress.firstName,
        lastName: shippingAddress.lastName,
        addressLine1: shippingAddress.addressLine1,
        addressLine2: shippingAddress.addressLine2 || '',
        city: shippingAddress.city,
        state: shippingAddress.state || '',
        postCode: shippingAddress.postCode,
        country: shippingAddress.country,
        email: shippingAddress.email,
        phone: shippingAddress.phone || ''
      }
    };

    // Call print provider API
    const printResponse = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': printApiKey
      },
      body: JSON.stringify(orderPayload)
    });

    const printData = await printResponse.json();

    if (!printResponse.ok) {
      log.error('Print provider API error:', printData);
      return res.status(printResponse.status).json({
        error: 'Print provider order failed',
        details: printData
      });
    }

    await logActivity(req.user.id, req.user.username, 'PRINT_ORDER_CREATED', {
      orderId: printData.orderId || printData.id,
      orderReference: orderPayload.orderReferenceId,
      orderType: orderType
    });

    // Extract preview URLs if available
    const previewUrls = [];
    if (printData.items && Array.isArray(printData.items)) {
      printData.items.forEach(item => {
        if (item.previews && Array.isArray(item.previews)) {
          item.previews.forEach(preview => {
            if (preview.url) {
              previewUrls.push({
                type: preview.type || 'preview',
                url: preview.url
              });
            }
          });
        }
      });
    }

    res.json({
      success: true,
      orderId: printData.orderId || printData.id,
      orderReference: orderPayload.orderReferenceId,
      orderType: orderType,
      isDraft: orderType === 'draft',
      previewUrls: previewUrls,
      dashboardUrl: `https://dashboard.gelato.com/checkout/${printData.orderId || printData.id}/product`,
      data: printData
    });

  } catch (err) {
    log.error('Error creating print provider order:', err);
    res.status(500).json({ error: 'Failed to create print order', details: err.message });
  }
});

// Print Provider Product Management (Admin Only)

// Fetch products from print provider API
router.get('/admin/print-provider/fetch-products', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey || printApiKey === 'your_print_api_key_here') {
      return res.status(500).json({ error: 'Print provider API not configured' });
    }

    // Step 1: Fetch all available catalogs from print provider
    const catalogsResponse = await fetch('https://product.gelatoapis.com/v3/catalogs', {
      headers: {
        'X-API-KEY': printApiKey
      }
    });

    if (!catalogsResponse.ok) {
      const errorData = await catalogsResponse.json();
      return res.status(catalogsResponse.status).json({ error: 'Failed to fetch catalogs from print provider', details: errorData });
    }

    const catalogsData = await catalogsResponse.json();
    console.log('📁 Print provider catalogs RAW response:', JSON.stringify(catalogsData).substring(0, 500));

    // Try different possible response structures
    const catalogs = catalogsData.catalogs || catalogsData.data || catalogsData.results || catalogsData || [];
    const catalogArray = Array.isArray(catalogs) ? catalogs : (catalogs.items || []);

    console.log('📁 Print provider catalogs:', {
      count: catalogArray.length,
      catalogUids: catalogArray.slice(0, 5).map(c => c?.uid || c?.id || c?.catalogUid || 'unknown'),
      firstCatalog: catalogArray[0] || null
    });

    // Step 2: Search ONLY photobook catalogs
    let allPhotobooks = [];
    const photobookCatalogs = ['hard-cover-photobooks', 'soft-cover-photobooks'];

    log.debug(`📚 Targeting photobook catalogs: ${photobookCatalogs.join(', ')}`);

    for (const catalogUid of photobookCatalogs) {
      try {
        log.debug(`🔍 Searching photobook catalog: ${catalogUid}`);
        // Search for products in this catalog
        const searchResponse = await fetch(`https://product.gelatoapis.com/v3/catalogs/${catalogUid}/products:search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': printApiKey
          },
          body: JSON.stringify({
            limit: 100,
            offset: 0
          })
        });

        log.debug(`📡 Search response status: ${searchResponse.status}`);

        if (!searchResponse.ok) {
          const errorText = await searchResponse.text();
          log.error(`❌ Failed to search ${catalogUid}:`, errorText.substring(0, 200));
          continue;
        }

        const searchData = await searchResponse.json();
        log.debug(`📦 ${catalogUid} response:`, {
          hasProducts: !!searchData.products,
          productCount: searchData.products?.length || 0,
          responseKeys: Object.keys(searchData)
        });

        // Accept ALL products from photobook catalogs
        const photobooks = searchData.products || [];
        log.debug(`📚 ${catalogUid}: Found ${photobooks.length} products`);

        if (photobooks.length > 0) {
          log.debug(`📚 First 3 products from ${catalogUid}:`);
          photobooks.slice(0, 3).forEach((p, i) => {
            log.debug(`  ${i+1}. ${p.name || p.productName || 'Unnamed'} (UID: ${p.productUid || p.uid})`);
          });
        } else {
          log.warn(`No products found in ${catalogUid}!`);
        }

        allPhotobooks = allPhotobooks.concat(photobooks);
      } catch (err) {
        log.error(`❌ Error searching catalog ${catalogUid}:`, err.message);
        log.error('Error stack:', err.stack);
      }
    }

    // Remove duplicates based on productUid
    const uniquePhotobooks = Array.from(
      new Map(allPhotobooks.map(p => [p.productUid || p.uid, p])).values()
    );

    log.debug('📚 Total unique photobooks found:', uniquePhotobooks.length);

    res.json({
      success: true,
      count: uniquePhotobooks.length,
      products: uniquePhotobooks,
      catalogsSearched: photobookCatalogs.length,
      catalogs: photobookCatalogs
    });

  } catch (err) {
    log.error('Error fetching print provider products:', err);
    res.status(500).json({ error: 'Failed to fetch products', details: err.message });
  }
});

// Get all saved print provider products from database
router.get('/admin/print-provider/products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE === 'database' && getDbPool()) {
      const selectQuery = 'SELECT * FROM gelato_products ORDER BY is_active DESC, created_at DESC';

      const rows = await dbQuery(selectQuery, []);
      res.json({ success: true, products: rows });
    } else {
      // File mode fallback
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'print_products.json');

      try {
        const data = await fs.readFile(productsFile, 'utf-8');
        const products = JSON.parse(data);
        res.json({ success: true, products: Object.values(products) });
      } catch (err) {
        res.json({ success: true, products: [] });
      }
    }

  } catch (err) {
    log.error('Error getting products:', err);
    res.status(500).json({ error: 'Failed to get products', details: err.message });
  }
});

// Save/Update print provider product
router.post('/admin/print-provider/products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
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

    if (!product_uid || !product_name) {
      return res.status(400).json({ error: 'Missing required fields: product_uid, product_name' });
    }

    // Convert available_page_counts array to JSON string if needed
    const pageCountsStr = Array.isArray(available_page_counts)
      ? JSON.stringify(available_page_counts)
      : available_page_counts;

    if (STORAGE_MODE === 'database' && getDbPool()) {
      // Try to insert, if exists, update
      const upsertQuery = `INSERT INTO gelato_products
           (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
           ON CONFLICT (product_uid)
           DO UPDATE SET
             product_name = $2,
             description = $3,
             size = $4,
             cover_type = $5,
             min_pages = $6,
             max_pages = $7,
             available_page_counts = $8,
             is_active = $9,
             updated_at = CURRENT_TIMESTAMP`;

      await dbQuery(upsertQuery, [
        product_uid,
        product_name,
        description || null,
        size || null,
        cover_type || null,
        min_pages || null,
        max_pages || null,
        pageCountsStr || null,
        is_active !== false
      ]);
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'print_products.json');

      let products = {};
      try {
        const data = await fs.readFile(productsFile, 'utf-8');
        products = JSON.parse(data);
      } catch (err) {
        // File doesn't exist yet
      }

      products[product_uid] = {
        product_uid,
        product_name,
        description: description || null,
        size: size || null,
        cover_type: cover_type || null,
        min_pages: min_pages || null,
        max_pages: max_pages || null,
        available_page_counts: pageCountsStr || null,
        is_active: is_active !== false,
        updated_at: new Date().toISOString()
      };

      await fs.writeFile(productsFile, JSON.stringify(products, null, 2));
    }

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_SAVED', { product_uid });

    res.json({ success: true, message: 'Product saved successfully' });

  } catch (err) {
    log.error('Error saving product:', err);
    res.status(500).json({ error: 'Failed to save product', details: err.message });
  }
});

// Seed default products (Admin only)
router.post('/admin/print-provider/seed-products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Default 20x20cm (8x8 inch) photobook product
    const defaultProduct = {
      product_uid: 'photobooks-softcover_pf_8x8-inch-200x200-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_250-gsm-100-lb-cover-coated-silk_ver',
      product_name: '20x20cm Softcover Photobook',
      description: 'Square softcover photobook with matt lamination, 170gsm coated silk paper',
      size: '20x20cm (8x8 inch)',
      cover_type: 'softcover',
      min_pages: 24,
      max_pages: 200,
      available_page_counts: JSON.stringify([24, 30, 40, 50, 60, 80, 100, 120, 150, 200]),
      is_active: true
    };

    if (STORAGE_MODE === 'database' && getDbPool()) {
      const upsertQuery = `INSERT INTO gelato_products
           (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (product_uid)
           DO UPDATE SET
             product_name = $2,
             description = $3,
             size = $4,
             cover_type = $5,
             min_pages = $6,
             max_pages = $7,
             available_page_counts = $8,
             is_active = $9,
             updated_at = CURRENT_TIMESTAMP`;

      await dbQuery(upsertQuery, [
        defaultProduct.product_uid,
        defaultProduct.product_name,
        defaultProduct.description,
        defaultProduct.size,
        defaultProduct.cover_type,
        defaultProduct.min_pages,
        defaultProduct.max_pages,
        defaultProduct.available_page_counts,
        defaultProduct.is_active
      ]);

      res.json({ success: true, message: 'Default product seeded successfully' });
    } else {
      res.status(500).json({ error: 'Database mode required for seeding' });
    }

  } catch (err) {
    log.error('Error seeding products:', err);
    res.status(500).json({ error: 'Failed to seed products', details: err.message });
  }
});


router.get('/print-provider/products', async (req, res) => {
  try {
    if (STORAGE_MODE === 'database' && getDbPool()) {
      const selectQuery = 'SELECT product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts FROM gelato_products WHERE is_active = true ORDER BY product_name';

      const rows = await dbQuery(selectQuery, []);
      res.json({ success: true, products: rows });
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'print_products.json');

      try {
        const data = await fs.readFile(productsFile, 'utf-8');
        const allProducts = JSON.parse(data);
        const activeProducts = Object.values(allProducts).filter(p => p.is_active);
        res.json({ success: true, products: activeProducts });
      } catch (err) {
        res.json({ success: true, products: [] });
      }
    }

  } catch (err) {
    log.error('Error getting active products:', err);
    res.status(500).json({ error: 'Failed to get products', details: err.message });
  }
});

// NOTE: Photo/avatar endpoints moved to server/routes/avatars.js
// - POST /api/analyze-photo
// - GET /api/avatar-prompt
// - POST /api/generate-clothing-avatars

// ========================================
// NOTE: PDF generation functions are in server/lib/pdf.js

// GET PDF for a story - for DOWNLOAD/VIEWING (different sequence than print)
// Uses generateViewPdf from pdf.js library - no code duplication
// Query params: format=square|A4 (default: square)
router.get('/stories/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const storyId = req.params.id;
    const userId = req.user.id;
    const bookFormat = req.query.format === 'A4' ? 'A4' : 'square'; // Validate format

    log.debug(`📄 [PDF DOWNLOAD] Generating viewable PDF for story: ${storyId}, format: ${bookFormat}`);

    // Fetch story from database
    const storyResult = await getDbPool().query(
      'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
      [storyId, userId]
    );

    if (storyResult.rows.length === 0) {
      log.debug(`📄 [PDF DOWNLOAD] Story not found: ${storyId}`);
      return res.status(404).json({ error: 'Story not found' });
    }

    let storyData = typeof storyResult.rows[0].data === 'string'
      ? JSON.parse(storyResult.rows[0].data)
      : storyResult.rows[0].data;
    log.debug(`📄 [PDF DOWNLOAD] Story found: ${storyData.title}`);

    // Rehydrate images from story_images table (images stripped from data blob)
    storyData = await rehydrateStoryImages(storyId, storyData);

    // Generate PDF using shared library function
    const pdfBuffer = await generateViewPdf(storyData, bookFormat);

    log.debug(`📄 [PDF DOWNLOAD] PDF generated successfully (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // NO database storage - just send directly to user
    res.setHeader('Content-Type', 'application/pdf');
    const safeFilename = (storyData.title || 'story')
      .replace(/[–—]/g, '-')
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-zA-Z0-9\s\-_.]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 100);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    log.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
  }
});

// GET PRINT PDF for a story - ADMIN ONLY - uses same format as Buy Book/Print Book
// This allows admins to preview the exact PDF that would be sent to Gelato for printing
// Query params: format=square|A4 (default: square)
router.get('/stories/:id/print-pdf', authenticateToken, async (req, res) => {
  try {
    // Admin only
    if (req.user.role !== 'admin') {
      log.debug(`🖨️ [ADMIN PRINT PDF] Access denied - user ${req.user.username} is not admin (role: ${req.user.role})`);
      return res.status(403).json({ error: 'Admin access required' });
    }

    const storyId = req.params.id;
    const bookFormat = req.query.format === 'A4' ? 'A4' : 'square'; // Validate format
    log.debug(`🖨️ [ADMIN PRINT PDF] Admin ${req.user.username} requesting print PDF for story: ${storyId}, format: ${bookFormat}`);
    console.log(`🖨️ [ADMIN PRINT PDF] Storage mode: ${STORAGE_MODE}, getDbPool() exists: ${!!getDbPool()}`);

    // Fetch story from database (admin can access any story)
    let storyData = null;
    if (STORAGE_MODE === 'database' && getDbPool()) {
      const storyResult = await dbQuery('SELECT data FROM stories WHERE id = $1', [storyId]);
      if (storyResult.length > 0) {
        storyData = typeof storyResult[0].data === 'string'
          ? JSON.parse(storyResult[0].data)
          : storyResult[0].data;
        // Rehydrate images from story_images table (images stripped from data blob)
        storyData = await rehydrateStoryImages(storyId, storyData);
      }
    } else {
      // File mode - search all users
      const allStories = await readJSON(STORIES_FILE);
      for (const userId in allStories) {
        const story = allStories[userId].find(s => s.id === storyId);
        if (story) {
          storyData = story;
          break;
        }
      }
    }

    if (!storyData) {
      log.debug(`🖨️ [ADMIN PRINT PDF] Story not found: ${storyId}`);
      return res.status(404).json({ error: 'Story not found' });
    }

    log.debug(`🖨️ [ADMIN PRINT PDF] Story found: ${storyData.title}`);
    log.debug(`🖨️ [ADMIN PRINT PDF] Story has: coverImages=${!!storyData.coverImages}, sceneImages=${storyData.sceneImages?.length || 0}, storyText=${!!storyData.storyText || !!storyData.generatedStory}`);

    // Generate print PDF using the shared function (same as Buy Book / Print Book)
    const { pdfBuffer, pageCount } = await generatePrintPdf(storyData, bookFormat);

    log.info(`🖨️ [ADMIN PRINT PDF] PDF generated: ${pageCount} pages, ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Return PDF for download
    res.setHeader('Content-Type', 'application/pdf');
    const safeFilename = (storyData.title || 'story')
      .replace(/[–—]/g, '-')
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-zA-Z0-9\s\-_.]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 100);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}-print.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    log.error('Error generating print PDF:', err);
    res.status(500).json({ error: 'Failed to generate print PDF', details: err.message });
  }
});

// NOTE: Story sharing endpoints moved to server/routes/sharing.js

// Generate PDF from story (POST - with data in body)
router.post('/generate-pdf', authenticateToken, async (req, res) => {
  try {
    const { storyId, storyTitle, storyPages, sceneImages, coverImages, languageLevel } = req.body;

    if (!storyPages || !Array.isArray(storyPages) || storyPages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid storyPages' });
    }

    // Determine layout based on languageLevel
    // '1st-grade' = Picture Book = combined layout (image + text on same page)
    // 'standard' or 'advanced' = separate pages for text and image
    const isPictureBook = languageLevel === '1st-grade';
    log.debug(`📄 [PDF] Generating PDF with layout: ${isPictureBook ? 'Picture Book (combined)' : 'Standard (separate pages)'}`);

    // Helper function to extract image data from cover images
    // Supports both old format (base64 string) and new format (object with imageData property)
    const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;

    const PDFDocument = require('pdfkit');
    const stream = require('stream');

    // Convert mm to points (1mm = 2.83465 points)
    const mmToPoints = (mm) => mm * 2.83465;

    // Page dimensions for 20x20cm (8x8 inch) photobook
    const coverWidth = mmToPoints(416);      // Cover spread: 200mm back + ~16mm spine + 200mm front
    const coverHeight = mmToPoints(206);     // Cover height: 200mm + 6mm bleed
    const pageSize = mmToPoints(200);        // Interior pages: 200x200mm

    // Create PDF document - start with cover page
    const doc = new PDFDocument({
      size: [coverWidth, coverHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false  // We'll add pages manually
    });

    // Collect PDF data in a buffer
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Wait for PDF to finish
    const pdfPromise = new Promise((resolve, reject) => {
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on('error', reject);
    });

    // PDF Page 1: Back Cover + Front Cover (spread, 416 x 206 mm for 20x20cm book)
    doc.addPage({ size: [coverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    const backCoverImageData = getCoverImageData(coverImages?.backCover);
    const frontCoverImageData = getCoverImageData(coverImages?.frontCover);

    if (backCoverImageData && frontCoverImageData) {
      // Add back cover on left half
      const backCoverData = backCoverImageData.replace(/^data:image\/\w+;base64,/, '');
      const backCoverBuffer = Buffer.from(backCoverData, 'base64');
      doc.image(backCoverBuffer, 0, 0, { width: coverWidth / 2, height: coverHeight });

      // Add front cover on right half
      const frontCoverData = frontCoverImageData.replace(/^data:image\/\w+;base64,/, '');
      const frontCoverBuffer = Buffer.from(frontCoverData, 'base64');
      doc.image(frontCoverBuffer, coverWidth / 2, 0, { width: coverWidth / 2, height: coverHeight });

      // Note: Title is already part of the cover image, no overlay needed
    }

    // PDF Page 2: Initial Page (140 x 140 mm)
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    const initialPageImageData = getCoverImageData(coverImages?.initialPage);
    if (initialPageImageData) {
      const initialPageData = initialPageImageData.replace(/^data:image\/\w+;base64,/, '');
      const initialPageBuffer = Buffer.from(initialPageData, 'base64');
      doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
    }

    // Add content pages based on layout type
    if (isPictureBook) {
      // PICTURE BOOK LAYOUT: Combined image on top (~90%), text below (~10%)
      storyPages.forEach((page, index) => {
        const pageNumber = index + 1;

        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        // Layout: Image takes top 85%, text takes bottom 15%
        const imageHeight = pageSize * 0.85;
        const textAreaHeight = pageSize * 0.15;
        const textAreaY = imageHeight;

        // Add image at top if available (full-bleed, no margin)
        const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
        if (sceneImage && sceneImage.imageData) {
          try {
            const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');

            doc.image(imageBuffer, 0, 0, {
              fit: [pageSize, imageHeight],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            log.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
          }
        }

        // Add text in bottom portion (small area for Picture Book)
        const textMargin = mmToPoints(3);  // Margin for text area only
        const availableTextWidth = pageSize - (textMargin * 2);
        const availableTextHeight = textAreaHeight - (textMargin);

        const startFontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
        let fontSize = startFontSize;
        let textHeight;

        doc.fontSize(fontSize).font('Helvetica');
        textHeight = doc.heightOfString(page.text, { width: availableTextWidth, align: 'center' });
        const initialHeight = textHeight;

        while (textHeight > availableTextHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(page.text, { width: availableTextWidth, align: 'center' });
        }

        if (fontSize < startFontSize) {
          log.debug(`📄 [PDF-PictureBook] Page ${index + 1}: Font reduced ${startFontSize}pt → ${fontSize}pt (text: ${page.text.length} chars, height: ${Math.round(initialHeight)} → ${Math.round(textHeight)}, available: ${Math.round(availableTextHeight)})`);
        }

        let textToRender = page.text;
        if (textHeight > availableTextHeight) {
          // Truncate text to fit
          log.warn(`[PDF-PictureBook] Page ${index + 1}: Text still too long at ${fontSize}pt, truncating...`);
          const words = page.text.split(' ');
          textToRender = '';
          for (let i = 0; i < words.length; i++) {
            const testText = textToRender + (textToRender ? ' ' : '') + words[i];
            const testHeight = doc.heightOfString(testText, { width: availableTextWidth, align: 'center' });
            if (testHeight <= availableTextHeight) {
              textToRender = testText;
            } else {
              break;
            }
          }
          textToRender += '...';
        }

        textHeight = doc.heightOfString(textToRender, { width: availableTextWidth, align: 'center' });
        const textY = textAreaY + (availableTextHeight - textHeight) / 2;

        doc.fillColor('#333333').text(textToRender, textMargin, textY, { width: availableTextWidth, align: 'center' });
      });
    } else {
      // STANDARD/ADVANCED LAYOUT: Separate pages for text and image
      // Margins: reduced top/bottom for more text space, keep left/right for binding
      const marginTopBottom = 15;  // ~5mm
      const marginLeftRight = 28;  // ~10mm

      const availableWidth = pageSize - (marginLeftRight * 2);
      const availableHeight = pageSize - (marginTopBottom * 2);
      // Add 10% safety margin to prevent overflow due to rendering differences
      const safeAvailableHeight = availableHeight * 0.9;

      // PRE-CHECK: Verify all pages fit before generating PDF
      // If any page would be truncated, abort with error
      const truncatedPages = [];
      storyPages.forEach((page, index) => {
        const pageNumber = index + 1;
        let fontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
        doc.fontSize(fontSize).font('Helvetica');
        let textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });

        while (textHeight > safeAvailableHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        }

        if (textHeight > safeAvailableHeight) {
          truncatedPages.push(pageNumber);
          log.error(`❌ Page ${pageNumber}: Text too long even at minimum font size (${fontSize}pt) - would be truncated`);
        }
      });

      // Abort if any pages would be truncated
      if (truncatedPages.length > 0) {
        log.error(`❌ [PDF] Aborting: ${truncatedPages.length} pages have text too long for print`);
        return res.status(400).json({
          error: 'Text too long for print',
          message: `Pages ${truncatedPages.join(', ')} have too much text and would be truncated. Please shorten the text before printing.`,
          truncatedPages
        });
      }

      // All pages fit - proceed with PDF generation
      storyPages.forEach((page, index) => {
        const pageNumber = index + 1;

        // Add text page (square format)
        doc.addPage({ size: [pageSize, pageSize], margins: { top: marginTopBottom, bottom: marginTopBottom, left: marginLeftRight, right: marginLeftRight } });

        const startFontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
        let fontSize = startFontSize;
        let textHeight;

        doc.fontSize(fontSize).font('Helvetica');
        textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        const initialHeight = textHeight;

        while (textHeight > safeAvailableHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        }

        if (fontSize < startFontSize) {
          log.debug(`📄 [PDF] Page ${pageNumber}: Font reduced ${startFontSize}pt → ${fontSize}pt (text: ${page.text.length} chars, height: ${Math.round(initialHeight)} → ${Math.round(textHeight)}, available: ${Math.round(safeAvailableHeight)})`);
        }

        textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        const yPosition = marginTopBottom + (safeAvailableHeight - textHeight) / 2;

        doc.fillColor('#333333').text(page.text, marginLeftRight, yPosition, { width: availableWidth, align: 'left' });

        // Add image page if available (full-bleed, no margin)
        const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
        if (sceneImage && sceneImage.imageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

          try {
            const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');

            doc.image(imageBuffer, 0, 0, {
              fit: [pageSize, pageSize],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            log.error('Error adding image to PDF:', imgErr);
          }
        }
      });
    }

    // Finalize PDF
    doc.end();

    // Wait for PDF generation to complete
    const pdfBuffer = await pdfPromise;
    const fileSize = pdfBuffer.length;
    const fileId = `file-pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const filename = `${storyTitle || 'story'}.pdf`;

    // Store PDF in database
    if (STORAGE_MODE === 'database' && getDbPool()) {
      log.debug(`📄 [PDF SAVE] Saving PDF with story_id: ${storyId}, file_id: ${fileId}`);
      const insertQuery = 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';

      await dbQuery(insertQuery, [
        fileId,
        req.user.id,
        'story_pdf',
        storyId || null,
        'application/pdf',
        pdfBuffer,
        fileSize,
        filename
      ]);
      log.debug(`📄 [PDF SAVE] PDF saved successfully`);
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const uploadsDir = path.join(__dirname, 'data', 'uploads');

      await fs.mkdir(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, fileId);
      await fs.writeFile(filePath, pdfBuffer);

      // Save metadata
      const metadataFile = path.join(__dirname, 'data', 'files.json');
      let metadata = {};
      try {
        const data = await fs.readFile(metadataFile, 'utf-8');
        metadata = JSON.parse(data);
      } catch (err) {
        // File doesn't exist yet
      }

      metadata[fileId] = {
        id: fileId,
        userId: req.user.id,
        fileType: 'story_pdf',
        storyId: storyId || null,
        mimeType: 'application/pdf',
        fileSize,
        filename,
        createdAt: new Date().toISOString()
      };

      await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2));
    }

    await logActivity(req.user.id, req.user.username, 'PDF_GENERATED', {
      fileId,
      storyId,
      fileSize
    });

    const fileUrl = `${req.protocol}://${req.get('host')}/api/files/${fileId}`;

    res.json({
      success: true,
      fileId,
      fileUrl,
      fileSize,
      filename
    });

  } catch (err) {
    log.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
  }
});

// Generate print-ready book PDF - uses the same generatePrintPdf/generateCombinedBookPdf
// as the Gelato order flow, ensuring test PDFs are identical to what Gelato receives
router.post('/generate-book-pdf', authenticateToken, async (req, res) => {
  try {
    const { storyIds, bookFormat = 'square', coverType = 'softcover' } = req.body;
    const userId = req.user.id;

    if (!storyIds || !Array.isArray(storyIds) || storyIds.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid storyIds array' });
    }

    console.log(`📚 [BOOK PDF] Generating book with ${storyIds.length} stories, format: ${bookFormat}, cover: ${coverType}`);

    // Fetch all stories from database
    const stories = [];
    for (const storyId of storyIds) {
      const storyResult = await getDbPool().query(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [storyId, userId]
      );

      if (storyResult.rows.length === 0) {
        log.debug(`📚 [BOOK PDF] Story not found: ${storyId}`);
        return res.status(404).json({ error: `Story not found: ${storyId}` });
      }

      let storyData = typeof storyResult.rows[0].data === 'string'
        ? JSON.parse(storyResult.rows[0].data)
        : storyResult.rows[0].data;

      // Rehydrate images from story_images table (images stripped from data blob)
      storyData = await rehydrateStoryImages(storyId, storyData);
      stories.push({ id: storyId, data: storyData });
    }

    log.debug(`📚 [BOOK PDF] Loaded ${stories.length} stories: ${stories.map(s => s.data.title).join(', ')}`);

    // Estimate Gelato page count: dedication (1) + story content + trailing blank (1)
    // NOTE: parseStoryPages from storyHelpers expects a TEXT string, not storyData object
    let storyContentPages = 0;
    for (const story of stories) {
      const storyText = story.data.storyText || story.data.generatedStory || story.data.story || story.data.text || '';
      const storyPages = parseStoryPages(storyText);
      const isPictureBook = story.data.languageLevel === '1st-grade';
      const pagesFromStory = isPictureBook ? storyPages.length : storyPages.length * 2;
      console.log(`📊 [BOOK PDF] Story "${story.data.title}": ${storyPages.length} parsed pages, contentPages=${pagesFromStory}`);
      storyContentPages += pagesFromStory;
    }
    const estimatedPageCount = 1 + storyContentPages + 1;
    console.log(`📊 [BOOK PDF] Estimated Gelato pageCount: ${estimatedPageCount} (${storyContentPages} story content pages)`);

    // Find matching product to get spine width
    const formatPattern = bookFormat === 'A4' ? '210x280' : '200x200';
    let printProductUid = null;
    const productsResult = await getDbPool().query(
      'SELECT product_uid, product_name, min_pages, max_pages FROM gelato_products WHERE is_active = true AND LOWER(product_uid) LIKE $1 AND LOWER(product_uid) LIKE $2',
      [`%${coverType.toLowerCase()}%`, `%${formatPattern}%`]
    );
    if (productsResult.rows.length > 0) {
      const matchingProduct = productsResult.rows.find(p =>
        estimatedPageCount >= (p.min_pages || 0) && estimatedPageCount <= (p.max_pages || 999)
      );
      if (matchingProduct) {
        printProductUid = matchingProduct.product_uid;
        log.debug(`📚 [BOOK PDF] Selected product: ${matchingProduct.product_name}`);
      }
    }
    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      console.log(`⚠️ [BOOK PDF] No product found for coverType=${coverType}, format=${formatPattern}, pages=${estimatedPageCount}. Fallback: ${printProductUid}`);
    } else {
      console.log(`📚 [BOOK PDF] Product: ${printProductUid} (coverType=${coverType}, format=${formatPattern})`);
    }

    // Fetch cover dimensions from Gelato API
    let coverDims = null;
    if (printProductUid) {
      coverDims = await getCoverDimensions(printProductUid, estimatedPageCount);
      if (coverDims) {
        console.log(`📚 [BOOK PDF] Gelato cover dims: ${coverDims.coverPageWidth}x${coverDims.coverPageHeight}mm, spine: ${coverDims.spineWidth}mm`);
      } else {
        console.log(`⚠️ [BOOK PDF] getCoverDimensions returned null for product=${printProductUid}, pages=${estimatedPageCount}`);
      }
    }

    // Use the SAME PDF generation functions as the Gelato order flow
    let pdfBuffer, pageCount;

    if (stories.length === 1) {
      const result = await generatePrintPdf(stories[0].data, bookFormat, { gelatoCoverDims: coverDims });
      pdfBuffer = result.pdfBuffer;
      pageCount = result.pageCount;
    } else {
      const result = await generateCombinedBookPdf(stories, { gelatoCoverDims: coverDims });
      pdfBuffer = result.pdfBuffer;
      pageCount = result.pageCount;
    }

    console.log(`✅ [BOOK PDF] Generated book PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${pageCount} pages`);

    // Send PDF
    res.setHeader('Content-Type', 'application/pdf');
    const bookTitle = stories.length > 1
      ? `Book_${stories.length}_Stories`
      : (stories[0].data.title || 'Book').replace(/[^a-zA-Z0-9\s\-_.]/g, '').replace(/\s+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${bookTitle}.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    log.error('📚 [BOOK PDF] Error:', err);
    res.status(500).json({ error: 'Failed to generate book PDF', details: err.message });
  }
});
// Admin - Retry failed print provider order
router.post('/admin/orders/:orderId/retry-print-order', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { orderId } = req.params;
    log.debug(`🔄 [ADMIN] Retrying print order for order ID: ${orderId}`);

    // Get order details
    const orderResult = await getDbPool().query(`
      SELECT * FROM orders WHERE id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Check if order already has a print order
    if (order.gelato_order_id) {
      return res.status(400).json({ error: 'Order already has a print order ID', printOrderId: order.gelato_order_id });
    }

    // Find the PDF file for this story
    const pdfResult = await getDbPool().query(`
      SELECT id FROM files WHERE story_id = $1 AND file_type = 'story_pdf' ORDER BY created_at DESC LIMIT 1
    `, [order.story_id]);

    if (pdfResult.rows.length === 0) {
      return res.status(400).json({ error: 'No PDF found for this story. PDF needs to be regenerated.' });
    }

    const pdfFileId = pdfResult.rows[0].id;
    const baseUrl = process.env.BASE_URL || 'https://www.magicalstory.ch';
    const pdfUrl = `${baseUrl}/api/files/${pdfFileId}`;

    // Get story data to determine page count
    const storyResult = await getDbPool().query(`SELECT data FROM stories WHERE id = $1`, [order.story_id]);
    if (storyResult.rows.length === 0) {
      return res.status(400).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(storyResult.rows[0].data);
    const storyScenes = storyData.pages || storyData.sceneImages?.length || 15;
    const isPictureBook = storyData.languageLevel === '1st-grade';

    // Calculate total PDF pages (cover spread + blank + dedication + story pages)
    // Must match what generatePrintPdf() produces
    const frontMatterPages = 2; // blank left page + dedication right page
    let interiorPages = frontMatterPages + (isPictureBook ? storyScenes : storyScenes * 2);
    if (interiorPages % 2 !== 0) interiorPages += 1; // Pad to even
    const printPageCount = 1 + interiorPages; // +1 for cover spread
    log.debug(`📄 [ADMIN RETRY] Story has ${storyScenes} scenes, layout=${isPictureBook ? 'Picture Book' : 'Standard'}, interior=${interiorPages}, total=${printPageCount}`);

    // Get print product UID - prefer softcover for retry (can be changed in admin UI)
    const productsResult = await getDbPool().query(
      'SELECT product_uid, product_name, cover_type, min_pages, max_pages FROM gelato_products WHERE is_active = true ORDER BY cover_type ASC'
    );

    let printProductUid = null;
    if (productsResult.rows.length > 0) {
      // Find product matching the page count (prefer softcover)
      const matchingProduct = productsResult.rows.find(p =>
        printPageCount >= (p.min_pages || 0) && printPageCount <= (p.max_pages || 999)
      );
      if (matchingProduct) {
        printProductUid = matchingProduct.product_uid;
        log.debug(`📦 [ADMIN RETRY] Using product: ${matchingProduct.product_name} (${matchingProduct.cover_type})`);
      } else {
        // Use first product if no page count match
        printProductUid = productsResult.rows[0].product_uid;
        log.warn(`📦 [ADMIN RETRY] No product matches page count ${printPageCount}, using first: ${productsResult.rows[0].product_name}`);
      }
    }

    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      if (!printProductUid) {
        return res.status(500).json({ error: 'No active products configured. Please add products in admin dashboard.' });
      }
    }

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey) {
      return res.status(500).json({ error: 'GELATO_API_KEY not configured' });
    }

    // Admin retry: Use user role to determine Gelato order type
    // Admins get draft for testing, but can force real order if needed
    const orderType = isUserTestMode(req.user) ? 'draft' : 'order';
    log.debug(`📦 [GELATO] Retry: Creating ${orderType} (user role: ${req.user.role})`);

    const printOrderPayload = {
      orderType: orderType,
      orderReferenceId: `retry-${order.story_id}-${Date.now()}`,
      customerReferenceId: order.user_id,
      currency: 'CHF',
      items: [{
        itemReferenceId: `item-retry-${order.story_id}-${Date.now()}`,
        productUid: printProductUid,
        pageCount: printPageCount,
        files: [{
          type: 'default',
          url: pdfUrl
        }],
        quantity: 1
      }],
      shipmentMethodUid: 'standard',
      shippingAddress: {
        firstName: (order.shipping_name || order.customer_name || '').split(' ')[0] || 'Customer',
        lastName: (order.shipping_name || order.customer_name || '').split(' ').slice(1).join(' ') || '',
        addressLine1: order.shipping_address_line1 || '',
        addressLine2: order.shipping_address_line2 || '',
        city: order.shipping_city || '',
        postCode: order.shipping_postal_code || '',
        state: order.shipping_state || '',
        country: order.shipping_country || 'CH',
        email: order.customer_email,
        phone: ''
      }
    };

    log.debug(`📦 [ADMIN] Retry print order payload: productUid=${printProductUid}, pageCount=${printPageCount}, pdfUrl=${pdfUrl}`);

    const printResponse = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': printApiKey
      },
      body: JSON.stringify(printOrderPayload)
    });

    if (!printResponse.ok) {
      const errorText = await printResponse.text();
      log.error(`❌ [ADMIN] Print provider API error: ${printResponse.status} - ${errorText}`);
      return res.status(printResponse.status).json({
        error: 'Print provider order failed',
        details: errorText
      });
    }

    const printOrder = await printResponse.json();
    console.log('✅ [ADMIN] Print order created:', printOrder.orderId);

    // Update order with print order ID
    await getDbPool().query(`
      UPDATE orders
      SET gelato_order_id = $1,
          gelato_status = 'submitted',
          payment_status = 'completed',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [printOrder.orderId, orderId]);

    res.json({
      success: true,
      message: 'Print order created successfully',
      printOrderId: printOrder.orderId
    });

  } catch (err) {
    log.error('❌ [ADMIN] Error retrying print order:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PRICING API - Single source of truth for book pricing
// ============================================================

// Get all pricing tiers (public endpoint)
router.get('/pricing', async (req, res) => {
  try {
    const tiers = await getDbPool().query(
      'SELECT max_pages, label, softcover_price, hardcover_price FROM pricing_tiers ORDER BY max_pages ASC'
    );

    // Transform to frontend-friendly format
    const formattedTiers = tiers.rows.map(tier => ({
      maxPages: tier.max_pages,
      label: tier.label,
      softcover: tier.softcover_price,
      hardcover: tier.hardcover_price
    }));

    res.json({ tiers: formattedTiers, maxBookPages: 100 });
  } catch (err) {
    log.error('❌ Error fetching pricing tiers:', err);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

// Helper function to get price for a given page count
async function getPriceForPages(pageCount, isHardcover) {
  const tiers = await getDbPool().query(
    'SELECT softcover_price, hardcover_price FROM pricing_tiers WHERE max_pages >= $1 ORDER BY max_pages ASC LIMIT 1',
    [pageCount]
  );

  if (tiers.rows.length === 0) {
    // Exceeds maximum - use highest tier
    const maxTier = await getDbPool().query(
      'SELECT softcover_price, hardcover_price FROM pricing_tiers ORDER BY max_pages DESC LIMIT 1'
    );
    if (maxTier.rows.length === 0) {
      throw new Error('No pricing tiers configured');
    }
    const tier = maxTier.rows[0];
    return isHardcover ? tier.hardcover_price : tier.softcover_price;
  }

  const tier = tiers.rows[0];
  return isHardcover ? tier.hardcover_price : tier.softcover_price;
}

// Create Stripe checkout session for book purchase
router.post('/stripe/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    // Support both single storyId and array of storyIds
    const { storyId, storyIds, coverType = 'softcover', bookFormat = 'square' } = req.body;
    const userId = req.user.id;

    // Normalize to array
    const allStoryIds = storyIds || (storyId ? [storyId] : []);
    if (allStoryIds.length === 0) {
      return res.status(400).json({ error: 'No stories provided' });
    }

    // Get the appropriate Stripe client for this user (test for admins, live for regular users)
    const userStripe = getStripeForUser(req.user);
    const isTestMode = isUserTestMode(req.user);

    if (!userStripe) {
      const keyNeeded = isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY';
      return res.status(500).json({ error: `Stripe not configured. Please set ${keyNeeded}` });
    }

    console.log(`💳 Creating Stripe checkout session for user ${userId}, stories: ${allStoryIds.join(', ')}`);
    log.debug(`   Mode: ${isTestMode ? 'TEST (admin)' : 'LIVE (real payment)'}, Cover: ${coverType}`);

    // Fetch all stories and calculate total pages
    const stories = [];
    let totalPages = 0;
    for (const sid of allStoryIds) {
      const storyResult = await getDbPool().query('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [sid, userId]);
      if (storyResult.rows.length === 0) {
        return res.status(404).json({ error: `Story not found: ${sid}` });
      }
      const storyData = typeof storyResult.rows[0].data === 'string'
        ? JSON.parse(storyResult.rows[0].data)
        : storyResult.rows[0].data;
      stories.push({ id: sid, data: storyData });

      // Calculate pages for this story
      const isPictureBook = storyData.languageLevel === '1st-grade';
      const sceneCount = storyData.sceneImages?.length || storyData.pages || 5;
      totalPages += isPictureBook ? sceneCount : sceneCount * 2;
    }

    // Add 3 pages per story for covers and title page
    totalPages += stories.length * 3;

    // Calculate price based on pages and cover type (using database pricing)
    const isHardcover = coverType === 'hardcover';
    const priceInChf = await getPriceForPages(totalPages, isHardcover);
    const price = priceInChf * 100; // Convert CHF to cents for Stripe

    const firstStory = stories[0].data;
    const bookTitle = stories.length === 1
      ? firstStory.title
      : `${firstStory.title} + ${stories.length - 1} more`;

    // Create checkout session with user-appropriate Stripe client
    const session = await userStripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: `Personalized Storybook: ${bookTitle}`,
            description: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}, ${totalPages} pages, ${coverType}`,
          },
          unit_amount: price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/stories?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/stories?payment=cancelled`,
      metadata: {
        userId: userId.toString(),
        storyIds: JSON.stringify(allStoryIds),
        storyCount: stories.length.toString(),
        totalPages: totalPages.toString(),
        coverType: coverType,
        bookFormat: bookFormat
      },
      shipping_address_collection: {
        allowed_countries: ['DE', 'AT', 'CH', 'FR', 'IT', 'NL', 'BE', 'LU']
      },
    });

    console.log(`✅ Checkout session created: ${session.id}`);
    log.debug(`   Stories: ${stories.length}, Pages: ${totalPages}, Price: CHF ${price / 100}`);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    log.error('❌ Error creating checkout session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe checkout session for credits purchase
router.post('/stripe/create-credits-checkout', authenticateToken, async (req, res) => {
  try {
    const { credits: requestedCredits = CREDIT_CONFIG.LIMITS.MIN_PURCHASE } = req.body;
    const userId = req.user.id;

    // Server-side price validation - NEVER trust client-provided amounts
    // Use centralized pricing config
    const { CENTS_PER_CREDIT } = CREDIT_CONFIG.PRICING;
    const { MIN_PURCHASE, MAX_PURCHASE } = CREDIT_CONFIG.LIMITS;

    // Validate and sanitize credits amount
    const credits = Math.min(MAX_PURCHASE, Math.max(MIN_PURCHASE, Math.round(Number(requestedCredits) || MIN_PURCHASE)));

    // Calculate amount server-side (never trust client)
    const amount = credits * CENTS_PER_CREDIT;

    // Get the appropriate Stripe client for this user
    const userStripe = getStripeForUser(req.user);
    const isTestMode = isUserTestMode(req.user);

    if (!userStripe) {
      const keyNeeded = isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY';
      return res.status(500).json({ error: `Stripe not configured. Please set ${keyNeeded}` });
    }

    console.log(`💳 Creating credits checkout session for user ${userId}`);
    log.debug(`   Mode: ${isTestMode ? 'TEST (admin)' : 'LIVE (real payment)'}`);
    log.debug(`   Credits: ${credits}, Amount: CHF ${(amount / 100).toFixed(2)} (server-calculated)`);

    // Create checkout session
    const session = await userStripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: `${credits} Story Credits`,
            description: `${credits} credits for creating personalized stories on MagicalStory`,
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/create?credits_payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/create?credits_payment=cancelled`,
      metadata: {
        type: 'credits',
        userId: userId.toString(),
        credits: credits.toString(),
      },
    });

    console.log(`✅ Credits checkout session created: ${session.id}`);
    console.log(`   URL: ${session.url}`);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    log.error('❌ Error creating credits checkout session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Check payment/order status (no auth required - session ID is already secure)
router.get('/stripe/order-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    log.debug(`🔍 Checking order status for session: ${sessionId}`);

    // Check database for order with retries (webhook might still be processing)
    if (STORAGE_MODE === 'database') {
      const maxRetries = 5;
      const retryDelay = 1000; // 1 second between retries

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const order = await getDbPool().query(
          'SELECT * FROM orders WHERE stripe_session_id = $1',
          [sessionId]
        );

        if (order.rows.length > 0) {
          console.log(`✅ Order found in database (attempt ${attempt}):`, order.rows[0].id);
          return res.json({
            status: 'completed',
            order: order.rows[0]
          });
        }

        if (attempt < maxRetries) {
          log.debug(`⏳ Order not found yet, waiting... (attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      log.warn(`Order not in database after ${maxRetries} attempts, checking Stripe directly`);
    }

    // If not in database yet, check Stripe and return full session data
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer_details', 'shipping_details']
    });
    log.debug(`📋 Stripe session status: ${session.payment_status}`);

    // If payment was successful, construct order-like response from Stripe data
    if (session.payment_status === 'paid') {
      const customerDetails = session.customer_details || {};
      const shippingDetails = session.shipping_details || {};
      const shippingAddress = shippingDetails.address || {};

      // Calculate expected tokens (webhook may not have run yet)
      const totalPages = parseInt(session.metadata?.totalPages) || 0;
      let tokensExpected = 0;
      if (totalPages > 0) {
        const promoResult = await getDbPool().query("SELECT config_value FROM config WHERE config_key = 'token_promo_multiplier'");
        const multiplier = promoResult.rows[0]?.config_value ? parseInt(promoResult.rows[0].config_value) : 1;
        tokensExpected = totalPages * 10 * multiplier;
      }

      log.debug(`📦 Constructing order from Stripe session data`);
      return res.json({
        status: 'processing', // Webhook hasn't completed yet but payment succeeded
        order: {
          customer_name: customerDetails.name || 'Customer',
          customer_email: customerDetails.email || '',
          shipping_name: shippingDetails.name || customerDetails.name || 'Customer',
          shipping_address_line1: shippingAddress.line1 || '',
          shipping_city: shippingAddress.city || '',
          shipping_postal_code: shippingAddress.postal_code || '',
          shipping_country: shippingAddress.country || '',
          amount_total: session.amount_total,
          currency: session.currency,
          tokens_credited: tokensExpected // Expected tokens (will be credited when webhook completes)
        }
      });
    }

    res.json({
      status: session.payment_status,
      session: {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency
      }
    });
  } catch (err) {
    log.error('❌ Error checking order status:', err);
    res.status(500).json({ error: 'Failed to check order status' });
  }
});

// Background function to process book orders after payment
// isTestPayment: true = admin/developer (Gelato draft), false = real user (Gelato real order)
// coverType: 'softcover' or 'hardcover' - determines which product to use
// NOTE: processBookOrder moved to server/lib/gelato.js

module.exports = router;
