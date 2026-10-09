import { describe, it, expect } from 'vitest';
const { storeSlides } = require('../../server/lib/avatarSlides.js');

/** Regression, user 880b53c1: the stored slide list held one cell at two positions because positional R2 keys were overwritten
 *  by the next slide list written (body row, costumed sheet, finished sheet). */
describe('storeSlides', () => {
  const fake = () => { const puts: Record<string, string> = {}; return { puts, upload: async (data: string, key: string) => { puts[key] = data; return `https://r2.test/${key}`; } }; };
  it('different cells never share an object, whatever list they are written in', async () => {
    const r = fake();
    const a = await storeSlides('c', 'u', ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'], r.upload);
    const b = await storeSlides('c', 'u', ['data:image/jpeg;base64,CCC', 'data:image/jpeg;base64,AAA'], r.upload);
    expect(new Set([...a, ...b]).size).toBe(3);
    expect(b[1]).toBe(a[0]);
    for (const [key, data] of Object.entries(r.puts)) expect(data.length).toBeGreaterThan(0) && expect(key).toMatch(/\/slides\/slide-[0-9a-f]{24}\.jpg$/);
    expect(Object.keys(r.puts)).toHaveLength(3);
  });
  it('a failed upload throws instead of storing a hole', async () => {
    await expect(storeSlides('c', 'u', ['data:image/jpeg;base64,AAA'], async () => null)).rejects.toThrow(/could not be stored/);
  });
});
