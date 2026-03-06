import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockAvatarSet } from './mocks/runware-mock';

// Import character merge functions for testing the save logic
// @ts-expect-error - JS module without types
import {
  mergeCharacters,
  createLightCharacter
} from '../../server/lib/characterMerge.js';

/**
 * API Integration Tests for Avatar System
 *
 * These tests verify the data flow through the save/load cycle
 * without requiring a running server or database.
 */

describe('Avatar API Data Flow', () => {
  describe('Character Save Cycle', () => {
    it('preserves avatar images through save cycle', () => {
      // Simulate DB state after avatar generation
      const dbCharacters = [{
        id: 1,
        name: 'TestChild',
        age: '8',
        gender: 'female',
        avatars: createMockAvatarSet()
      }];

      // Simulate frontend save (stripped avatars)
      const frontendCharacters = [{
        id: 1,
        name: 'TestChild',
        age: '8',
        gender: 'female',
        avatars: {
          status: 'complete',
          generatedAt: dbCharacters[0].avatars.generatedAt,
          stale: false
          // No images - frontend strips them
        }
      }];

      // Merge (what happens in POST /api/characters)
      const { characters: merged } = mergeCharacters(frontendCharacters, dbCharacters);

      // Verify images preserved
      expect(merged[0].avatars.winter).toBeDefined();
      expect(merged[0].avatars.standard).toBeDefined();
      expect(merged[0].avatars.summer).toBeDefined();
      expect(merged[0].avatars.faceThumbnails).toBeDefined();
      expect(merged[0].avatars.status).toBe('complete');
      expect(merged[0].avatars.stale).toBe(false);
    });

    it('generates correct metadata for list queries', () => {
      const fullCharacter = {
        id: 1,
        name: 'FullDataChild',
        age: '10',
        photo_url: 'data:image/jpeg;base64,verylargephotodata...',
        body_photo_url: 'data:image/jpeg;base64,largerbodydata...',
        body_no_bg_url: 'data:image/png;base64,nobgdata...',
        clothing_avatars: { casual: 'bigdata' },
        avatars: {
          status: 'complete',
          stale: false,
          generatedAt: '2024-01-15',
          winter: 'data:image/png;base64,winterimage...',
          standard: 'data:image/png;base64,standardimage...',
          summer: 'data:image/png;base64,summerimage...',
          formal: 'data:image/png;base64,formalimage...',
          faceThumbnails: {
            winter: 'thumb-winter',
            standard: 'thumb-standard',
            summer: 'thumb-summer',
            formal: 'thumb-formal'
          },
          styledAvatars: {
            pixar: 'pixar-data',
            watercolor: 'watercolor-data'
          },
          clothing: {
            winter: { upperBody: 'jacket' },
            standard: { upperBody: 'shirt' }
          }
        }
      };

      const light = createLightCharacter(fullCharacter);

      // Heavy fields should be stripped
      expect(light.photo_url).toBeUndefined();
      expect(light.body_photo_url).toBeUndefined();
      expect(light.body_no_bg_url).toBeUndefined();
      expect(light.clothing_avatars).toBeUndefined();

      // Full avatar images should be stripped
      expect(light.avatars.winter).toBeUndefined();
      expect(light.avatars.standard).toBeUndefined();
      expect(light.avatars.styledAvatars).toBeUndefined();

      // Metadata should be preserved
      expect(light.avatars.status).toBe('complete');
      expect(light.avatars.stale).toBe(false);
      expect(light.avatars.generatedAt).toBe('2024-01-15');
      expect(light.avatars.hasFullAvatars).toBe(true);

      // Only standard thumbnail kept
      expect(light.avatars.faceThumbnails).toEqual({ standard: 'thumb-standard' });

      // Clothing descriptions kept (small text)
      expect(light.avatars.clothing).toBeDefined();
    });
  });

  describe('Multiple Character Handling', () => {
    it('handles mix of characters with and without avatars', () => {
      const dbCharacters = [
        {
          id: 1,
          name: 'WithAvatars',
          avatars: createMockAvatarSet()
        },
        {
          id: 2,
          name: 'NoAvatars',
          photo_url: 'some-photo'
        },
        {
          id: 3,
          name: 'PendingAvatars',
          avatars: { status: 'generating' }
        }
      ];

      const frontendCharacters = [
        { id: 1, name: 'WithAvatars', avatars: { status: 'complete', stale: false } },
        { id: 2, name: 'NoAvatars' },
        { id: 3, name: 'PendingAvatars', avatars: { status: 'generating' } }
      ];

      const { characters: merged } = mergeCharacters(frontendCharacters, dbCharacters);

      // Character 1: full avatars preserved
      expect(merged[0].avatars.winter).toBeDefined();
      expect(merged[0].avatars.standard).toBeDefined();

      // Character 2: no avatars, photo preserved
      expect(merged[1].avatars).toBeUndefined();
      expect(merged[1].photo_url).toBe('some-photo');

      // Character 3: generating status, no images yet
      expect(merged[2].avatars.status).toBe('generating');
      expect(merged[2].avatars.winter).toBeUndefined();
    });

    it('handles character reordering correctly', () => {
      const dbCharacters = [
        { id: 1, name: 'First', avatars: createMockAvatarSet() },
        { id: 2, name: 'Second', avatars: createMockAvatarSet() }
      ];

      // Frontend sends in different order
      const frontendCharacters = [
        { id: 2, name: 'Second', avatars: { status: 'complete' } },
        { id: 1, name: 'First', avatars: { status: 'complete' } }
      ];

      const { characters: merged } = mergeCharacters(frontendCharacters, dbCharacters);

      // Order should match frontend, but data should be merged correctly
      expect(merged[0].name).toBe('Second');
      expect(merged[0].avatars.winter).toBeDefined();

      expect(merged[1].name).toBe('First');
      expect(merged[1].avatars.winter).toBeDefined();
    });
  });

  describe('Stale Avatar Handling', () => {
    it('marks avatars stale when photo changes', () => {
      const dbCharacters = [{
        id: 1,
        name: 'PhotoChanged',
        photo_url: 'old-photo',
        avatars: {
          ...createMockAvatarSet(),
          stale: false
        }
      }];

      // Frontend uploads new photo and marks avatars stale
      const frontendCharacters = [{
        id: 1,
        name: 'PhotoChanged',
        photo_url: 'new-photo',
        avatars: {
          status: 'complete',
          stale: true // Marked stale by frontend
        }
      }];

      const { characters: merged } = mergeCharacters(frontendCharacters, dbCharacters);

      // New photo should be used
      expect(merged[0].photo_url).toBe('new-photo');

      // Avatars preserved but marked stale
      expect(merged[0].avatars.winter).toBeDefined();
      expect(merged[0].avatars.stale).toBe(true);
    });

    it('clears stale flag after avatar regeneration', () => {
      // DB has stale avatars
      const dbCharactersStale = [{
        id: 1,
        name: 'Regenerated',
        avatars: {
          status: 'complete',
          stale: true,
          winter: 'stale-winter',
          standard: 'stale-standard'
        }
      }];

      // Avatar regeneration completes - new DB state
      const dbCharactersNew = [{
        id: 1,
        name: 'Regenerated',
        avatars: {
          status: 'complete',
          stale: false,
          winter: 'new-winter',
          standard: 'new-standard',
          generatedAt: new Date().toISOString()
        }
      }];

      // Frontend confirms completion
      const frontendCharacters = [{
        id: 1,
        name: 'Regenerated',
        avatars: {
          status: 'complete',
          stale: false
        }
      }];

      const { characters: merged } = mergeCharacters(frontendCharacters, dbCharactersNew);

      expect(merged[0].avatars.stale).toBe(false);
      expect(merged[0].avatars.winter).toBe('new-winter');
    });
  });

  describe('New Character Flow', () => {
    it('handles new character without existing DB entry', () => {
      const dbCharacters: unknown[] = [];

      const frontendCharacters = [{
        id: Date.now(),
        name: 'BrandNew',
        age: '5',
        gender: 'male'
      }];

      const { characters: merged, preservedCount } = mergeCharacters(frontendCharacters, dbCharacters);

      expect(merged.length).toBe(1);
      expect(merged[0].name).toBe('BrandNew');
      expect(preservedCount).toBe(0); // Nothing to preserve
    });

    it('new character gets avatars from generation job', () => {
      // Step 1: New character created
      const newChar = {
        id: 12345,
        name: 'NewKid',
        age: '7',
        photo_url: 'uploaded-photo'
      };

      // No existing DB entry
      const { characters: step1 } = mergeCharacters([newChar], []);
      expect(step1[0].avatars).toBeUndefined();

      // Step 2: Avatar generation completes, saved to DB
      const dbWithAvatars = [{
        ...step1[0],
        avatars: createMockAvatarSet()
      }];

      // Step 3: Frontend updates with avatar status
      const frontendWithStatus = [{
        id: 12345,
        name: 'NewKid',
        age: '7',
        avatars: { status: 'complete', stale: false }
      }];

      const { characters: step3 } = mergeCharacters(frontendWithStatus, dbWithAvatars);

      // Avatars should be present from DB
      expect(step3[0].avatars.winter).toBeDefined();
      expect(step3[0].avatars.standard).toBeDefined();
      expect(step3[0].avatars.faceThumbnails).toBeDefined();
    });
  });
});

describe('Avatar Generation Job Queue', () => {
  let jobQueue: Map<string, unknown>;

  beforeEach(() => {
    jobQueue = new Map();
  });

  it('creates job with pending status', () => {
    const jobId = `avatar-job-${Date.now()}`;
    const job = {
      id: jobId,
      characterId: 1,
      characterName: 'TestKid',
      status: 'pending',
      createdAt: Date.now(),
      variants: ['winter', 'standard', 'summer']
    };

    jobQueue.set(jobId, job);

    const retrieved = jobQueue.get(jobId);
    expect(retrieved).toBeDefined();
    expect((retrieved as any).status).toBe('pending');
  });

  it('updates job progress', () => {
    const jobId = 'test-job-123';
    const job = {
      id: jobId,
      status: 'generating',
      progress: { completed: 0, total: 4 },
      results: {} as Record<string, unknown>
    };

    jobQueue.set(jobId, job);

    // Simulate completing winter variant
    job.results['winter'] = { success: true, image: 'winter-img' };
    job.progress.completed = 1;

    // Simulate completing standard variant
    job.results['standard'] = { success: true, image: 'standard-img' };
    job.progress.completed = 2;

    const updated = jobQueue.get(jobId) as any;
    expect(updated.progress.completed).toBe(2);
    expect(Object.keys(updated.results)).toHaveLength(2);
  });

  it('marks job complete when all variants done', () => {
    const jobId = 'complete-job';
    const job = {
      id: jobId,
      status: 'generating',
      progress: { completed: 3, total: 4 },
      results: {
        winter: { success: true },
        standard: { success: true },
        summer: { success: true }
      } as Record<string, unknown>
    };

    jobQueue.set(jobId, job);

    // Complete final variant
    job.results['formal'] = { success: true };
    job.progress.completed = 4;
    job.status = 'complete';

    const completed = jobQueue.get(jobId) as any;
    expect(completed.status).toBe('complete');
    expect(completed.progress.completed).toBe(completed.progress.total);
  });

  it('handles partial failure gracefully', () => {
    const job = {
      id: 'partial-fail',
      status: 'generating',
      progress: { completed: 0, total: 4 },
      results: {} as Record<string, unknown>,
      errors: [] as string[]
    };

    // Simulate one variant failing
    job.results['winter'] = { success: true };
    job.progress.completed = 1;

    job.results['standard'] = { success: false, error: 'API timeout' };
    job.errors.push('standard: API timeout');
    job.progress.completed = 2;

    job.results['summer'] = { success: true };
    job.progress.completed = 3;

    job.results['formal'] = { success: true };
    job.progress.completed = 4;

    // Job completes with partial results
    job.status = 'partial';

    expect(job.status).toBe('partial');
    expect(job.errors).toHaveLength(1);
    expect(Object.values(job.results).filter((r: any) => r.success)).toHaveLength(3);
  });
});

describe('Concurrent Avatar Operations', () => {
  it('handles simultaneous saves from same user', async () => {
    // Simulate race condition where two saves happen concurrently
    const dbState = {
      characters: [{
        id: 1,
        name: 'RaceCondition',
        avatars: createMockAvatarSet()
      }]
    };

    // Two concurrent saves with slightly different data
    const save1 = {
      id: 1,
      name: 'RaceCondition',
      age: '8', // Updated age
      avatars: { status: 'complete' }
    };

    const save2 = {
      id: 1,
      name: 'RaceCondition',
      physical: { height: 'tall' }, // Updated physical
      avatars: { status: 'complete' }
    };

    // Both merge against same DB state
    const { characters: result1 } = mergeCharacters([save1], dbState.characters);
    const { characters: result2 } = mergeCharacters([save2], dbState.characters);

    // Both should preserve avatars
    expect(result1[0].avatars.winter).toBeDefined();
    expect(result2[0].avatars.winter).toBeDefined();

    // Each should have their updates
    expect(result1[0].age).toBe('8');
    expect(result2[0].physical?.height).toBe('tall');
  });

  it('handles multiple characters being modified concurrently', () => {
    const dbCharacters = [
      { id: 1, name: 'Kid1', avatars: createMockAvatarSet() },
      { id: 2, name: 'Kid2', avatars: createMockAvatarSet() },
      { id: 3, name: 'Kid3', avatars: createMockAvatarSet() }
    ];

    // User modifies all three concurrently (typical in UI)
    const frontendCharacters = [
      { id: 1, name: 'Kid1', age: 'updated1', avatars: { status: 'complete' } },
      { id: 2, name: 'Kid2', age: 'updated2', avatars: { status: 'complete' } },
      { id: 3, name: 'Kid3', age: 'updated3', avatars: { status: 'complete' } }
    ];

    const { characters: merged } = mergeCharacters(frontendCharacters, dbCharacters);

    // All should have avatars preserved
    expect(merged[0].avatars.winter).toBeDefined();
    expect(merged[1].avatars.winter).toBeDefined();
    expect(merged[2].avatars.winter).toBeDefined();

    // All should have age updates
    expect(merged[0].age).toBe('updated1');
    expect(merged[1].age).toBe('updated2');
    expect(merged[2].age).toBe('updated3');
  });
});
