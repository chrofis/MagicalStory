-- Create story_images table for storing images separately from story data
-- This allows fast story metadata loading without fetching large image blobs

CREATE TABLE IF NOT EXISTS story_images (
    id SERIAL PRIMARY KEY,
    story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    image_type VARCHAR(50) NOT NULL, -- 'scene', 'frontCover', 'initialPage', 'backCover'
    page_number INTEGER, -- For scene images (1-based), NULL for covers
    version_index INTEGER DEFAULT 0, -- For multiple versions of same image
    image_data TEXT NOT NULL, -- Base64 encoded image
    quality_score REAL,
    generated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Unique constraint: one image per story/type/page/version combo
    UNIQUE(story_id, image_type, page_number, version_index)
);

-- Index for fast lookups by story
CREATE INDEX IF NOT EXISTS idx_story_images_story_id ON story_images(story_id);

-- Index for fast lookups by story and type
CREATE INDEX IF NOT EXISTS idx_story_images_story_type ON story_images(story_id, image_type);

-- Index for fast lookups by story, type, and page
CREATE INDEX IF NOT EXISTS idx_story_images_story_page ON story_images(story_id, image_type, page_number);
