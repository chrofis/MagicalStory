-- Migration: Add 48-page photobook product (24 scenes × 2 pages/scene)
-- Date: 2025-12-06

-- Add product for 24-scene stories (48 PDF pages: text page + image page per scene)
INSERT INTO gelato_products
(product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
VALUES
(
  'photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
  '14x14cm Softcover Photobook - 48 pages',
  'Square softcover photobook, perfect for children''s stories (24 scenes, 48 PDF pages)',
  '14x14cm (5.5x5.5 inch)',
  'Softcover',
  48,
  48,
  '[48]',
  true
)
ON CONFLICT (product_uid) DO UPDATE SET
  is_active = true,
  product_name = EXCLUDED.product_name,
  description = EXCLUDED.description,
  min_pages = EXCLUDED.min_pages,
  max_pages = EXCLUDED.max_pages,
  available_page_counts = EXCLUDED.available_page_counts;
