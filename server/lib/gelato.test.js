const test = require('node:test');
const assert = require('node:assert');
const { snapToValidPageCount } = require('./gelato');

// Discrete page-count list takes priority. Smallest entry >= estimated.
test('discrete list: snaps up to next entry', () => {
  const product = {
    product_uid: 'softcover-discrete',
    available_page_counts: [24, 30, 40, 50, 60, 80, 100, 120, 150, 200],
    min_pages: 24,
    max_pages: 200,
  };
  assert.strictEqual(snapToValidPageCount(20, product), 24);
  assert.strictEqual(snapToValidPageCount(24, product), 24);
  assert.strictEqual(snapToValidPageCount(26, product), 30);
  assert.strictEqual(snapToValidPageCount(30, product), 30);
  assert.strictEqual(snapToValidPageCount(31, product), 40);
  assert.strictEqual(snapToValidPageCount(150, product), 150);
  assert.strictEqual(snapToValidPageCount(151, product), 200);
  assert.strictEqual(snapToValidPageCount(500, product), 200, 'caps at last entry');
});

test('discrete list passed as JSON string is parsed', () => {
  const product = {
    product_uid: 'softcover-string-list',
    available_page_counts: '[30, 40, 50]',
    min_pages: 30,
    max_pages: 50,
  };
  assert.strictEqual(snapToValidPageCount(35, product), 40);
});

// Single-count SKU (e.g. 24-only photobook).
test('min == max: returns that single count', () => {
  const product = {
    product_uid: 'softcover-24-only',
    min_pages: 24,
    max_pages: 24,
    available_page_counts: null,
  };
  assert.strictEqual(snapToValidPageCount(10, product), 24);
  assert.strictEqual(snapToValidPageCount(24, product), 24);
  assert.strictEqual(snapToValidPageCount(50, product), 24);
});

// Even-range SKU (no discrete list).
test('range with no discrete list: any even count in [min, max]', () => {
  const product = {
    product_uid: 'softcover-range',
    min_pages: 30,
    max_pages: 200,
    available_page_counts: null,
  };
  assert.strictEqual(snapToValidPageCount(1, product), 30, 'below min lifts to min');
  assert.strictEqual(snapToValidPageCount(26, product), 30);
  assert.strictEqual(snapToValidPageCount(30, product), 30);
  assert.strictEqual(snapToValidPageCount(31, product), 32);
  assert.strictEqual(snapToValidPageCount(32, product), 32);
  assert.strictEqual(snapToValidPageCount(33, product), 34);
  assert.strictEqual(snapToValidPageCount(199, product), 200);
  assert.strictEqual(snapToValidPageCount(201, product), 200, 'caps at max');
  assert.strictEqual(snapToValidPageCount(500, product), 200);
});

// Odd min: rule is "any even count in [min, max]", so an odd min itself
// is not a valid count — bumps up to the next even.
test('range with odd min: snaps to next even', () => {
  const product = {
    product_uid: 'odd-min-test',
    min_pages: 31,
    max_pages: 100,
    available_page_counts: null,
  };
  assert.strictEqual(snapToValidPageCount(20, product), 32);
  assert.strictEqual(snapToValidPageCount(31, product), 32);
  assert.strictEqual(snapToValidPageCount(32, product), 32);
});

// Bad data: throws clearly so the caller surfaces a real error.
test('missing min/max with no list: throws', () => {
  assert.throws(
    () => snapToValidPageCount(50, { product_uid: 'broken-row', min_pages: null, max_pages: null }),
    /missing min\/max/
  );
  assert.throws(
    () => snapToValidPageCount(50, { product_uid: 'broken-row-2', min_pages: 0, max_pages: 0 }),
    /missing min\/max/
  );
});

// Empty discrete list falls through to range rules.
test('empty available_page_counts falls through to min/max', () => {
  const product = {
    product_uid: 'empty-list-fallback',
    available_page_counts: [],
    min_pages: 30,
    max_pages: 200,
  };
  assert.strictEqual(snapToValidPageCount(26, product), 30);
});

// Garbage in discrete list filtered out.
test('discrete list with non-numeric entries filters them', () => {
  const product = {
    product_uid: 'noisy-list',
    available_page_counts: [24, 'oops', null, 30, 40, -5, 0],
    min_pages: 24,
    max_pages: 40,
  };
  assert.strictEqual(snapToValidPageCount(26, product), 30);
});
