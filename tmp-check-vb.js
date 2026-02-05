// Fetch visual bible from API
const https = require('https');
const fs = require('fs');

const token = process.env.AUTH_TOKEN || process.argv[2];

if (!token) {
  console.log('Usage: node tmp-check-vb.js <auth_token>');
  console.log('Get auth token from localStorage in browser dev tools');
  process.exit(1);
}

// Fetch stories list first
const options = {
  hostname: 'www.magicalstory.ch',
  path: '/api/stories?limit=1',
  headers: {
    'Authorization': `Bearer ${token}`
  }
};

https.get(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const stories = JSON.parse(data);
      if (!stories.stories || stories.stories.length === 0) {
        console.log('No stories found');
        return;
      }

      const storyId = stories.stories[0].id;
      console.log('Latest story:', storyId);
      console.log('Title:', stories.stories[0].title);

      // Fetch story details with dev=true
      const detailsOptions = {
        hostname: 'www.magicalstory.ch',
        path: `/api/stories/${storyId}?dev=true`,
        headers: {
          'Authorization': `Bearer ${token}`
        }
      };

      https.get(detailsOptions, (res2) => {
        let data2 = '';
        res2.on('data', chunk => data2 += chunk);
        res2.on('end', () => {
          try {
            const story = JSON.parse(data2);
            const vb = story.visualBible;

            if (!vb) {
              console.log('No visual bible in story');
              return;
            }

            console.log('\n=== Visual Bible Structure ===');
            console.log('Top-level keys:', Object.keys(vb));

            if (vb.characters) {
              console.log('\n=== Characters ===');
              for (const [name, data] of Object.entries(vb.characters)) {
                console.log(`\n--- ${name} ---`);
                console.log('  Keys:', Object.keys(data));

                if (data.referenceGrid) {
                  console.log('  referenceGrid: present, length:', data.referenceGrid.length);
                }

                if (data.gridLayout) {
                  console.log('  gridLayout:', JSON.stringify(data.gridLayout, null, 4));
                }

                if (data.appearances) {
                  console.log('  appearances count:', data.appearances.length);
                  data.appearances.forEach((app, i) => {
                    console.log(`  [${i}] page ${app.pageNumber}, clothing: ${app.clothing}`);
                    if (app.cropData) console.log(`      cropData:`, JSON.stringify(app.cropData));
                    if (app.bbox) console.log(`      bbox:`, JSON.stringify(app.bbox));
                  });
                }
              }
            }

            // Save visual bible
            fs.writeFileSync('tmp-vb-data.json', JSON.stringify(vb, null, 2));
            console.log('\n\nFull visual bible saved to tmp-vb-data.json');

            // Also save cover images info
            if (story.coverImages) {
              console.log('\n=== Cover Images ===');
              for (const [key, cover] of Object.entries(story.coverImages)) {
                if (cover) {
                  console.log(`${key}:`);
                  console.log('  hasImageData:', !!cover.imageData || typeof cover === 'string');
                  console.log('  hasBboxDetection:', !!cover.bboxDetection);
                  console.log('  hasBboxOverlayImage:', !!cover.bboxOverlayImage);
                  if (cover.bboxDetection) {
                    console.log('  figures:', cover.bboxDetection.figures?.length || 0);
                  }
                }
              }
            }

          } catch (e) {
            console.error('Error parsing story details:', e.message);
          }
        });
      });

    } catch (e) {
      console.error('Error parsing stories:', e.message, data.substring(0, 200));
    }
  });
}).on('error', e => console.error('Request error:', e.message));
