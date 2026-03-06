-- Migration: Add default Gelato photobook products
-- Date: 2025-12-06

-- PostgreSQL version
-- Insert default Gelato photobook products (14x14cm softcover)
INSERT INTO gelato_products (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
VALUES
  ('photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
   '14x14cm Softcover Photobook - 24 pages',
   'Square softcover photobook with 24 pages, perfect for short stories',
   '14x14cm (5.5x5.5 inch)',
   'Softcover',
   24, 24,
   '[24]',
   true),

  ('photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
   '14x14cm Softcover Photobook - 28 pages',
   'Square softcover photobook with 28 pages',
   '14x14cm (5.5x5.5 inch)',
   'Softcover',
   28, 28,
   '[28]',
   true),

  ('photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
   '14x14cm Softcover Photobook - 32 pages',
   'Square softcover photobook with 32 pages',
   '14x14cm (5.5x5.5 inch)',
   'Softcover',
   32, 32,
   '[32]',
   true),

  ('photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
   '14x14cm Softcover Photobook - 36 pages',
   'Square softcover photobook with 36 pages',
   '14x14cm (5.5x5.5 inch)',
   'Softcover',
   36, 36,
   '[36]',
   true),

  ('photobooks-softcover_pf_140x140-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_bt_glued-left_prt_1-0',
   '14x14cm Softcover Photobook - 40 pages',
   'Square softcover photobook with 40 pages',
   '14x14cm (5.5x5.5 inch)',
   'Softcover',
   40, 40,
   '[40]',
   true)
ON CONFLICT (product_uid) DO NOTHING;

-- Note: The same product_uid is used for all page counts
-- Gelato's API accepts the same product UID with different page counts via the pageCount parameter
