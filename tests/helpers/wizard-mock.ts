/**
 * Hermetic wizard harness for the free Playwright specs: no backend, no database, no paid call.
 * Every /api request is answered here; one that is not listed fails the test loudly.
 * POST /api/jobs/create-story is intercepted and its payload captured instead of starting a job.
 */
import type { Page, Route } from '@playwright/test';

/** A JWT-shaped token that expires far in the future (the client only decodes the payload). */
function fakeJwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: 'e2e-user', exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 })}.sig`;
}

export interface MockCharacter {
  id: number;
  name: string;
  age: string;
  gender: 'male' | 'female';
  storyRole?: 'main' | 'in' | 'out';
}

export const DEFAULT_CAST: MockCharacter[] = [
  { id: 1001, name: 'Lio', age: '8', gender: 'male', storyRole: 'main' },
  { id: 1002, name: 'Noam', age: '3', gender: 'male', storyRole: 'in' },
  { id: 1003, name: 'Mama', age: '38', gender: 'female', storyRole: 'in' },
];

const IDEAS = [
  'Idea one: a lantern that glows only when somebody tells the truth, and the children follow its light home.',
  'Idea two: a small boat that carries a message across a wide lake, with a storm that must be waited out.',
];

/** The two idea cards carry different worlds and shapes, so a payload shows WHICH card was picked. */
export const IDEA_WORLDS = [
  { world: 'fantasy', theme: 'pirate' },
  { world: 'location', location: { city: 'Basel' } },
];
export const IDEA_SHAPES = [{ id: 3, name: 'Quest' }, { id: 5, name: 'Mystery' }];
export { IDEAS };

export interface WizardMock {
  /** Payloads of POST /api/jobs/create-story, in order. */
  createStoryRequests: any[];
  /** Bodies of POST /api/analyze-own-story, in order. */
  ownStoryRequests: any[];
  /** Bodies of POST /api/generate-story-ideas(-stream). */
  ideaRequests: any[];
  /** Queue the next own-story answer. */
  setOwnStoryAnswer(answer: { present: Record<string, boolean>; missing: string[]; unsuitable: boolean; tooManyEvents: boolean }): void;
  unmocked: string[];
}

export async function installWizardMock(page: Page, cast: MockCharacter[] = DEFAULT_CAST): Promise<WizardMock> {
  const mock: WizardMock = {
    createStoryRequests: [], ownStoryRequests: [], ideaRequests: [], unmocked: [],
    setOwnStoryAnswer(a) { ownAnswer = a; },
  };
  let ownAnswer = { present: { WHO: true, WHERE: false, PROBLEM: false, WANT: true, ENDING: false }, missing: ['WHERE', 'PROBLEM', 'ENDING'], unsuitable: false, tooManyEvents: false };
  const user = { id: 'e2e-user', username: 'e2e', email: 'e2e@example.invalid', role: 'user', credits: 1000, emailVerified: true, photoConsentAt: '2026-01-01T00:00:00Z' };
  const token = fakeJwt();

  await page.addInitScript(([tok, u]) => {
    try {
      localStorage.setItem('auth_token', tok as string);
      localStorage.setItem('current_user', JSON.stringify(u));
      localStorage.setItem('language', 'en');
      localStorage.setItem('ui_language', 'en');
    } catch { /* ignore */ }
  }, [token, user]);

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    const body = () => { try { return req.postDataJSON(); } catch { return {}; } };

    if (p === '/api/auth/me') return json(route, { user });
    if (p === '/api/auth/refresh') return json(route, { token, user });
    if (p === '/api/characters' && method === 'GET') {
      return json(route, {
        characters: cast.map(c => ({
          id: c.id, name: c.name, age: c.age, gender: c.gender, storyRole: c.storyRole,
          traits: { strengths: [], flaws: [], challenges: [] },
          avatars: { status: 'complete' },
        })),
        relationships: { '1001-1002': 'siblings', '1002-1001': 'siblings' },
        relationshipTexts: { '1001-1002': 'Lio carries Noam when he is tired' },
        customRelationships: [],
        customStrengths: [], customWeaknesses: [], customFears: [],
      });
    }
    if (p === '/api/characters' && method !== 'GET') return json(route, { success: true });
    if (p === '/api/jobs/create-story') {
      mock.createStoryRequests.push(body());
      return json(route, { jobId: 'job_e2e_fake', status: 'pending' });
    }
    if (p.startsWith('/api/jobs/')) return json(route, { status: 'pending', progress: 0 });
    if (p === '/api/analyze-own-story') {
      mock.ownStoryRequests.push(body());
      return json(route, { ...ownAnswer, costUsd: 0 });
    }
    if (p === '/api/generate-story-ideas') {
      mock.ideaRequests.push(body());
      return json(route, { storyIdeas: IDEAS, storyIdea: IDEAS[0], ideaWorlds: IDEA_WORLDS });
    }
    if (p === '/api/generate-story-ideas-stream') {
      mock.ideaRequests.push(body());
      const events = [
        { status: 'generating', prompt: 'e2e prompt', model: 'e2e-model' },
        { ideaWorlds: IDEA_WORLDS },
        { premiseShapes: IDEA_SHAPES },
        { story1: IDEAS[0] },
        { story2: IDEAS[1] },
        { done: true, fullResponse: 'e2e' },
      ];
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
      });
    }
    if (p === '/api/user/verify-location') {
      return json(route, { verified: true, city: 'Baden', country: 'Switzerland', plz: '5400', displayName: 'Baden, Aargau, Switzerland', lat: 47.4733, lon: 8.3064 });
    }
    if (p.startsWith('/api/user/') && method !== 'GET') return json(route, { success: true });
    if (p === '/api/analyzer-presence') return json(route, { ok: true });
    if (p === '/api/stories' && method === 'GET') return json(route, { stories: [], total: 0 });
    if (p === '/api/characters/thumbnails') return json(route, { thumbnails: {} });
    if (p === '/api/prepare-idea-landmarks') return json(route, { ok: true }, 202);
    // Harmless reads the app makes on load
    if (/^\/api\/(user|users)\/(location|quota|credits)/.test(p) || p === '/api/health/config') return json(route, {});
    mock.unmocked.push(`${method} ${p}`);
    return json(route, { error: `unmocked in e2e: ${method} ${p}` }, 501);
  });

  return mock;
}
