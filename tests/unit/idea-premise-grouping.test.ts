import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { groupIdeasByPremise, ideaPremiseSkeleton, ideaSubjectWords } = require('../../server/lib/testlab.js');

/**
 * GROUND TRUTH — Test Lab experiment 1273 (trial_idea_variety, staging,
 * 2026-09-14): 5 draws of the same idea pair for Omar, 3, male, Fislisbach, de,
 * adventure. A human read all five draws of EACH arm as one premise: a small
 * woodland animal is stuck behind an obstacle, the child tries three times, and
 * on the third try realises he can shift the obstacle from the side.
 *
 * The Jaccard-over-raw-words grouping this replaced reported
 * `distinctSubjects: 5, repeatCount: 0` for both arms — anti-correlated with the
 * truth. These are generated test ideas, not user content, so they are embedded
 * verbatim as the fixture.
 */
const EXP_1273_LOCAL = [
  'Der kleine Omar findet in Fislisbach einen Igel, der unter einem Haufen nasser Herbstblätter steckt und nicht herauskommt. Er versucht die Blätter wegzuschieben, dann wegzublasen – beides klappt nicht. Dann sieht er, dass eine einzelne Wurzel den Igel festhält, hebt sie weg, und der Igel ist frei.',
  'Omar sieht beim Herbstmarkt in Fislisbach, wie ein kleines Eichhörnchen nicht an seine Eichel herankommt, die unter einer schweren, nassen Laubhaufen-Schicht begraben liegt. Er versucht dreimal zu helfen, bis er bemerkt, dass er das Laub von der Seite her wegschieben kann.',
  'Omar versucht dreimal, einem kleinen Igel in Fislisbach ein Blatt aus dem Herbstwind-Ast zu befreien — zuerst mit den Händen, dann mit einem Stock. Beim dritten Versuch bemerkt er, dass der Ast auf der anderen Seite leicht ist, und hebt ihn dort hoch. Der Igel kann weiterlaufen.',
  'Omar sieht in Fislisbach, nahe der Kirche Rohrdorf, wie ein kleines Eichhörnchen nicht an seine Haselnüsse herankommt, weil ein grosser Stein davor liegt. Er versucht dreimal, dem Eichhörnchen zu helfen, und beim dritten Mal bemerkt er, dass er den Stein von der Seite schieben kann.',
  'Omar sieht in Fislisbach einen kleinen Igel, der unter einem bunten Herbstblätterhaufen steckt und nicht herauskommt. Er versucht es dreimal — und beim dritten Mal bemerkt er, dass er zuerst die Blätter von der Seite wegräumen muss.',
];

const EXP_1273_FANTASY = [
  'Ein kleines Eichhörnchen steckt fest in einem hohlen Herbstbaum, und Omar versucht dreimal, es herauszubekommen, bis er bemerkt, dass er von der anderen Seite helfen kann.',
  'Ein kleines Eichhörnchen steckt mit seinem Eichelkorb in einem hohen Astloch fest, kurz bevor der Herbstwind alle Blätter davonweht. Omar versucht dreimal, den Korb zu befreien, bis er bemerkt, dass er zuerst die herunterhängenden Blätter wegräumen muss.',
  'Ein kleiner Eichhörnchen-Freund sitzt hoch oben in einem Herbstbaum und kann seinen Vorrat an Nüssen nicht hinunterbringen, weil der Ast zu glitschig ist. Omar versucht dreimal, ihm zu helfen — und beim dritten Mal bemerkt er, dass er zuerst die nassen Blätter wegräumen muss.',
  'Ein kleines Eichhörnchen ist in einem hohlen Herbstbaum eingesperrt, weil eine grosse Eichel die Öffnung versperrt. Omar versucht dreimal, ihm zu helfen, bis er bemerkt, dass er die Eichel von unten wegstossen kann.',
  'Ein kleines Eichhörnchen steckt in einem hohlen Baumstamm fest, weil eine schwere Kastanie den Ausgang versperrt. Omar versucht dreimal, ihm zu helfen, bis er bemerkt, dass er die Kastanie von der Seite wegrollen kann.',
];

/** Five deliberately unrelated premises — the negative control. */
const DIVERSE = [
  'Omar entdeckt im Hallenbad von Fislisbach, dass seine Schwimmflügel ein Loch haben, und muss dem Bademeister erklären, was passiert ist, bevor er wieder ins Wasser darf.',
  'Beim Znüni im Kindergarten vertauscht jemand die Brotdosen, und Omar sucht mit seiner Freundin Lina das ganze Gebäude ab, bis der Hauswart die richtige Dose im Estrich findet.',
  'Ein Zug bleibt am Bahnhof stehen, weil eine Katze auf dem Perrondach sitzt; Omar überredet den Kondukteur, eine Leiter zu holen.',
  'Omar baut aus Kartonschachteln eine Rakete für die Fasnacht, doch der Regen weicht sie auf, und die Nachbarin näht ihm aus alten Vorhängen eine neue Verkleidung.',
  'Im Museum drückt Omar aus Versehen einen Knopf, worauf alle Lichter ausgehen und er der Aufseherin im Dunkeln hilft, den Sicherungskasten zu finden.',
];

const asIdeas = (texts: string[]) => texts.map((text, i) => ({ draw: i + 1, text }));

describe('groupIdeasByPremise — experiment 1273 ground truth', () => {
  for (const [arm, texts] of [['local', EXP_1273_LOCAL], ['fantasy', EXP_1273_FANTASY]] as const) {
    it(`reports all five ${arm} draws as ONE premise`, () => {
      const groups = groupIdeasByPremise(asIdeas(texts as string[]));
      expect(groups).toHaveLength(1);
      expect(groups[0].size).toBe(5);
      expect(groups[0].members.map((m: any) => m.draw).sort()).toEqual([1, 2, 3, 4, 5]);

      // The recurring frame must be reported, and must name the repeated action.
      expect(groups[0].premiseWords.length).toBeGreaterThanOrEqual(4);
      expect(groups[0].premiseWords).toContain('versucht');
    });
  }

  it('the skeleton of the local arm carries the premise slots', () => {
    const sigs = EXP_1273_LOCAL.map(t => [...ideaSubjectWords(t)]);
    const skeleton = ideaPremiseSkeleton(sigs);
    for (const word of ['omar', 'versucht', 'fislisbach']) expect(skeleton).toContain(word);
  });
});

describe('groupIdeasByPremise — guards against calling everything a repeat', () => {
  it('leaves five unrelated premises as five groups of one', () => {
    const groups = groupIdeasByPremise(asIdeas(DIVERSE));
    expect(groups).toHaveLength(5);
    expect(groups.every((g: any) => g.size === 1)).toBe(true);
    // A group of one has no shared frame to report.
    expect(groups.every((g: any) => g.premiseWords.length === 0 && g.wordsInAllMembers.length === 0)).toBe(true);
  });

  it('splits a mixed set into the repeated premise plus the outliers', () => {
    const groups = groupIdeasByPremise(asIdeas([...EXP_1273_FANTASY, ...DIVERSE.slice(0, 2)]));
    expect(groups[0].size).toBe(5);
    expect(groups[0].members.map((m: any) => m.draw).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(groups.filter((g: any) => g.size === 1)).toHaveLength(2);
  });

  it('two ideas alone are not a repeat just because they are the only two', () => {
    const groups = groupIdeasByPremise(asIdeas([DIVERSE[0], DIVERSE[2]]));
    expect(groups).toHaveLength(2);
  });
});

describe('wordsInAllMembers is a true intersection', () => {
  it('lists only words EVERY member contains, never the union', () => {
    const groups = groupIdeasByPremise(asIdeas(EXP_1273_FANTASY));
    const shared: string[] = groups[0].wordsInAllMembers;
    expect(shared.length).toBeGreaterThan(0);
    for (const word of shared) {
      for (const text of EXP_1273_FANTASY) {
        const sig = [...ideaSubjectWords(text)] as string[];
        const present = sig.some(w => w === word || (w.length >= 5 && word.length >= 5 && (w.includes(word) || word.includes(w))));
        expect(present, `"${word}" missing from: ${text.slice(0, 60)}`).toBe(true);
      }
    }
    // Words unique to one draw must NOT appear (the old union bug's signature).
    expect(shared).not.toContain('kastanie');
    expect(shared).not.toContain('eichelkorb');
  });
});
