import { describe, it, expect } from 'vitest';
const { TRIAL_COSTUMES } = require('../../server/config/trialCostumes');

// Historical trial costumes name a colour per garment, as the adventure block does:
// a colourless garment lets the head row and the body row of an avatar sheet, and
// every page, pick different colours for the same outfit.
const COLOUR = /\b(red|blue|green|yellow|white|black|brown|grey|gray|silver|gold|golden|pink|purple|navy|khaki|olive|tan|beige|cream|orange|burgundy|plum|teal|mustard|buff|rose|lilac|dusty|colou?rful|colorful)\b/i;
const GARMENT = /\b(tunic|dress|coat|jacket|suit|trousers|breeches|boots|shoes|skirt|blouse|kilt|robe|apron|cloak|cap|hat|helmet|shirt|sweater|leggings|waistcoat|gambeson|vest|shawl|scarf|sandals|sneakers|jumpsuit|overalls|anorak|bonnet|kerchief|cravat|tie|mail|surcoat|collar|sash|stockings|mukluks|mittens|puttees|spacesuit|scrubs|slacks|jeans|polo|gloves|bodice|stola|chiton|peplos|wreath|headwrap|armband)\b/i;

describe('historical trial costumes carry a colour on every garment', () => {
  for (const [topic, genders] of Object.entries<any>(TRIAL_COSTUMES.historical)) {
    for (const g of ['male', 'female']) {
      it(`${topic}/${g}`, () => {
        const text: string = genders[g];
        const parts = text.split(',').map(p => p.trim());
        const colourless = parts.filter(p => GARMENT.test(p) && !COLOUR.test(p));
        expect(colourless, `${topic}/${g} garments without a colour: ${colourless.join(' | ')}`).toEqual([]);
      });
    }
  }
});
