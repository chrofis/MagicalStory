'use strict';

/**
 * The list fields of a trial character that `characters.metadata` mirrors from
 * `characters.data` (the lightweight copy the character list, the account claim
 * and the verification email read). ONE definition for the INSERT in
 * saveTrialCharacter and for the PATCH that syncs the wizard's later edits:
 * the PATCH only rewrote `data`, so the metadata kept the form as it stood when
 * the provisional account was created ("Stofftier " instead of
 * "Stofftier Elefant Eli", job_1791700480532_ul7f67gii; and the old name in the
 * verification email, which reads metadata).
 */
function trialCharacterListFields(character) {
  return {
    id: character.id,
    name: character.name,
    age: character.age,
    gender: character.gender,
    traits: character.traits,
    role: character.role,
  };
}

module.exports = { trialCharacterListFields };
