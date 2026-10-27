const test = require('node:test');
const assert = require('node:assert');
const { snapToValidPageCount, countBookContentPages, computeBookPageInfo, buildPrintedPageSequence, isBlankPagesAckMissing, BLANK_PAGES_ACK_FROM } = require('./gelato');

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

// Real production case: row has min=30 max=200 but available_page_counts=[24]
// (corrupt sync). The list's max is below the row's min — should be ignored
// and the range rules used instead.
test('inconsistent list (max < row min): falls through to range rules', () => {
  const product = {
    product_uid: 'softcover-corrupt-list',
    min_pages: 30,
    max_pages: 200,
    available_page_counts: [24],
  };
  assert.strictEqual(snapToValidPageCount(26, product), 30, 'ignores [24], falls to range, lifts 26 → 30');
  assert.strictEqual(snapToValidPageCount(31, product), 32);
  assert.strictEqual(snapToValidPageCount(60, product), 60);
});

// Same as above but list's max is also below estimated (still inconsistent).
test('inconsistent list (max < estimated): falls through to range rules', () => {
  const product = {
    product_uid: 'softcover-corrupt-list-2',
    min_pages: 30,
    max_pages: 200,
    available_page_counts: [24, 26, 28],
  };
  assert.strictEqual(snapToValidPageCount(50, product), 50, 'list capped below estimated, range used');
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

// --- Book page info: content pages -> orderable pages -> blank count ---------
// One source of truth for the pre-payment warning and the PDF padding.

const storyOf = (n, { backCover = false } = {}) => ({
  storyText: Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\nText ${i + 1}`).join('\n'),
  ...(backCover ? { coverImages: { backCover: { imageData: 'x' } } } : {}),
});
const poolWith = (rows) => ({ query: async () => ({ rows }) });
const HARDCOVER_A4 = {
  product_uid: 'photobooks-hardcover_pf_210x280-mm-portrait_pt_170-gsm',
  product_name: 'Hardcover A4',
  min_pages: 30,
  max_pages: 200,
  available_page_counts: null,
};

const HARDCOVER_SQUARE = {
  product_uid: 'photobooks-hardcover_pf_200x200-mm-square_pt_170-gsm',
  product_name: 'Hardcover square',
  min_pages: 30,
  max_pages: 200,
  available_page_counts: null,
};
const ROWS = [HARDCOVER_A4, HARDCOVER_SQUARE];

test('countBookContentPages: dedication + story pages; story 2+ adds title/dedication/back cover/separator', () => {
  assert.strictEqual(countBookContentPages([storyOf(10)]), 11);
  assert.strictEqual(countBookContentPages([storyOf(10), storyOf(10)]), 1 + 10 + 2 + 10);
  assert.strictEqual(countBookContentPages([storyOf(10), storyOf(10, { backCover: true }), storyOf(10)]),
    1 + 10 + (2 + 10 + 1 + 1) + (2 + 10)); // back cover + separator (not last)
  assert.strictEqual(countBookContentPages([storyOf(10), storyOf(10), storyOf(10, { backCover: true })]),
    1 + 10 + (2 + 10) + (2 + 10 + 1)); // last story: back cover, no separator
});

test('computeBookPageInfo: 10-page story on a 30-page minimum hardcover prints as a spread (9 blank, was 19)', async () => {
  const info = await computeBookPageInfo(poolWith(ROWS), [storyOf(10)], 'hardcover');
  assert.strictEqual(info.layout, 'spread');
  assert.strictEqual(info.contentPagesSingle, 11, 'price tier stays on the single-layout count');
  assert.strictEqual(info.contentPages, 21);
  assert.strictEqual(info.printedPages, 30);
  assert.strictEqual(info.blankPages, 9);
});

test('computeBookPageInfo: a book that exactly fills an orderable count has no blanks', async () => {
  const info = await computeBookPageInfo(poolWith(ROWS), [storyOf(29)], 'hardcover');
  assert.strictEqual(info.contentPages, 30);
  assert.strictEqual(info.printedPages, 30);
  assert.strictEqual(info.blankPages, 0);
});

test('computeBookPageInfo: odd content count is padded to even and reported as blank', async () => {
  const info = await computeBookPageInfo(poolWith(ROWS), [storyOf(30)], 'hardcover');
  assert.strictEqual(info.contentPages, 31);
  assert.strictEqual(info.printedPages, 32);
  assert.strictEqual(info.blankPages, 1);
});

test('computeBookPageInfo: combined multi-story book is counted with the extra pages', async () => {
  const info = await computeBookPageInfo(poolWith(ROWS),
    [storyOf(10), storyOf(10, { backCover: true }), storyOf(10)], 'hardcover');
  assert.strictEqual(info.contentPages, 37);
  assert.strictEqual(info.printedPages, 38);
  assert.strictEqual(info.blankPages, 1);
});

test('computeBookPageInfo: discrete page-count list snaps up to the next entry', async () => {
  const sku = { ...HARDCOVER_A4, available_page_counts: [24, 30, 40, 50] };
  const info = await computeBookPageInfo(poolWith([sku, HARDCOVER_SQUARE]), [storyOf(36)], 'hardcover');
  assert.strictEqual(info.layout, 'single'); // 3 blank pages: below BLANK_PAGES_ACK_FROM
  assert.strictEqual(info.contentPages, 37);
  assert.strictEqual(info.printedPages, 40);
  assert.strictEqual(info.blankPages, 3);
});

test('computeBookPageInfo: no matching SKU reports only the parity blank', async () => {
  const info = await computeBookPageInfo(poolWith([]), [storyOf(10)], 'hardcover');
  assert.strictEqual(info.product, null);
  assert.strictEqual(info.printedPages, 12);
  assert.strictEqual(info.blankPages, 1);
});

// Printed-book preview sequence: same layout as generatePrintPdf, same count as computeBookPageInfo.
const countKind = (seq, k) => seq.filter(s => s.kind === k).length;

test('buildPrintedPageSequence: 6-page trial story on a 30-page SKU is a spread with 17 blank filler pages', async () => {
  const stories = [storyOf(6)];
  const info = await computeBookPageInfo(poolWith(ROWS), stories, 'hardcover');
  assert.strictEqual(info.layout, 'spread');
  assert.strictEqual(info.printedPages, 30);
  assert.strictEqual(info.blankPages, 17);
  const seq = info.sequence;
  assert.deepStrictEqual(seq.slice(0, 3).map(s => s.kind), ['cover', 'insideFront', 'dedication']);
  assert.strictEqual(countKind(seq, 'story'), 0);
  assert.deepStrictEqual(seq.slice(3, 7).map(s => s.kind), ['storyImage', 'storyText', 'storyImage', 'storyText']);
  assert.deepStrictEqual(seq.filter(s => s.kind === 'storyImage').map(s => s.pageNumber), [1, 2, 3, 4, 5, 6]);
  assert.strictEqual(countKind(seq, 'filler'), 17);
  assert.strictEqual(seq[seq.length - 1].kind, 'insideBack');
  assert.strictEqual(seq.length, 30 + 3); // Gelato pages + cover + inside front + inside back
});

test('buildPrintedPageSequence: filler count always equals computeBookPageInfo.blankPages', async () => {
  for (const stories of [[storyOf(10)], [storyOf(29)], [storyOf(30)],
    [storyOf(10), storyOf(10, { backCover: true }), storyOf(10)]]) {
    const info = await computeBookPageInfo(poolWith(ROWS), stories, 'hardcover');
    assert.strictEqual(countKind(info.sequence, 'filler'), info.blankPages);
    assert.strictEqual(info.sequence.length, info.printedPages + 3);
  }
});

test('buildPrintedPageSequence: multi-story book lays out title, dedication, back cover and separator', () => {
  const seq = buildPrintedPageSequence([storyOf(2), storyOf(2, { backCover: true }), storyOf(2)], 13);
  assert.deepStrictEqual(seq.map(s => s.kind), [
    'cover', 'insideFront', 'dedication',
    'story', 'story',
    'title', 'dedication', 'story', 'story', 'backCover', 'separator',
    'title', 'dedication', 'story', 'story',
    'insideBack',
  ]);
});

test('isBlankPagesAckMissing: requires explicit true from BLANK_PAGES_ACK_FROM blank pages up', () => {
  assert.strictEqual(isBlankPagesAckMissing(0, undefined), false);
  assert.strictEqual(isBlankPagesAckMissing(BLANK_PAGES_ACK_FROM - 1, undefined), false);
  assert.strictEqual(isBlankPagesAckMissing(23, undefined), true);
  assert.strictEqual(isBlankPagesAckMissing(23, false), true);
  assert.strictEqual(isBlankPagesAckMissing(23, 'true'), true, 'only boolean true counts');
  assert.strictEqual(isBlankPagesAckMissing(23, true), false);
});

// --- The print format follows the layout (owner 2026-10-27): spread = square, single = A4 -----------------
test('computeBookPageInfo: mini book (6 and 15 scenes) is square, facing pages, the only option, no surcharge', async () => {
  for (const n of [6, 15]) {
    const info = await computeBookPageInfo(poolWith(ROWS), [storyOf(n)], 'hardcover');
    assert.strictEqual(info.layout, 'spread');
    assert.strictEqual(info.bookFormat, 'square');
    assert.strictEqual(info.productUid, HARDCOVER_SQUARE.product_uid);
    assert.strictEqual(info.layouts.single.available, false);
    assert.strictEqual(info.layoutSurchargeChf, 0);
  }
});

test('computeBookPageInfo: 29 scenes (30-page minimum SKU) default to single A4; facing on request is square with the surcharge', async () => {
  const main = await computeBookPageInfo(poolWith(ROWS), [storyOf(29)], 'hardcover');
  assert.strictEqual(main.layout, 'single');
  assert.strictEqual(main.bookFormat, 'A4');
  assert.strictEqual(main.productUid, HARDCOVER_A4.product_uid);
  assert.strictEqual(main.layoutSurchargeChf, 0);
  const facing = await computeBookPageInfo(poolWith(ROWS), [storyOf(29)], 'hardcover', { layout: 'spread' });
  assert.strictEqual(facing.bookFormat, 'square');
  assert.strictEqual(facing.productUid, HARDCOVER_SQUARE.product_uid);
  assert.strictEqual(facing.layoutSurchargeChf, 5);
});

test('computeBookPageInfo: 61 scenes cannot be printed as facing pages', async () => {
  const stories = [storyOf(25), storyOf(25), storyOf(11)];
  const info = await computeBookPageInfo(poolWith(ROWS), stories, 'hardcover');
  assert.strictEqual(info.layouts.spread.available, false);
  assert.strictEqual(info.bookFormat, 'A4');
  await assert.rejects(() => computeBookPageInfo(poolWith(ROWS), stories, 'hardcover', { layout: 'spread' }), /not available/);
});

test('computeBookPageInfo: a client-sent format (legacy 4th argument) is ignored', async () => {
  const info = await computeBookPageInfo(poolWith(ROWS), [storyOf(29)], 'hardcover', 'square');
  assert.strictEqual(info.bookFormat, 'A4');
  assert.strictEqual(info.layout, 'single');
});
