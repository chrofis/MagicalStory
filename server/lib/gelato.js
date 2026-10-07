/**
 * Gelato Print Provider Integration
 *
 * Functions for creating and managing print orders with Gelato
 */

const { log } = require('../utils/logger');
const { generatePrintPdf, generateCombinedBookPdf } = require('./pdf');
const { rehydrateStoryImages } = require('../services/database');

/**
 * Snap an estimated page count to a value the given Gelato SKU accepts.
 *
 * Three rules, in priority order:
 *   1. If the product has `available_page_counts` (discrete list, e.g.
 *      `[24, 30, 40, ...]`), pick the smallest entry >= estimated. If
 *      estimated exceeds the list's max, return the max.
 *   2. If `min_pages === max_pages`, only that exact count is valid.
 *   3. Otherwise treat the SKU as accepting any EVEN count in
 *      `[min_pages, max_pages]`. Snap up to the next even number,
 *      clamped to `max_pages`. If estimated < min, lift to min.
 *
 * Pure function — no I/O, no logging. Throws if min/max are missing
 * and no discrete list is provided (we cannot infer a valid count).
 *
 * @param {number} estimated - Pages the PDF would have without padding.
 * @param {{ min_pages: number|null, max_pages: number|null,
 *           available_page_counts: number[]|string|null,
 *           product_uid?: string }} product
 * @returns {number} Page count that Gelato will accept.
 */
function snapToValidPageCount(estimated, product) {
  // 1. Discrete list wins — but ONLY if it's compatible with the row's
  //    range. If the list's max < min_pages or < estimated, the list is
  //    inconsistent with the rest of the row (seen in production: a row
  //    with min=30/max=200 had available_page_counts=[24] from a stale
  //    sync). Ignore the list in that case and fall through to range rules.
  let counts = product.available_page_counts;
  if (typeof counts === 'string') {
    try { counts = JSON.parse(counts); } catch { counts = null; }
  }
  if (Array.isArray(counts) && counts.length > 0) {
    const sorted = counts
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const listMax = sorted[sorted.length - 1];
    const rowMin = product.min_pages || 0;
    const listInconsistent = sorted.length === 0
      || (listMax < estimated)
      || (rowMin && listMax < rowMin);
    if (!listInconsistent) {
      return sorted.find((n) => n >= estimated) ?? listMax;
    }
  }
  // 2 & 3. Range rules.
  const min = product.min_pages;
  const max = product.max_pages;
  if (!min || !max) {
    throw new Error(
      `Product ${product.product_uid || '?'} has no usable available_page_counts and missing min/max (min=${min}, max=${max}); cannot determine a valid page count`
    );
  }
  if (min === max) return min;
  let n = Math.max(min, estimated);
  if (n % 2 !== 0) n++;
  return Math.min(n, max);
}

/**
 * Interior content pages of a book: dedication + every story's pages.
 * Excludes cover spread, inside front blank and inside back blank (Gelato
 * does not count those in pageCount). Story 2+ adds title + dedication, plus
 * back cover (+ separator blank if not last) when the story has a back cover.
 * Mirrors what generatePrintPdf / generateCombinedBookPdf render.
 *
 * @param {Object[]} storyDatas - stories.data objects, in book order
 * @returns {number}
 */
function countBookContentPages(storyDatas) {
  const { parseStoryPages } = require('./pdf');
  let storyContentPages = 0;
  for (let si = 0; si < storyDatas.length; si++) {
    // Picture-book layout for all reading levels: 1 scene = 1 print page
    storyContentPages += parseStoryPages(storyDatas[si]).length;
    if (si > 0) {
      storyContentPages += 2; // title + dedication page (always)
      if (storyDatas[si]?.coverImages?.backCover) {
        storyContentPages += 1; // back cover
        if (si < storyDatas.length - 1) storyContentPages += 1; // separator blank
      }
    }
  }
  return 1 + storyContentPages; // + dedication
}

/**
 * Single source of truth for "how many pages will this book be printed with,
 * and how many of them are blank". Used by the order flow (PDF padding) and
 * by the pre-payment preview in the book builder.
 *
 * @param {import('pg').Pool} dbPool
 * @param {Object[]} storyDatas - stories.data objects, in book order
 * @param {'softcover'|'hardcover'} coverType
 * @param {'A4'|'square'} bookFormat
 * @returns {Promise<{contentPages:number, estimatedPageCount:number,
 *   printedPages:number, blankPages:number, productUid:string|null, product:Object|null}>}
 */
async function computeBookPageInfo(dbPool, storyDatas, coverType, bookFormat) {
  const contentPages = countBookContentPages(storyDatas);
  // Gelato requires even page counts for double-sided printing
  const estimatedPageCount = contentPages % 2 !== 0 ? contentPages + 1 : contentPages;
  const formatPattern = bookFormat === 'A4' ? '210x280' : '200x200';
  const productsResult = await dbPool.query(
    `SELECT product_uid, product_name, min_pages, max_pages, available_page_counts
       FROM gelato_products
      WHERE is_active = true
        AND LOWER(product_uid) LIKE $1
        AND LOWER(product_uid) LIKE $2
      ORDER BY max_pages ASC NULLS LAST, min_pages ASC NULLS LAST`,
    [`%${String(coverType).toLowerCase()}%`, `%${formatPattern}%`]
  );
  const product = productsResult.rows.find(p =>
    estimatedPageCount <= (p.max_pages || 999)
  ) || productsResult.rows[0] || null; // any active SKU; snap lifts below min
  if (!product) {
    return { contentPages, estimatedPageCount, printedPages: estimatedPageCount,
      blankPages: estimatedPageCount - contentPages, productUid: null, product: null };
  }
  let printedPages;
  try {
    printedPages = snapToValidPageCount(estimatedPageCount, product);
  } catch (err) {
    // Bad/incomplete row data. Fail loud rather than guessing — Gelato
    // will reject silently otherwise.
    throw new Error(
      `Cannot determine page count for product ${product.product_uid}: ${err.message}. ` +
      `Check the gelato_products row: min_pages, max_pages, and available_page_counts must be populated.`
    );
  }
  return { contentPages, estimatedPageCount, printedPages,
    blankPages: Math.max(0, printedPages - contentPages), productUid: product.product_uid, product };
}

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
    console.log(`[GELATO] Cover dimensions response for ${productUid}:`, JSON.stringify(data));

    // Extract dimensions from response
    const spineSize = data.spineSize || data.spine;
    if (spineSize) {
      const apiSpineWidth = spineSize.width || spineSize;
      const apiPageCount = data.pagesCount || pageCount;

      // The API may return dimensions for a different page count than requested
      // (e.g., always returns 32 for some products). Scale spine proportionally.
      let actualSpineWidth = apiSpineWidth;
      if (apiPageCount !== pageCount && apiPageCount > 0) {
        const spinePerPage = apiSpineWidth / apiPageCount;
        actualSpineWidth = Math.round(pageCount * spinePerPage * 100) / 100;
        console.log(`[GELATO] Spine scaled: API=${apiSpineWidth}mm (${apiPageCount}pg) → ${actualSpineWidth}mm (${pageCount}pg) @ ${spinePerPage.toFixed(4)}mm/pg`);
      } else {
        console.log(`[GELATO] Spine width for ${pageCount} pages: ${actualSpineWidth}mm`);
      }

      // Full cover page size: try wraparoundInsideSize (hardcover), productInsideSize, then bleedSize (softcover)
      const fullCoverSize = data.wraparoundInsideSize || data.productInsideSize || data.bleedSize;

      let coverPageWidth = fullCoverSize?.width;
      let coverPageHeight = fullCoverSize?.height;

      // If we used bleedSize and spine was scaled, adjust the width to match
      if (!data.wraparoundInsideSize && !data.productInsideSize && data.bleedSize && apiPageCount !== pageCount) {
        // bleedSize.width is for apiPageCount; adjust for actual page count
        coverPageWidth = data.bleedSize.width - apiSpineWidth + actualSpineWidth;
        console.log(`[GELATO] Cover width adjusted: ${data.bleedSize.width}mm → ${coverPageWidth}mm (spine delta: ${(actualSpineWidth - apiSpineWidth).toFixed(2)}mm)`);
      }

      // Also adjust content areas for the wider spine
      const spineDelta = actualSpineWidth - apiSpineWidth;
      const contentFront = data.contentFrontSize ? { ...data.contentFrontSize, left: data.contentFrontSize.left + spineDelta } : null;

      const result = {
        spineWidth: actualSpineWidth,
        // Full cover page dimensions (what Gelato expects as page 1 size)
        coverPageWidth: coverPageWidth,
        coverPageHeight: coverPageHeight,
        // Content areas for image placement (where the actual cover images go)
        contentBack: data.contentBackSize,   // { width, height, left, top } — unchanged, always starts from left
        contentFront: contentFront,          // { width, height, left, top } — shifted right by spine delta
        spineArea: { ...data.spineSize, width: actualSpineWidth },
        raw: data
      };
      const source = data.wraparoundInsideSize ? 'wraparoundInsideSize' : data.productInsideSize ? 'productInsideSize' : data.bleedSize ? 'bleedSize' : 'none';
      console.log(`[GELATO] Cover page size: ${result.coverPageWidth}x${result.coverPageHeight}mm (source: ${source})`);
      return result;
    }

    console.log(`[GELATO] No spineSize in response, returning null`);
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
async function processBookOrder(dbPool, sessionId, userId, storyIds, customerInfo, shippingAddress, isTestPayment = false, coverType = 'softcover', bookFormat = 'square', quantity = 1) {
  // Normalize storyIds to array (backwards compatible with single storyId)
  const allStoryIds = Array.isArray(storyIds) ? storyIds : [storyIds];

  console.log(`📚 [BACKGROUND] Starting book order processing for session ${sessionId}`);
  log.debug(`   Stories: ${allStoryIds.length} (${allStoryIds.join(', ')})`);
  log.debug(`   Payment mode: ${isTestPayment ? 'TEST (Gelato draft)' : 'LIVE (real Gelato order)'}`);
  log.debug(`   Cover type: ${coverType}, Book format: ${bookFormat}, Quantity: ${quantity}`);

  // Determine Gelato order type based on payment mode
  const gelatoOrderType = isTestPayment ? 'draft' : 'order';
  // Set the moment Gelato accepted the order. From then on the book IS ordered: a failure
  // after this point must never mark the order failed or tell the customer it failed (P8).
  let gelatoOrderId = null;

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

    // Page count + SKU come from computeBookPageInfo — the same function the
    // checkout preview (POST /api/book-page-info) uses, so the number shown
    // to the customer before payment is the number the PDF is padded to.
    const pageInfo = await computeBookPageInfo(dbPool, stories.map(s => s.data), coverType, bookFormat);
    const { estimatedPageCount, printedPages: snappedPageCount } = pageInfo;
    log.debug(`📊 [BACKGROUND] Estimated Gelato page count: ${estimatedPageCount} (${pageInfo.contentPages} content pages incl. dedication)`);
    let printProductUid = pageInfo.productUid;
    if (pageInfo.product) {
      if (snappedPageCount !== estimatedPageCount) {
        log.info(`📐 [BACKGROUND] Snapping ${estimatedPageCount} → ${snappedPageCount} pages for ${pageInfo.product.product_name} (${pageInfo.blankPages} blank of ${snappedPageCount})`);
      }
    } else {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      log.warn(`⚠️ [BACKGROUND] No active product matches format=${bookFormat}, coverType=${coverType}. Using GELATO_PHOTOBOOK_UID=${printProductUid}`);
    }

    // Step 3b: Get cover dimensions from Gelato API
    let coverDims = null;
    if (printProductUid) {
      coverDims = await getCoverDimensions(printProductUid, snappedPageCount);
      if (coverDims) {
        log.debug(`📏 [BACKGROUND] Gelato cover: ${coverDims.coverPageWidth}x${coverDims.coverPageHeight}mm, spine: ${coverDims.spineWidth}mm`);
      }
    }

    // Step 3c: Generate PDF with actual cover dimensions
    let pdfBuffer, targetPageCount;

    if (stories.length === 1) {
      log.debug(`📄 [BACKGROUND] Generating single-story PDF (format: ${bookFormat})...`);
      const result = await generatePrintPdf(stories[0].data, bookFormat, {
        gelatoCoverDims: coverDims,
        targetGelatoPageCount: snappedPageCount,
      });
      pdfBuffer = result.pdfBuffer;
      targetPageCount = result.pageCount;
    } else {
      // Multiple stories - generate combined book PDF
      log.debug(`📄 [BACKGROUND] Generating combined multi-story PDF...`);
      const result = await generateCombinedBookPdf(stories, bookFormat, {
        gelatoCoverDims: coverDims,
        targetGelatoPageCount: snappedPageCount,
      });
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
    const recipientName = customerInfo.shippingName || customerInfo.name;

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
        quantity: quantity
      }],
      shipmentMethodUid: 'standard',
      shippingAddress: {
        // The name the customer typed into the shipping form, not the cardholder's.
        firstName: recipientName.split(' ')[0] || recipientName,
        lastName: recipientName.split(' ').slice(1).join(' ') || '',
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
    // Gelato v4 API returns 'id', not 'orderId'
    gelatoOrderId = printOrder.id || printOrder.orderId;
    console.log('✅ [BACKGROUND] Print order created:', gelatoOrderId);

    // Step 5: Update order with print order ID and status
    await dbPool.query(`
      UPDATE orders
      SET gelato_order_id = $1,
          gelato_status = 'submitted',
          payment_status = 'completed',
          updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $2
    `, [gelatoOrderId, sessionId]);

    log.debug('🎉 [BACKGROUND] Book order processing completed successfully!');

  } catch (error) {
    if (gelatoOrderId) {
      // Gelato accepted the order but recording it failed. Marking the order failed here would
      // email the customer "order failed" for a book that IS being printed, and a later retry
      // would order it twice. Leave the row as it is and tell the admin the Gelato id.
      log.error(`❌ [BACKGROUND] CRITICAL: Gelato order ${gelatoOrderId} was created for session ${sessionId} but recording it failed: ${error.message}`);
      try {
        await require('../../email.js').sendAdminHealthReport(
          'Book order placed with Gelato but not recorded',
          `Stripe session: ${sessionId}
Gelato order id: ${gelatoOrderId}
Customer: ${customerInfo.name} <${customerInfo.email}>
DB error: ${error.message}

The book IS ordered. Write gelato_order_id onto the orders row by hand; do NOT re-run the order.`
        );
      } catch (emailError) {
        log.error('❌ [BACKGROUND] Failed to send Gelato-not-recorded alert:', emailError);
      }
      return;
    }
    log.error('❌ [BACKGROUND] Error processing book order:', error);

    // Update order status to failed (both payment_status and gelato_status)
    try {
      await dbPool.query(`
        UPDATE orders
        SET payment_status = 'failed',
            gelato_status = 'failed',
            updated_at = CURRENT_TIMESTAMP
        WHERE stripe_session_id = $1
      `, [sessionId]);
    } catch (updateError) {
      log.error('❌ [BACKGROUND] Failed to update order status:', updateError);
    }

    // Send failure emails: customer notification + admin alert
    try {
      const { sendOrderFailedEmail, sendAdminOrderFailureAlert } = require('../../email.js');
      await sendOrderFailedEmail(customerInfo.email, customerInfo.name, error.message, customerInfo.language);
      await sendAdminOrderFailureAlert(sessionId, customerInfo.email, customerInfo.name, error.message);
    } catch (emailError) {
      log.error('❌ [BACKGROUND] Failed to send failure emails:', emailError);
    }

    throw error;
  }
}

/**
 * The parcel's recipient and address from a Checkout Session, or null when the session
 * collected none. Since Stripe API 2025-03-31 (stripe-node v18+; this repo pins v20 =
 * 2025-11-17.clover) the address the customer typed into the shipping form lives ONLY in
 * `collected_information.shipping_details` - the old top-level `shipping` / `shipping_details`
 * fields no longer exist on the object. `customer_details.address` is the BILLING address,
 * which equals the shipping address only while "billing same as shipping" stays ticked.
 */
function shippingFromSession(session) {
  const details = session?.collected_information?.shipping_details;
  if (!details?.address) return null;
  return { name: details.name || '', address: details.address };
}

/**
 * Everything processBookOrder needs, derived from a (retrieved) Stripe Checkout session:
 * the webhook and the admin retry / stuck-order resume all build their inputs here, so a
 * re-run orders exactly what the customer paid for (every story, quantity, cover, format).
 * Throws when the session lacks a user, a shipping address or any valid story - never guesses.
 */
async function resolveBookOrderInputs(dbPool, fullSession) {
  const userId = fullSession.metadata?.userId;
  if (!userId) throw new Error('Invalid userId in session metadata');

  // A book checkout always runs with shipping_address_collection, so a paid session without
  // one is a contract breach, not a case to paper over with the billing address.
  const shipping = shippingFromSession(fullSession);
  if (!shipping) {
    throw new Error(`Checkout session ${fullSession.id || '?'} carries no shipping address (collected_information.shipping_details) - cannot ship a book`);
  }
  const customerInfo = {
    name: fullSession.customer_details?.name || shipping.name || 'N/A',
    email: fullSession.customer_details?.email || 'N/A',
    shippingName: shipping.name || fullSession.customer_details?.name || 'N/A',
    address: shipping.address,
  };
  const address = customerInfo.address;
  const coverType = fullSession.metadata?.coverType || 'softcover';
  const bookFormat = fullSession.metadata?.bookFormat || 'square';
  const quantity = parseInt(fullSession.metadata?.quantity) || 1;

  try {
    const langResult = await dbPool.query('SELECT preferred_language FROM users WHERE id = $1', [userId]);
    customerInfo.language = langResult.rows[0]?.preferred_language || 'English';
  } catch (langErr) {
    log.warn('⚠️ [BOOK ORDER] Failed to look up user language, defaulting to English:', langErr.message);
    customerInfo.language = 'English';
  }

  // Support both the storyIds array and the legacy single storyId
  let allStoryIds = [];
  if (fullSession.metadata?.storyIds) {
    try {
      allStoryIds = JSON.parse(fullSession.metadata.storyIds);
    } catch (e) {
      log.error('❌ [BOOK ORDER] Failed to parse storyIds:', e);
    }
  }
  if (allStoryIds.length === 0) {
    const storyIdRaw = fullSession.metadata?.storyId || fullSession.metadata?.story_id;
    if (storyIdRaw) allStoryIds = [storyIdRaw];
  }
  if (allStoryIds.length === 0) {
    throw new Error('Missing story IDs in session metadata - cannot process book order');
  }

  const validatedStoryIds = [];
  for (const sid of allStoryIds) {
    const result = await dbPool.query('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [sid, userId]);
    if (result.rows.length > 0) validatedStoryIds.push(sid);
    else log.warn(`⚠️ [BOOK ORDER] Story not found: ${sid}, skipping`);
  }
  if (validatedStoryIds.length === 0) throw new Error('No valid stories found');

  return { userId, customerInfo, address, coverType, bookFormat, quantity, validatedStoryIds };
}

/**
 * Re-run processBookOrder for an existing paid order, from the Stripe session it was paid
 * with. The Gelato order type follows the ORDER's stripe_mode (a test-mode order is a draft,
 * a live order is real) - never the caller's role. Refuses when the order already has a
 * Gelato id (re-running would order the book twice) or the session is not paid.
 */
async function resumeBookOrder(dbPool, orderRow, stripe, { run = processBookOrder } = {}) {
  if (orderRow.gelato_order_id) throw new Error(`Order ${orderRow.id} already has Gelato order ${orderRow.gelato_order_id}`);
  if (!stripe) throw new Error(`No Stripe client for stripe_mode=${orderRow.stripe_mode || 'live'}`);
  const session = await stripe.checkout.sessions.retrieve(orderRow.stripe_session_id, { expand: ['customer', 'line_items'] });
  if (session.payment_status !== 'paid') throw new Error(`Stripe session ${session.id} is ${session.payment_status}, not paid`);
  const inp = await resolveBookOrderInputs(dbPool, session);
  const isTestPayment = orderRow.stripe_mode === 'test';
  return run(dbPool, session.id, inp.userId, inp.validatedStoryIds, inp.customerInfo, inp.address,
    isTestPayment, inp.coverType, inp.bookFormat, inp.quantity);
}

const STUCK_ORDER_IDLE_MINUTES = 30;

/**
 * Boot + periodic check for paid orders whose background fulfilment died with the process
 * (deploy, OOM, idle shutdown) - review 2026-10-04 P8. Orders with no Gelato id and no
 * update for STUCK_ORDER_IDLE_MINUTES are:
 *  - 'paid'       -> processBookOrder never started: safe to resume, claimed atomically first.
 *  - 'processing' -> died mid-run, possibly AFTER Gelato accepted it: alert only, a re-run could
 *                    order the book twice. An admin decides (admin retry endpoint).
 *  - 'failed'     -> already alerted by processBookOrder; not repeated here.
 * `alerted` dedupes admin emails within one process.
 *
 * @returns {Promise<{resumed: string[], alerted: string[]}>}
 */
async function sweepStuckBookOrders(dbPool, { getStripeClientForOrder, sendAlert, alerted = new Set(), idleMinutes = STUCK_ORDER_IDLE_MINUTES }) {
  const stuck = await dbPool.query(
    `SELECT id, user_id, stripe_session_id, stripe_mode, payment_status, customer_email, updated_at
       FROM orders
      WHERE payment_status IN ('paid', 'processing')
        AND gelato_order_id IS NULL
        AND updated_at < NOW() - ($1 * INTERVAL '1 minute')
        AND created_at > NOW() - INTERVAL '30 days'
      ORDER BY created_at`,
    [idleMinutes]
  );
  const resumed = [];
  const alertedNow = [];
  for (const o of stuck.rows) {
    if (o.payment_status === 'paid') {
      const claim = await dbPool.query(
        `UPDATE orders SET updated_at = NOW()
          WHERE id = $1 AND payment_status = 'paid' AND gelato_order_id IS NULL
            AND updated_at < NOW() - ($2 * INTERVAL '1 minute')`,
        [o.id, idleMinutes]
      );
      if (claim.rowCount !== 1) continue; // another instance took it
      log.warn(`🔁 [ORDER-SWEEP] Resuming paid order ${o.id} (session ${o.stripe_session_id}): background processing never started`);
      resumed.push(o.stripe_session_id);
      // processBookOrder alerts + marks failed itself when the resume fails.
      resumeBookOrder(dbPool, o, getStripeClientForOrder(o)).catch(err => {
        log.error(`❌ [ORDER-SWEEP] Resume of order ${o.id} failed: ${err.message}`);
        if (!alerted.has(o.stripe_session_id)) {
          alerted.add(o.stripe_session_id);
          sendAlert(`Stuck book order could not be resumed (${o.id})`, `Order ${o.id}, session ${o.stripe_session_id}, ${o.customer_email}
${err.message}`);
        }
      });
    } else if (!alerted.has(o.stripe_session_id)) {
      alerted.add(o.stripe_session_id);
      alertedNow.push(o.stripe_session_id);
      log.error(`🚨 [ORDER-SWEEP] Order ${o.id} (session ${o.stripe_session_id}) stuck in 'processing' since ${o.updated_at}; customer paid, no Gelato order recorded`);
      sendAlert(
        `Paid book order stuck in processing (${o.id})`,
        `Order ${o.id}, Stripe session ${o.stripe_session_id}, customer ${o.customer_email}.
Status 'processing' with no Gelato order id since ${o.updated_at}. The process likely restarted mid-run. Check Gelato for an order from this session first; if none exists, use POST /api/admin/orders/${o.id}/retry-print-order.`
      );
    }
  }
  return { resumed, alerted: alertedNow };
}

module.exports = {
  shippingFromSession,
  resolveBookOrderInputs,
  resumeBookOrder,
  sweepStuckBookOrders,
  processBookOrder,
  getCoverDimensions,
  snapToValidPageCount,
  countBookContentPages,
  computeBookPageInfo,
};
