-- Fix NULL cover_type values in gelato_products table
-- Derive cover_type from product_uid

UPDATE gelato_products
SET cover_type = CASE
    WHEN LOWER(product_uid) LIKE '%hardcover%' THEN 'hardcover'
    WHEN LOWER(product_uid) LIKE '%softcover%' THEN 'softcover'
    ELSE 'softcover'
END
WHERE cover_type IS NULL;

-- Also update any capitalized versions to lowercase for consistency
UPDATE gelato_products
SET cover_type = LOWER(cover_type)
WHERE cover_type IS NOT NULL AND cover_type != LOWER(cover_type);
