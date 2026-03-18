/**
 * Test: ProgressiveUnifiedParser page detection
 * Verifies that pages are correctly detected during streaming and at finalize time.
 */

const { ProgressiveUnifiedParser } = require('../../server/lib/outlineParser');

let passCount = 0;
let failCount = 0;

function testCheckPages(label, fullText, expectedStreaming, expectedFinal) {
  // Simulate streaming: feed the full text in chunks, then finalize
  let streamingPagesEmitted = 0;
  let totalPagesEmitted = 0;

  const parser = new ProgressiveUnifiedParser({
    onPageComplete: (page) => {
      totalPagesEmitted++;
    },
    onProgress: () => {}
  });

  // Feed the entire text as one chunk (simulates streaming completion)
  parser.processChunk(fullText, fullText);
  streamingPagesEmitted = parser.emitted.pages.size;

  // Finalize
  parser.finalize();
  totalPagesEmitted = parser.emitted.pages.size;

  const streamOk = streamingPagesEmitted === expectedStreaming;
  const finalOk = totalPagesEmitted === expectedFinal;
  const status = streamOk && finalOk ? 'PASS' : 'FAIL';

  if (streamOk && finalOk) {
    passCount++;
  } else {
    failCount++;
  }

  console.log(`${status}: ${label}`);
  if (!streamOk) {
    console.log(`  STREAMING: got ${streamingPagesEmitted}, expected ${expectedStreaming}`);
  }
  if (!finalOk) {
    console.log(`  FINAL: got ${totalPagesEmitted}, expected ${expectedFinal}`);
  }
}

// ============================================================================
// TESTS
// ============================================================================

// TEST 1: Standard format (Claude) - bulleted characters, Setting line
testCheckPages(
  'Standard format (Claude) - 3 pages',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window. Snow was falling!

SCENE HINT:
Sophie presses hands against frosty window.
Characters (MAX 3):
- Sophie (right): standard
Setting: indoor | Time: morning | Weather: snowy

--- Page 2 ---
TEXT:
Max joined her at the window.

SCENE HINT:
Max and Sophie stand together at the window.
Characters (MAX 3):
- Sophie (right): standard
- Max (left): winter
Setting: indoor | Time: morning | Weather: snowy

--- Page 3 ---
TEXT:
They put on their coats and ran outside.

SCENE HINT:
Sophie and Max running out the door.
Characters (MAX 3):
- Sophie (center): winter
- Max (right): winter
Setting: outdoor | Time: morning | Weather: snowy
`,
  3,  // streaming: all 3 should emit
  3   // final: all 3
);

// TEST 2: No bullets (Grok deviation)
testCheckPages(
  'No bullets (Grok) - 2 pages',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters (MAX 3):
Sophie (right): standard
Setting: indoor | Time: morning | Weather: snowy

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max and Sophie at window.
Characters (MAX 3):
Sophie (right): standard
Max (left): winter
Setting: indoor | Time: morning | Weather: snowy
`,
  2,  // streaming: both should emit (page 1 has next page marker)
  2
);

// TEST 3: Inline characters (single line)
testCheckPages(
  'Inline characters - 2 pages',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters: Sophie (right): standard
Setting: indoor | Time: morning | Weather: snowy

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max and Sophie at window.
Characters: Sophie (right): standard, Max (left): winter
Setting: indoor | Time: morning | Weather: snowy
`,
  2,
  2
);

// TEST 4: No Setting line (just characters block)
testCheckPages(
  'No Setting line - 2 pages',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters:
- Sophie (right): standard

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max and Sophie at window.
Characters:
- Sophie (right): standard
- Max (left): winter
`,
  2,
  2
);

// TEST 5: No Setting line AND no bullets (worst case for Grok)
testCheckPages(
  'No Setting, no bullets - 2 pages',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters:
Sophie (right): standard

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max and Sophie at window.
Characters:
Sophie (right): standard
Max (left): winter
`,
  2,
  2
);

// TEST 6: 5 pages standard format
testCheckPages(
  '5 pages standard format',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Page 1 text.

SCENE HINT:
Scene 1 hint.
Characters:
- Sophie: standard
Setting: indoor

--- Page 2 ---
TEXT:
Page 2 text.

SCENE HINT:
Scene 2 hint.
Characters:
- Max: winter
Setting: outdoor

--- Page 3 ---
TEXT:
Page 3 text.

SCENE HINT:
Scene 3 hint.
Characters:
- Sophie: summer
Setting: outdoor

--- Page 4 ---
TEXT:
Page 4 text.

SCENE HINT:
Scene 4 hint.
Characters:
- Max: costumed:knight
Setting: indoor

--- Page 5 ---
TEXT:
Page 5 text.

SCENE HINT:
Scene 5 hint.
Characters:
- Sophie: standard
Setting: outdoor
`,
  5,
  5
);

// TEST 7: Last page with no clothing data (should emit at finalize)
testCheckPages(
  'Last page no clothing (finalize only)',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters (MAX 3):
- Sophie (right): standard
Setting: indoor | Time: morning | Weather: snowy

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max and Sophie at window.
`,
  1,  // streaming: only page 1 (page 2 has no clothing or setting)
  2   // final: page 2 emits at finalize
);

// TEST 8: Partial page 2 (still streaming, no SCENE HINT yet)
testCheckPages(
  'Partial page 2 (incomplete)',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters (MAX 3):
- Sophie (right): standard
Setting: indoor | Time: morning | Weather: snowy

--- Page 2 ---
TEXT:
Max joined her at the window. Together they watched`,
  1,  // streaming: page 1 emits (page 2 has no SCENE HINT)
  1   // final: page 2 still doesn't have SCENE HINT
);

// TEST 9: Comma-separated characters on same line
testCheckPages(
  'Comma-separated inline characters',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters: Sophie: standard, Max: winter
Setting: indoor | Time: morning | Weather: snowy

--- Page 2 ---
TEXT:
They went outside.

SCENE HINT:
Sophie and Max in the garden.
Characters: Sophie: winter, Max: winter
Setting: outdoor | Time: morning | Weather: snowy
`,
  2,
  2
);

// TEST 10: No Characters section at all (edge case)
testCheckPages(
  'No Characters section at all',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max and Sophie at window.
`,
  1,  // streaming: page 1 emits (next page marker), page 2 has no evidence of completion
  2   // final: page 2 emits at finalize
);

// TEST 11: Spaces around section markers (e.g., "--- STORY PAGES ---")
testCheckPages(
  'Spaced section markers',
  `--- STORY PAGES ---

--- Page 1 ---
TEXT:
Sophie ran to the window.

SCENE HINT:
Sophie presses hands against window.
Characters:
- Sophie: standard
Setting: indoor

--- Page 2 ---
TEXT:
Max joined her.

SCENE HINT:
Max at window.
Characters:
- Max: winter
Setting: indoor
`,
  2,
  2
);

// TEST 12: Costumed with description containing spaces
testCheckPages(
  'Costumed with description',
  `---STORY PAGES---

--- Page 1 ---
TEXT:
They put on their costumes.

SCENE HINT:
Sophie and Max in superhero costumes.
Characters (MAX 3):
- Sophie (right): costumed:princess with sparkly tiara
- Max (left): costumed:brave knight
Setting: indoor | Time: afternoon | Weather: n/a

--- Page 2 ---
TEXT:
They went trick-or-treating.

SCENE HINT:
Walking down the street.
Characters (MAX 3):
- Sophie (center): costumed:princess with sparkly tiara
Setting: outdoor | Time: night | Weather: clear
`,
  2,
  2
);

// TEST 13: Simulate progressive streaming (feed chunks)
{
  let pagesDetected = [];
  const parser = new ProgressiveUnifiedParser({
    onPageComplete: (page) => {
      pagesDetected.push(page.pageNumber);
    },
    onProgress: () => {}
  });

  // Chunk 1: STORY PAGES header + page 1 header + partial text
  let soFar = '---STORY PAGES---\n\n--- Page 1 ---\nTEXT:\nSophie ran to the';
  parser.processChunk(soFar, soFar);
  const after1 = pagesDetected.length;

  // Chunk 2: rest of page 1 + start of page 2
  soFar += ' window. Snow was falling!\n\nSCENE HINT:\nSophie presses hands against frosty window.\nCharacters:\n- Sophie (right): standard\nSetting: indoor | Time: morning | Weather: snowy\n\n--- Page 2 ---\nTEXT:\nMax';
  parser.processChunk('...', soFar);
  const after2 = pagesDetected.length;

  // Chunk 3: rest of page 2
  soFar += ' joined her at the window.\n\nSCENE HINT:\nMax and Sophie stand together at the window.\nCharacters:\n- Sophie (right): standard\n- Max (left): winter\nSetting: indoor | Time: morning | Weather: snowy\n';
  parser.processChunk('...', soFar);
  const after3 = pagesDetected.length;

  // Finalize
  parser.finalize();
  const afterFinal = pagesDetected.length;

  // After chunk 3, page 2 has TEXT + HINT + Setting line, so it correctly emits
  // even though it's the last known page (Setting line proves completeness)
  const ok = after1 === 0 && after2 === 1 && after3 === 2 && afterFinal === 2;
  const status = ok ? 'PASS' : 'FAIL';
  if (ok) passCount++; else failCount++;
  console.log(`${status}: Progressive streaming (chunks) - pages=[${pagesDetected}]`);
  if (!ok) {
    console.log(`  after chunk1: ${after1} (expect 0), chunk2: ${after2} (expect 1), chunk3: ${after3} (expect 2), final: ${afterFinal} (expect 2)`);
  }
}

// ============================================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passCount} passed, ${failCount} failed, ${passCount + failCount} total`);
if (failCount === 0) {
  console.log('All tests passed!');
} else {
  console.log('Some tests failed!');
  process.exit(1);
}
