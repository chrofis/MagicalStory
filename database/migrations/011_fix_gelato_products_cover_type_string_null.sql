-- Fix string "null" cover_type values in gelato_products table
-- The previous migration only handled SQL NULL, not the string "null"

UPDATE gelato_products
SET cover_type = CASE
    WHEN LOWER(product_uid) LIKE '%hardcover%' THEN 'hardcover'
    WHEN LOWER(product_uid) LIKE '%softcover%' THEN 'softcover'
    ELSE 'softcover'
END
WHERE cover_type = 'null'
   OR cover_type = ''
   OR cover_type IS NULL
   OR LOWER(cover_type) NOT IN ('softcover', 'hardcover');
