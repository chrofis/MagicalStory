-- Migration: Add 24-page photobook product
-- Date: 2025-12-06

-- Add product for 24-page stories
INSERT INTO gelato_products
(product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
VALUES
(
  'photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
  '14x14cm Softcover Photobook - 24 pages',
  'Square softcover photobook, perfect for children''s stories (24 pages)',
  '14x14cm (5.5x5.5 inch)',
  'Softcover',
  24,
  24,
  '[24]',
  true
)
ON DUPLICATE KEY UPDATE
  is_active = true,
  product_name = VALUES(product_name),
  description = VALUES(description);
