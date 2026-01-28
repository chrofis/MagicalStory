/**
 * Gelato Print Provider Integration
 *
 * Functions for creating and managing print orders with Gelato
 */

const { log } = require('../utils/logger');
const { generatePrintPdf, generateCombinedBookPdf } = require('./pdf');
const { rehydrateStoryImages } = require('../services/database');

/**
 * Get cover dimensions from Gelato API including spine width
 *
 * @param {string} productUid - Gelato product UID
 * @param {number} pageCount - Number of interior pages
 * @returns {Promise<{spineWidth: number, coverWidth: number, coverHeight: number} | null>}
 */
async function getCoverDimensions(productUid, pageCount) {
  const printApiKey = process.env.GELATO_API_KEY;
  if (!printApiKey) {
    log.warn('[GELATO] No API key configured, cannot fetch cover dimensions');
    return null;
  }

  try {
    const url = `https://product.gelatoapis.com/v3/products/${productUid}/cover-dimensions?pagesCount=${pageCount}&measureUnit=mm`;
    log.debug(`[GELATO] Fetching cover dimensions: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-KEY': printApiKey
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.warn(`[GELATO] Cover dimensions API error: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json();
    log.debug(`[GELATO] Cover dimensions response:`, JSON.stringify(data, null, 2));

    // Extract spine width from response
    const spineSize = data.spineSize || data.spine;
    if (spineSize) {
      const spineWidth = spineSize.width || spineSize;
      log.debug(`[GELATO] Spine width for ${pageCount} pages: ${spineWidth}mm`);
      return {
        spineWidth: spineWidth,
        coverWidth: data.wraparoundEdgeSize?.width || data.coverWidth,
        coverHeight: data.wraparoundEdgeSize?.height || data.coverHeight,
        raw: data
      };
    }

    return null;
  } catch (error) {
    log.error('[GELATO] Error fetching cover dimensions:', error.message);
    return null;
  }
}

/**
 * Process a book order after successful Stripe payment
 * Creates print order with Gelato and updates order status
 *
 * @param {Object} dbPool - Database connection pool
 * @param {string} sessionId - Stripe session ID
 * @param {number} userId - User ID
 * @param {string|string[]} storyIds - Story ID or array of story IDs
 * @param {Object} customerInfo - Customer information {name, email}
 * @param {Object} shippingAddress - Shipping address
 * @param {boolean} isTestPayment - Whether this is a test payment (creates draft order)
 * @param {string} coverType - Cover type: 'softcover' or 'hardcover'
 * @param {string} bookFormat - Book format: 'square' (200x200mm) or 'A4' (210x280mm)
 */
async function processBookOrder(dbPool, sessionId, userId, storyIds, customerInfo, shippingAddress, isTestPayment = false, coverType = 'softcover', bookFormat = 'square') {
  // Normalize storyIds to array (backwards compatible with single storyId)
  const allStoryIds = Array.isArray(storyIds) ? storyIds : [storyIds];

  console.log(`📚 [BACKGROUND] Starting book order processing for session ${sessionId}`);
  log.debug(`   Stories: ${allStoryIds.length} (${allStoryIds.join(', ')})`);
  log.debug(`   Payment mode: ${isTestPayment ? 'TEST (Gelato draft)' : 'LIVE (real Gelato order)'}`);
  log.debug(`   Cover type: ${coverType}, Book format: ${bookFormat}`);

  // Determine Gelato order type based on payment mode
  const gelatoOrderType = isTestPayment ? 'draft' : 'order';

  try {
    // Step 1: Update order status to "processing"
    await dbPool.query(`
      UPDATE orders
      SET payment_status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $1
    `, [sessionId]);
    console.log('✅ [BACKGROUND] Order status updated to processing');

    // Step 2: Fetch all stories from database (batch query for performance)
    const storyResult = await dbPool.query(
      'SELECT id, data FROM stories WHERE id = ANY($1::text[])',
      [allStoryIds]
    );

    // Check all stories were found
    if (storyResult.rows.length !== allStoryIds.length) {
      const foundIds = storyResult.rows.map(r => r.id);
      const missingIds = allStoryIds.filter(id => !foundIds.includes(id));
      throw new Error(`Stories not found: ${missingIds.join(', ')}`);
    }

    // Parse and preserve order from allStoryIds
    const storiesMap = new Map();
    for (const row of storyResult.rows) {
      let storyData = row.data;
      if (typeof storyData === 'string') {
        storyData = JSON.parse(storyData);
      }
      // Rehydrate images from story_images table (images stripped from data blob)
      storyData = await rehydrateStoryImages(row.id, storyData);
      storiesMap.set(row.id, { id: row.id, data: storyData });
    }
    const stories = allStoryIds.map(id => storiesMap.get(id));

    console.log(`✅ [BACKGROUND] Fetched ${stories.length} stories`);
    log.debug('📊 [BACKGROUND] Titles:', stories.map(s => s.data.title).join(', '));

    // Step 3: Estimate page count and get product/spine info BEFORE generating PDF
    // This allows us to use actual spine width in PDF generation
    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey) {
      throw new Error('GELATO_API_KEY not configured');
    }

    // Estimate page count from story data
    const { parseStoryPages } = require('./pdf');
    let estimatedPageCount = 0;
    for (const story of stories) {
      const storyPages = parseStoryPages(story.data);
      const isPictureBook = story.data.languageLevel === '1st-grade';
      estimatedPageCount += isPictureBook ? storyPages.length : storyPages.length * 2;
    }
    // Add padding for covers, initial pages, endpapers, etc.
    estimatedPageCount += stories.length * 4; // Rough estimate for cover pages
    // Round up to even number
    if (estimatedPageCount % 2 !== 0) estimatedPageCount++;
    log.debug(`📊 [BACKGROUND] Estimated page count: ${estimatedPageCount}`);

    // Step 3a: Select product based on estimated page count
    const formatPattern = bookFormat === 'A4' ? '210x280' : '200x200';
    let printProductUid = null;
    const productsResult = await dbPool.query(
      'SELECT product_uid, product_name, min_pages, max_pages FROM gelato_products WHERE is_active = true AND LOWER(product_uid) LIKE $1 AND LOWER(product_uid) LIKE $2',
      [`%${coverType.toLowerCase()}%`, `%${formatPattern}%`]
    );
    if (productsResult.rows.length > 0) {
      const matchingProduct = productsResult.rows.find(p =>
        estimatedPageCount >= (p.min_pages || 0) && estimatedPageCount <= (p.max_pages || 999)
      );
      if (matchingProduct) {
        printProductUid = matchingProduct.product_uid;
        log.debug(`📦 [BACKGROUND] Selected product: ${matchingProduct.product_name}`);
      }
    }
    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      log.warn(`⚠️ [BACKGROUND] No product found for format=${bookFormat} (${formatPattern}), coverType=${coverType}, pages=${estimatedPageCount}. Using fallback GELATO_PHOTOBOOK_UID=${printProductUid}`);
    }

    // Step 3b: Get cover dimensions from Gelato API for actual spine width
    let actualSpineWidth = 10; // Default 10mm
    if (printProductUid) {
      const coverDims = await getCoverDimensions(printProductUid, estimatedPageCount);
      if (coverDims && coverDims.spineWidth) {
        actualSpineWidth = coverDims.spineWidth;
        log.debug(`📏 [BACKGROUND] Gelato spine width: ${actualSpineWidth}mm`);
      }
    }
    // PDF generation will add title + "MagicalStory.ch" to spine if wide enough (>= 10mm)

    // Step 3c: Generate PDF with actual spine width
    let pdfBuffer, targetPageCount;

    if (stories.length === 1) {
      // Single story - use existing generatePrintPdf with format and spine options
      log.debug(`📄 [BACKGROUND] Generating single-story PDF (format: ${bookFormat}, spine: ${actualSpineWidth}mm)...`);
      const result = await generatePrintPdf(stories[0].data, bookFormat, {
        actualSpineWidth
      });
      pdfBuffer = result.pdfBuffer;
      targetPageCount = result.pageCount;
    } else {
      // Multiple stories - generate combined book PDF with spine text
      log.debug(`📄 [BACKGROUND] Generating combined multi-story PDF (spine: ${actualSpineWidth}mm)...`);
      const result = await generateCombinedBookPdf(stories, { actualSpineWidth });
      pdfBuffer = result.pdfBuffer;
      targetPageCount = result.pageCount;
    }

    const pdfBase64 = pdfBuffer.toString('base64');
    console.log(`✅ [BACKGROUND] PDF generated: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB, ${targetPageCount} pages`);

    // Step 3.5: Save PDF to database and get public URL
    log.debug('💾 [BACKGROUND] Saving PDF to database...');
    const primaryStoryId = allStoryIds[0];
    const pdfFileId = `pdf-${primaryStoryId}-${Date.now()}`;
    const pdfInsertQuery = `
      INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET file_data = EXCLUDED.file_data
      RETURNING id
    `;
    const filename = allStoryIds.length > 1
      ? `book-${allStoryIds.length}-stories.pdf`
      : `story-${primaryStoryId}.pdf`;
    await dbPool.query(pdfInsertQuery, [
      pdfFileId,
      userId,
      'order_pdf',
      primaryStoryId,
      'application/pdf',
      pdfBase64,
      pdfBuffer.length,
      filename
    ]);

    // Get the base URL from environment or construct it
    const baseUrl = process.env.BASE_URL || 'https://www.magicalstory.ch';
    const pdfUrl = `${baseUrl}/api/files/${pdfFileId}`;
    console.log(`✅ [BACKGROUND] PDF saved with URL: ${pdfUrl}`);

    // Step 4: Create print order
    log.debug('📦 [BACKGROUND] Creating print order...');

    // Use the same targetPageCount calculated during PDF generation
    const printPageCount = targetPageCount;
    log.debug(`📊 [BACKGROUND] Final PDF page count: ${printPageCount} (estimated: ${estimatedPageCount})`);

    // Verify product is still valid for actual page count (should match estimate)
    if (!printProductUid) {
      throw new Error('No active products configured. Please add products in admin dashboard.');
    }
    console.log(`✅ [BACKGROUND] Using product: ${printProductUid} for ${printPageCount} pages`);

    // Use gelatoOrderType determined from isTestPayment parameter
    log.debug(`📦 [BACKGROUND] Creating Gelato ${gelatoOrderType} order`);

    // Use CHF currency for print orders
    const currency = 'CHF';

    // Create order reference using first story ID or combined if multiple
    const orderRefId = storyIds.length === 1 ? storyIds[0] : `multi-${storyIds.length}-${storyIds[0]}`;

    const printOrderPayload = {
      orderType: gelatoOrderType,
      orderReferenceId: `story-${orderRefId}-${Date.now()}`,
      customerReferenceId: userId,
      currency: currency,
      items: [{
        itemReferenceId: `item-${orderRefId}-${Date.now()}`,
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
        firstName: customerInfo.name.split(' ')[0] || customerInfo.name,
        lastName: customerInfo.name.split(' ').slice(1).join(' ') || '',
        addressLine1: shippingAddress.line1 || '',
        addressLine2: shippingAddress.line2 || '',
        city: shippingAddress.city || '',
        postCode: shippingAddress.postal_code || '',
        state: shippingAddress.state || '',
        country: shippingAddress.country || 'CH',
        email: customerInfo.email,
        phone: shippingAddress.phone || ''
      }
    };

    log.debug(`📦 [BACKGROUND] Print order payload: productUid=${printProductUid}, pageCount=${printPageCount}, orderType=${gelatoOrderType}`);

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
      throw new Error(`Print provider API error: ${printResponse.status} - ${errorText}`);
    }

    const printOrder = await printResponse.json();
    console.log('✅ [BACKGROUND] Print order created:', printOrder.orderId);

    // Step 5: Update order with print order ID and status
    await dbPool.query(`
      UPDATE orders
      SET gelato_order_id = $1,
          gelato_status = 'submitted',
          payment_status = 'completed',
          updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $2
    `, [printOrder.orderId, sessionId]);

    log.debug('🎉 [BACKGROUND] Book order processing completed successfully!');

  } catch (error) {
    log.error('❌ [BACKGROUND] Error processing book order:', error);

    // Update order status to failed
    try {
      await dbPool.query(`
        UPDATE orders
        SET payment_status = 'failed',
            updated_at = CURRENT_TIMESTAMP
        WHERE stripe_session_id = $1
      `, [sessionId]);
    } catch (updateError) {
      log.error('❌ [BACKGROUND] Failed to update order status:', updateError);
    }

    // Send admin alert about the failure
    try {
      const { sendAdminOrderFailureAlert } = require('../../email.js');
      await sendAdminOrderFailureAlert(sessionId, customerInfo.email, customerInfo.name, error.message);
    } catch (emailError) {
      log.error('❌ [BACKGROUND] Failed to send failure alert email:', emailError);
    }

    throw error;
  }
}

module.exports = {
  processBookOrder,
  getCoverDimensions
};
