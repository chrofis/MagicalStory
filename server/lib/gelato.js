/**
 * Gelato Print Provider Integration
 *
 * Functions for creating and managing print orders with Gelato
 */

const { log } = require('../utils/logger');
const { generatePrintPdf, generateCombinedBookPdf } = require('./pdf');

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
      storiesMap.set(row.id, { id: row.id, data: storyData });
    }
    const stories = allStoryIds.map(id => storiesMap.get(id));

    console.log(`✅ [BACKGROUND] Fetched ${stories.length} stories`);
    log.debug('📊 [BACKGROUND] Titles:', stories.map(s => s.data.title).join(', '));

    // Step 3: Generate PDF (single story uses generatePrintPdf, multiple uses combined book)
    let pdfBuffer, targetPageCount;

    if (stories.length === 1) {
      // Single story - use existing generatePrintPdf with format
      log.debug(`📄 [BACKGROUND] Generating single-story PDF (format: ${bookFormat})...`);
      const result = await generatePrintPdf(stories[0].data, bookFormat);
      pdfBuffer = result.pdfBuffer;
      targetPageCount = result.pageCount;
    } else {
      // Multiple stories - generate combined book PDF (format not yet supported for multi-story)
      log.debug('📄 [BACKGROUND] Generating combined multi-story PDF...');
      const result = await generateCombinedBookPdf(stories);
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

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey) {
      throw new Error('GELATO_API_KEY not configured');
    }

    // Use the same targetPageCount calculated during PDF generation (already added blank pages)
    const printPageCount = targetPageCount;
    log.debug(`📊 [BACKGROUND] Using PDF page count for Gelato: ${printPageCount}`);

    // Fetch product UID from database based on page count and cover type
    let printProductUid = null;
    try {
      // Debug: log all active products
      const allProductsResult = await dbPool.query(
        'SELECT product_uid, product_name, cover_type, min_pages, max_pages FROM gelato_products WHERE is_active = true'
      );
      log.debug(`📦 [BACKGROUND] Active products: ${allProductsResult.rows.length}, looking for "${coverType}" + "${bookFormat}" with ${printPageCount} pages`);
      allProductsResult.rows.forEach((p, i) => {
        log.debug(`   ${i+1}. "${p.product_name}" cover_type="${p.cover_type}" pages=${p.min_pages}-${p.max_pages}`);
      });

      // Match by product_uid pattern for both coverType AND bookFormat
      // Book formats: 'square' = 200x200mm, 'A4' = 210x280mm (portrait)
      const formatPattern = bookFormat === 'A4' ? '210x280' : '200x200';
      const productsResult = await dbPool.query(
        'SELECT product_uid, product_name, min_pages, max_pages, available_page_counts, cover_type FROM gelato_products WHERE is_active = true AND LOWER(product_uid) LIKE $1 AND LOWER(product_uid) LIKE $2',
        [`%${coverType.toLowerCase()}%`, `%${formatPattern}%`]
      );

      log.debug(`📦 [BACKGROUND] Products matching "${coverType}" + "${formatPattern}": ${productsResult.rows.length}`);

      if (productsResult.rows.length > 0) {
        // Find product matching the page count using min/max range
        const matchingProduct = productsResult.rows.find(p => {
          return printPageCount >= (p.min_pages || 0) && printPageCount <= (p.max_pages || 999);
        });

        if (matchingProduct) {
          printProductUid = matchingProduct.product_uid;
          console.log(`✅ [BACKGROUND] Found matching ${coverType} ${bookFormat} product: ${matchingProduct.product_name}`);
        } else {
          log.warn(`[BACKGROUND] No ${coverType} ${bookFormat} product matches page count ${printPageCount}`);
        }
      } else {
        // Log all products to help debug
        const availableTypes = allProductsResult.rows.map(p => `"${p.cover_type}"`).join(', ');
        log.warn(`[BACKGROUND] No active ${coverType} ${bookFormat} products found. Available cover_types: ${availableTypes || 'none'}`);
      }
    } catch (err) {
      log.error('❌ [BACKGROUND] Error fetching products:', err.message);
    }

    // Fallback to environment variable or first active product of any type
    if (!printProductUid) {
      // Try to get any active product as fallback
      try {
        const fallbackResult = await dbPool.query(
          'SELECT product_uid, product_name FROM gelato_products WHERE is_active = true LIMIT 1'
        );
        if (fallbackResult.rows.length > 0) {
          printProductUid = fallbackResult.rows[0].product_uid;
          log.warn(`[BACKGROUND] Using fallback product: ${fallbackResult.rows[0].product_name}`);
        }
      } catch (err) {
        log.error('❌ [BACKGROUND] Error fetching fallback product:', err.message);
      }
    }

    // Final fallback to environment variable
    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      if (printProductUid) {
        log.warn(`[BACKGROUND] Using environment fallback product UID`);
      } else {
        throw new Error('No active products configured. Please add products in admin dashboard.');
      }
    }

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

    // Send failure notification email to customer
    try {
      const { sendEmail } = require('../../../email.js');
      await sendEmail({
        to: customerInfo.email,
        subject: 'Book Order Failed - MagicalStory',
        text: `Dear ${customerInfo.name},

Unfortunately, your book order could not be processed.

Error: ${error.message}

Please contact us at support@magicalstory.ch for assistance.

We apologize for the inconvenience.

Best regards,
The MagicalStory Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #dc2626;">Book Order Failed</h2>
            <p>Dear ${customerInfo.name},</p>
            <p>Unfortunately, your book order could not be processed.</p>
            <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <strong>Error:</strong> ${error.message}
            </div>
            <p>Please contact us at <a href="mailto:support@magicalstory.ch">support@magicalstory.ch</a> for assistance.</p>
            <p>We apologize for the inconvenience.</p>
            <p>Best regards,<br>The MagicalStory Team</p>
          </div>
        `
      });
      console.log(`📧 [BACKGROUND] Failure notification sent to ${customerInfo.email}`);
    } catch (emailError) {
      log.error('❌ [BACKGROUND] Failed to send failure email:', emailError);
    }

    throw error;
  }
}

module.exports = {
  processBookOrder
};
