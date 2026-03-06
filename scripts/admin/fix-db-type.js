// Script to remove DB_TYPE conditionals and keep only PostgreSQL queries
const fs = require('fs');

const filePath = 'C:\\Users\\roger\\MagicalStory\\server.js';
let content = fs.readFileSync(filePath, 'utf8');

// Pattern 1: Multi-line ternary with template literals (backticks)
// const query = DB_TYPE === 'postgresql' ? `SELECT $1 RETURNING *` : `SELECT ?`;
const pattern1 = /const (\w+Query) = DB_TYPE === 'postgresql'\s+\? `([^`]+)`\s+: `[^`]+`;/gs;
content = content.replace(pattern1, "const $1 = `$2`;");

// Pattern 2: Multi-line ternary with single quotes
// const query = DB_TYPE === 'postgresql' ? 'SELECT $1' : 'SELECT ?';
const pattern2 = /const (\w+Query) = DB_TYPE === 'postgresql'\s+\? '([^']+)'\s+: '[^']+';/gs;
content = content.replace(pattern2, "const $1 = '$2';");

// Pattern 3: Single line ternary with single quotes
const pattern3 = /DB_TYPE === 'postgresql' \? '([^']+)' : '[^']+'/g;
content = content.replace(pattern3, "'$1'");

// Pattern 4: if (DB_TYPE === 'postgresql') { code } else { code } - keep PostgreSQL branch
const pattern4 = /if \(DB_TYPE === 'postgresql'\) \{\s*([\s\S]*?)\s*\} else \{\s*[\s\S]*?\s*\}/g;
content = content.replace(pattern4, (match, pgCode) => {
  // Keep only the PostgreSQL code, trimming the braces
  return pgCode.trim();
});

// Save the modified content
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ Replaced all DB_TYPE conditionals with PostgreSQL-only code');
