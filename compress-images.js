const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const imagesDir = path.join(__dirname, 'images');

// Art style images to compress
const artStyleImages = [
  'anime style.jpg',
  'cartoon style.jpg',
  'chibi style.jpg',
  'comic book style.jpg',
  'manga style.jpg',
  'Pixar style.png',
  'steampunk.jpg'
];

// Reading level images
const readingLevelImages = [
  'text and image on each page.png',
  'left page text, right page image.png'
];

async function compressImage(filename) {
  const inputPath = path.join(imagesDir, filename);
  const ext = path.extname(filename).toLowerCase();
  const baseName = path.basename(filename, ext);

  // Output as optimized JPEG
  const outputPath = path.join(imagesDir, `${baseName}-optimized.jpg`);

  try {
    const originalSize = fs.statSync(inputPath).size;

    await sharp(inputPath)
      .resize(400, 400, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({
        quality: 80,
        progressive: true
      })
      .toFile(outputPath);

    const newSize = fs.statSync(outputPath).size;
    const savings = ((1 - newSize / originalSize) * 100).toFixed(1);

    console.log(`✅ ${filename}: ${(originalSize/1024).toFixed(0)}KB → ${(newSize/1024).toFixed(0)}KB (${savings}% smaller)`);

    // Replace original with optimized version
    fs.unlinkSync(inputPath);

    // Rename to original filename but with .jpg extension
    const finalPath = path.join(imagesDir, `${baseName}.jpg`);
    fs.renameSync(outputPath, finalPath);

    return { original: originalSize, compressed: newSize, finalName: `${baseName}.jpg` };
  } catch (err) {
    console.error(`❌ Error compressing ${filename}:`, err.message);
    return null;
  }
}

async function main() {
  console.log('🖼️  Compressing art style images...\n');

  let totalOriginal = 0;
  let totalCompressed = 0;
  const renames = [];

  for (const img of artStyleImages) {
    const result = await compressImage(img);
    if (result) {
      totalOriginal += result.original;
      totalCompressed += result.compressed;
      // Track if filename changed (png → jpg)
      if (img !== result.finalName) {
        renames.push({ from: img, to: result.finalName });
      }
    }
  }

  console.log('\n🖼️  Compressing reading level images...\n');

  for (const img of readingLevelImages) {
    const result = await compressImage(img);
    if (result) {
      totalOriginal += result.original;
      totalCompressed += result.compressed;
      if (img !== result.finalName) {
        renames.push({ from: img, to: result.finalName });
      }
    }
  }

  console.log('\n📊 Summary:');
  console.log(`   Original total: ${(totalOriginal/1024/1024).toFixed(2)} MB`);
  console.log(`   Compressed total: ${(totalCompressed/1024/1024).toFixed(2)} MB`);
  console.log(`   Total savings: ${((1 - totalCompressed/totalOriginal) * 100).toFixed(1)}%`);

  if (renames.length > 0) {
    console.log('\n⚠️  Files renamed (update index.html):');
    renames.forEach(r => console.log(`   ${r.from} → ${r.to}`));
  }
}

main();
