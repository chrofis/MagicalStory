/**
 * Declared avatar overrides — ONE source for the trait/clothing corrections a
 * user made on a character.
 *
 * Both halves of the avatar loop need the same list:
 *   - the GENERATOR appends them to the avatar prompt ("Glasses: … ALWAYS
 *     visible", "NO beard"), so the rendered avatar deliberately differs from
 *     the reference photo;
 *   - the JUDGE (prompts/avatar-evaluation.txt) grades the avatar against that
 *     photo and, without the list, reads every deliberate difference as a
 *     defect — the glasses axis alone caps at 3, and since faceMatch.score is
 *     the MIN of the feature scores and finalScore the MIN of the checks, one
 *     capped axis sinks the avatar below MIN_BASE_AVATAR_SCORE and the retry
 *     regenerates with the SAME correction, to be rejected again.
 *
 * Same class of bug as resolveEvalSceneHint() (3b3070dce) and
 * resolveGeneratedOutfit() (e403345b1): the judge held a different spec than
 * the generator. Same shape of fix: one resolver, both sides read it.
 *
 * `hairDescription` is passed in rather than computed here so this module stays
 * free of prompt-builder imports (and testable on its own).
 */

function isSet(v) {
  return v != null && String(v).trim() !== '';
}

function isNone(v) {
  return String(v).trim().toLowerCase() === 'none';
}

/**
 * @param {object}  opts
 * @param {object=} opts.physicalTraits   user-edited traits (hairColor, eyeColor, build, …)
 * @param {object=} opts.clothing         user-specified clothing (fullBody | upperBody/lowerBody, shoes, accessories)
 * @param {string=} opts.hairDescription  pre-built hair sentence (buildHairDescription)
 * @param {string=} opts.category         avatar category; clothing is a declared override for 'standard' only,
 *                                        matching the generator, which appends the clothing section only there.
 * @returns {{traitLines: string[], clothingParts: string[], declaredFacts: string[], text: string|null}}
 *   traitLines/clothingParts keep the GENERATOR's existing wording;
 *   `text` is the neutral declaration block handed to the judge (null when nothing was declared).
 */
function resolveDeclaredAvatarOverrides({ physicalTraits = null, clothing = null, hairDescription = null, category = null } = {}) {
  const traitLines = [];
  const clothingParts = [];
  const declaredFacts = [];

  const t = physicalTraits && typeof physicalTraits === 'object' ? physicalTraits : null;
  if (t && Object.keys(t).length > 0) {
    if (isSet(t.hairColor)) { traitLines.push(`- Hair color: ${t.hairColor}`); declaredFacts.push(`Hair color: ${t.hairColor}`); }
    if (isSet(t.eyeColor)) { traitLines.push(`- Eye color: ${t.eyeColor}`); declaredFacts.push(`Eye color: ${t.eyeColor}`); }
    if (isSet(hairDescription)) { traitLines.push(`- Hair: ${hairDescription}`); declaredFacts.push(`Hair: ${hairDescription}`); }
    if (isSet(t.build)) { traitLines.push(`- Body build: ${t.build}`); declaredFacts.push(`Body build: ${t.build}`); }
    if (isSet(t.skinTone)) { traitLines.push(`- Skin tone: ${t.skinTone}`); declaredFacts.push(`Skin tone: ${t.skinTone}`); }
    if (isSet(t.face)) { traitLines.push(`- Face shape: ${t.face}`); declaredFacts.push(`Face shape: ${t.face}`); }
    if (isSet(t.facialHair)) {
      if (String(t.facialHair).trim().toLowerCase() === 'clean-shaven') {
        traitLines.push(`- Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face`);
        declaredFacts.push(`Facial hair: none — clean-shaven`);
      } else if (!isNone(t.facialHair)) {
        traitLines.push(`- Facial hair: ${t.facialHair}`);
        declaredFacts.push(`Facial hair: ${t.facialHair}`);
      }
    }
    if (isSet(t.glasses) && !isNone(t.glasses)) {
      traitLines.push(`- Glasses: ${t.glasses} — ALWAYS visible on the face`);
      declaredFacts.push(`Glasses: ${t.glasses} — worn on the face`);
    }
    if (isSet(t.other)) { traitLines.push(`- Other: ${t.other}`); declaredFacts.push(`Other: ${t.other}`); }
  }

  const c = clothing && typeof clothing === 'object' ? clothing : null;
  if (c) {
    if (isSet(c.fullBody)) {
      clothingParts.push(`Full outfit: ${c.fullBody}`);
    } else {
      if (isSet(c.upperBody)) clothingParts.push(`Top: ${c.upperBody}`);
      if (isSet(c.lowerBody)) clothingParts.push(`Bottom: ${c.lowerBody}`);
    }
    if (isSet(c.shoes)) clothingParts.push(`Shoes: ${c.shoes}`);
    if (isSet(c.accessories)) clothingParts.push(`Accessories: ${c.accessories}`);
  }

  // The generator appends the clothing section for the 'standard' category only
  // (winter/summer keep their seasonal styles), so the judge is only told about
  // clothing for that same category. A null category means "no category split".
  const clothingIsDeclared = clothingParts.length > 0 && (category == null || category === 'standard');
  const facts = clothingIsDeclared
    ? declaredFacts.concat(clothingParts.map(p => `Clothing — ${p}`))
    : declaredFacts;

  return {
    traitLines,
    clothingParts,
    declaredFacts: facts,
    text: facts.length > 0 ? facts.map(f => `- ${f}`).join('\n') : null,
  };
}

module.exports = { resolveDeclaredAvatarOverrides };
