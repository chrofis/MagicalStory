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

/**
 * Experiment 1274 — the SAME configuration re-run after the idea-generator fixes
 * (11cc173db, rotating want-axes). A human reads these five LOCAL draws as five
 * different wants (give a carrot away / hand a chestnut up / bring the frog
 * along / carry a jar safely / put a lost acorn back) and the five FANTASY draws
 * likewise. It is the real-world negative control: same child, same town, same
 * landmarks as 1273, but genuinely varied premises. The grouping must NOT call
 * these repeats — which it did until the constant inputs (name, town, landmark)
 * were excluded from the skeleton.
 */
const EXP_1274_LOCAL = [
  "Der kleine Omar in Fislisbach findet an einem windigen Herbsttag einen hungrigen Igel bei der Kirche Rohrdorf und möchte ihm ein Rüebli schenken, aber das Tier versteckt sich jedes Mal tiefer im Laub.",
  "Der kleine Omar in Fislisbach möchte einem Eichhörnchen vor der Kirche Rohrdorf eine Kastanie hinaufreichen, die oben in einer Astgabel liegt. Er versucht es dreimal — mit den Händen, dann mit einem Stock — bis er bemerkt, dass das Tier selbst hinunterklettern kann, wenn er die Kastanie einfach ruhig hält.",
  "Der kleine Omar möchte seinen Frosch Flecky zur Kirche Rohrdorf mitnehmen, aber Flecky sitzt tief in einem nassen Herbstloch im Garten in Fislisbach. Omar versucht dreimal, ihn herauszuholen, bis er bemerkt, dass Flecky auf ein Blatt springt.",
  "Omar trägt ein Glas mit bunten Herbstblättern zur Kirche Rohrdorf, als Geschenk für eine alte Frau. In Fislisbach stolpert er dreimal – doch beim dritten Mal bemerkt er, dass er das Glas mit beiden Händen halten muss.",
  "Omar, ein kleiner Bub aus Fislisbach, findet im herbstlichen Wald ein Eichhörnchen, das seine gesammelte Eichel verloren hat. Er versucht zweimal, die Eichel zurückzubringen, doch erst als er bemerkt, dass sie ins Moos gerollt ist, gelingt es ihm.",
];

const EXP_1274_FANTASY = [
  "Der kleine Omar findet im Herbstlaub ein buntes Ei, das einem Vogelkind gehört, und möchte es zurückbringen. Ein anderer Bub hilft ihm, das Nest hoch oben im goldenen Baum zu erreichen.",
  "Omar und sein Holzbär müssen dem kleinen Eichhörnchen helfen, seine Eicheln in den hohlen Baum zu tragen, bevor der Herbstwind sie alle wegbläst. Der Weg ist zu schmal für Omars Hände, doch zusammen mit dem Holzbär findet er einen Weg.",
  "Omar möchte aus bunten Herbstblättern ein Bild für ein kleines Eichhörnchen basteln, das traurig wirkt. Als der Wind die Blätter immer wieder wegbläst, hilft ihm ein anderer Bub, die Blätter festzuhalten.",
  "Der kleine Omar möchte seinem Freund Schneck, einer bunten Schnecke, ein warmes Herbstblatt als Geschenk bringen, damit Schneck sich nicht mehr kalt fühlt. Dreimal weht der Wind das Blatt davon, aber Omar gibt nicht auf.",
  "Omar möchte unbedingt den goldenen Herbstbaum auf dem Hügel erreichen, aber der Weg ist zu steil und er traut sich nicht allein. Ein anderer Bub nimmt seine Hand, und zusammen schaffen sie es nach oben.",
];

/** Words this experiment holds constant — the child, the town, the landmarks. */
const OMAR_CONSTANTS = ['omar', 'fislisbach', 'kirche', 'rohrdorf', 'stadt'];

const asIdeas = (texts: string[]) => texts.map((text, i) => ({ draw: i + 1, text }));

const CONST = { constantWords: OMAR_CONSTANTS };

describe('groupIdeasByPremise — experiment 1273 ground truth (converged)', () => {
  for (const [arm, texts] of [['local', EXP_1273_LOCAL], ['fantasy', EXP_1273_FANTASY]] as const) {
    it(`reports the ${arm} arm as one dominant premise, not five subjects`, () => {
      const groups = groupIdeasByPremise(asIdeas(texts as string[]), CONST);
      // The human read is 5/5 one premise. The metric is lexical, so the
      // contract pinned here is the one it can actually honour: a dominant
      // group covering at least four of the five draws. The old Jaccard
      // grouping reported five groups of one on exactly this input.
      expect(groups[0].size).toBeGreaterThanOrEqual(4);
      const repeatCount = groups.filter((g: any) => g.size > 1).reduce((n: number, g: any) => n + g.size, 0);
      expect(repeatCount).toBeGreaterThanOrEqual(4);

      // The recurring frame must be reported, and must name the repeated action.
      expect(groups[0].premiseWords.length).toBeGreaterThanOrEqual(4);
      expect(groups[0].premiseWords).toContain('versucht');
      // Constants the experiment holds fixed are never premise evidence.
      for (const c of OMAR_CONSTANTS) expect(groups[0].premiseWords).not.toContain(c);
    });
  }
});

describe('groupIdeasByPremise — experiment 1274 (same config, varied premises)', () => {
  for (const [arm, texts] of [['local', EXP_1274_LOCAL], ['fantasy', EXP_1274_FANTASY]] as const) {
    it(`does NOT collapse the ${arm} arm into one premise`, () => {
      const groups = groupIdeasByPremise(asIdeas(texts as string[]), CONST);
      // At most a PAIR may group. In the local arm draws 2 and 5 do — both are
      // a squirrel, a nut, and "tries, then notices"; that is the closest pair
      // in the arm and reporting it is defensible. What must not happen is the
      // 1273 outcome of one group of five.
      expect(groups.length).toBeGreaterThanOrEqual(4);
      expect(Math.max(...groups.map((g: any) => g.size))).toBeLessThanOrEqual(2);
    });
  }

  it('the constant inputs alone must never be enough to form a premise', () => {
    // Without the exclusion the shared name/town/landmark carried the skeleton
    // and this arm was reported as one repeated premise. Guard the regression.
    const withConstants = groupIdeasByPremise(asIdeas(EXP_1274_LOCAL), {});
    const withoutConstants = groupIdeasByPremise(asIdeas(EXP_1274_LOCAL), CONST);
    expect(withoutConstants.length).toBeGreaterThan(withConstants.length);
  });
});

describe('groupIdeasByPremise — guards against calling everything a repeat', () => {
  it('leaves five unrelated premises as five groups of one', () => {
    const groups = groupIdeasByPremise(asIdeas(DIVERSE), CONST);
    expect(groups).toHaveLength(5);
    expect(groups.every((g: any) => g.size === 1)).toBe(true);
    // A group of one has no shared frame to report.
    expect(groups.every((g: any) => g.premiseWords.length === 0 && g.wordsInAllMembers.length === 0)).toBe(true);
  });

  it('splits a mixed set into the repeated premise plus the outliers', () => {
    const groups = groupIdeasByPremise(asIdeas([...EXP_1273_FANTASY, ...DIVERSE.slice(0, 2)]), CONST);
    expect(groups[0].size).toBeGreaterThanOrEqual(4);
    expect(groups[0].members.every((m: any) => m.draw <= 5)).toBe(true);
    expect(groups.filter((g: any) => g.size === 1).length).toBeGreaterThanOrEqual(2);
  });

  it('two ideas alone are not a repeat just because they are the only two', () => {
    const groups = groupIdeasByPremise(asIdeas([DIVERSE[0], DIVERSE[2]]), CONST);
    expect(groups).toHaveLength(2);
  });
});

describe('ideaPremiseSkeleton', () => {
  it('drops the words the experiment holds constant', () => {
    const sigs = EXP_1273_LOCAL.map(t => [...ideaSubjectWords(t)]);
    expect(ideaPremiseSkeleton(sigs, 0.6, [])).toContain('omar');
    const skeleton = ideaPremiseSkeleton(sigs, 0.6, OMAR_CONSTANTS);
    expect(skeleton).not.toContain('omar');
    expect(skeleton).not.toContain('fislisbach');
    // ...but keeps the premise slots.
    for (const word of ['versucht', 'dreimal', 'bemerkt']) expect(skeleton).toContain(word);
  });
});

describe('wordsInAllMembers is a true intersection', () => {
  it('lists only words EVERY member contains, never the union', () => {
    const groups = groupIdeasByPremise(asIdeas(EXP_1273_FANTASY), CONST);
    const shared: string[] = groups[0].wordsInAllMembers;
    expect(shared.length).toBeGreaterThan(0);
    const members: string[] = groups[0].members.map((m: any) => m.text);
    for (const word of shared) {
      for (const text of members) {
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
