-- Migration: Update Gelato products to 28-page minimum
-- Date: 2025-12-07
-- Updates product configuration to support 28-52 pages (covering 14-26 scenes)
-- Note: Gelato only counts story content pages, not covers

-- Update the existing product to change minimum from 24 to 28
-- and update available page counts to include all valid options
UPDATE gelato_products
SET
  min_pages = 28,
  max_pages = 52,
  available_page_counts = '[28,32,36,40,44,48,52]',
  product_name = '14x14cm Softcover Photobook',
  description = 'Square softcover photobook, 28-52 Gelato pages (14-26 scenes)',
  updated_at = CURRENT_TIMESTAMP
WHERE product_uid = 'photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0';

-- If no product exists yet, insert the default one
INSERT INTO gelato_products (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
SELECT
  'photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
  '14x14cm Softcover Photobook',
  'Square softcover photobook, 28-52 Gelato pages (14-26 scenes)',
  '14x14cm (5.5x5.5 inch)',
  'Softcover',
  28, 52,
  '[28,32,36,40,44,48,52]',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM gelato_products
  WHERE product_uid = 'photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0'
);
