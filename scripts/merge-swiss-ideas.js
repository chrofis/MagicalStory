#!/usr/bin/env node
/**
 * Merge swiss-ideas-batch-*.json files into swiss-story-ideas.json
 * and validate all cities/ideas are present.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '../server/data');
const outputPath = path.join(dataDir, 'swiss-story-ideas.json');

// Find all batch files (matches batch-01.json, batch-01a.json, etc.)
const batchFiles = fs.readdirSync(dataDir)
  .filter(f => f.match(/^swiss-ideas-batch-\d+[a-z]?\.json$/))
  .sort();

if (batchFiles.length === 0) {
  console.error('No batch files found in server/data/');
  process.exit(1);
}

console.log(`Found ${batchFiles.length} batch files:`);

const merged = {};
let totalIdeas = 0;
let errors = [];

for (const file of batchFiles) {
  console.log(`  Reading ${file}...`);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
    for (const [cityId, ideas] of Object.entries(data)) {
      if (merged[cityId]) {
        errors.push(`Duplicate city ${cityId} in ${file}`);
        continue;
      }
      // Validate each idea
      for (const idea of ideas) {
        if (!idea.id) errors.push(`Missing id in ${cityId} (${file})`);
        if (!idea.title?.en) errors.push(`Missing title.en for ${idea.id || cityId} (${file})`);
        if (!idea.title?.de) errors.push(`Missing title.de for ${idea.id || cityId} (${file})`);
        if (!idea.title?.fr) errors.push(`Missing title.fr for ${idea.id || cityId} (${file})`);
        if (!idea.description?.en) errors.push(`Missing description.en for ${idea.id || cityId} (${file})`);
        if (!idea.context?.en) errors.push(`Missing context.en for ${idea.id || cityId} (${file})`);
      }
      merged[cityId] = ideas;
      totalIdeas += ideas.length;
    }
  } catch (err) {
    errors.push(`Failed to parse ${file}: ${err.message}`);
  }
}

// Check expected cities
const citiesFile = path.join(dataDir, 'swiss-cities.json');
if (fs.existsSync(citiesFile)) {
  const citiesData = JSON.parse(fs.readFileSync(citiesFile, 'utf-8'));
  const expectedCities = citiesData.cities.map(c => c.id);
  const missingCities = expectedCities.filter(id => !merged[id]);
  if (missingCities.length > 0) {
    console.warn(`\nWARNING: ${missingCities.length} cities missing from batches:`);
    console.warn('  ' + missingCities.join(', '));
  }
  const extraCities = Object.keys(merged).filter(id => !expectedCities.includes(id));
  if (extraCities.length > 0) {
    console.warn(`\nWARNING: ${extraCities.length} extra cities not in swiss-cities.json:`);
    console.warn('  ' + extraCities.join(', '));
  }
}

if (errors.length > 0) {
  console.error(`\n${errors.length} errors found:`);
  errors.forEach(e => console.error(`  - ${e}`));
}

// Sort cities alphabetically for consistent output
const sorted = {};
for (const key of Object.keys(merged).sort()) {
  sorted[key] = merged[key];
}

fs.writeFileSync(outputPath, JSON.stringify(sorted, null, 2));
console.log(`\nWrote ${outputPath}`);
console.log(`  Cities: ${Object.keys(sorted).length}`);
console.log(`  Total ideas: ${totalIdeas}`);
console.log(`  Errors: ${errors.length}`);
