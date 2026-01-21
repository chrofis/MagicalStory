// Export Swiss landmarks to text file
const https = require('https');

const url = 'https://magicalstory.ch/api/admin/swiss-landmarks?secret=clear-landmarks-2026&limit=500';

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const result = JSON.parse(data);

    console.log('Swiss Landmarks Database - ' + result.count + ' landmarks');
    console.log('='.repeat(60));
    console.log('');

    // Group by city
    const byCity = {};
    for (const l of result.landmarks) {
      const city = l.city || 'Unknown';
      if (!byCity[city]) byCity[city] = [];
      byCity[city].push(l);
    }

    // Sort cities and output
    const cities = Object.keys(byCity).sort();
    for (const city of cities) {
      const landmarks = byCity[city];
      console.log(`${city} (${landmarks.length} landmarks)`);
      console.log('-'.repeat(40));
      for (const l of landmarks) {
        console.log(`  ${l.name} [${l.type || '?'}]`);
      }
      console.log('');
    }
  });
}).on('error', err => {
  console.error('Error:', err.message);
});
