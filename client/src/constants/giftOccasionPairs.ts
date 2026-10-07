import { giftPages } from './giftData';
import { occasions } from './occasionData';

/**
 * Gift page ↔ occasion page pairs that share one subject (the Taufgeschenk page
 * and the Taufe page are two angles on the same event). Each side links the
 * other so a reader - and a crawler - can cross from "what to give" to "why a
 * story for this day" without going back through a hub. Only pairs whose
 * subject is the same word are listed; a gift page without an occasion twin
 * (fuer-enkel, geschenk-5-jahre) and an occasion without a gift twin (advent,
 * umzug) link nothing. tests/unit/gift-occasion-pairs.test.ts holds every id
 * to the two data files.
 */
export const GIFT_OCCASION_PAIRS: ReadonlyArray<readonly [giftId: string, occasionId: string]> = [
  ['geburtstagsgeschenk', 'geburtstag'],
  ['weihnachtsgeschenk', 'weihnachten'],
  ['ostergeschenk', 'ostern'],
  ['taufgeschenk', 'taufe'],
  ['einschulungsgeschenk', 'einschulung'],
  ['nikolausgeschenk', 'nikolaus'],
];

export function occasionForGift(giftId: string) {
  const pair = GIFT_OCCASION_PAIRS.find(([g]) => g === giftId);
  return pair ? occasions.find((o) => o.id === pair[1]) || null : null;
}

export function giftForOccasion(occasionId: string) {
  const pair = GIFT_OCCASION_PAIRS.find(([, o]) => o === occasionId);
  return pair ? giftPages.find((g) => g.id === pair[0]) || null : null;
}
