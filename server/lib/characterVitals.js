/**
 * Age, height and gender as the character save accepts them (docs/decisions.md 2026-11-13).
 *
 * Age 0 is a real age ("under 1 year"): "0" is not "missing". Height is whole centimetres 40-250:
 * a height typed "1.10" (metres) was stored and later read as 1 cm, so a non-integer or a value
 * outside the range is refused, never converted and never guessed as metres. Mirror of
 * client/src/utils/characterVitals.ts (the form's fast feedback); the server is the authority.
 */
const HEIGHT_MIN_CM = 40;
const HEIGHT_MAX_CM = 250;
const AGE_MAX = 120;

const blank = v => v === undefined || v === null || String(v).trim() === '';

function heightProblem(raw) {
  if (blank(raw)) return null;
  const s = String(raw).trim();
  if (!/^\d{1,3}$/.test(s)) return 'CHARACTER_HEIGHT_INVALID';
  const n = Number(s);
  return n < HEIGHT_MIN_CM || n > HEIGHT_MAX_CM ? 'CHARACTER_HEIGHT_INVALID' : null;
}

function ageProblem(raw) {
  if (blank(raw)) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 && n <= AGE_MAX ? null : 'CHARACTER_AGE_INVALID';
}

// The values the form offers: the customer picks male or female (owner, 2026-11-13: "Customer must choose
// gender"; there is no third choice). A draft saved before the pick may have none yet; the form will not save
// a finished character without one. Stored production rows hold only male 136, female 128, empty 8 (counted
// 2026-11-13), so no legacy value needs to pass.
const GENDERS = ['male', 'female'];

function genderProblem(raw) {
  if (blank(raw)) return null;
  return typeof raw === 'string' && GENDERS.includes(raw) ? null : 'CHARACTER_GENDER_INVALID';
}

const storedHeight = c => c?.physical?.height ?? c?.height;

/**
 * The first age/height problem among the characters being saved, or null. A value equal to what is
 * already stored for that character passes: legacy rows hold words ("average") that the number
 * field shows empty and sends back unchanged, and a customer must still be able to save them.
 * @param {Object[]} characters  incoming characters
 * @param {Object[]} existing    the stored characters (matched by id)
 * @returns {{code:string, characterId:*, name:string}|null}
 */
function findVitalsProblem(characters, existing = []) {
  for (const c of characters || []) {
    if (!c || typeof c !== 'object') continue;
    const old = (existing || []).find(e => e && String(e.id) === String(c.id));
    const checks = [
      [ageProblem(c.age), c.age, old?.age],
      [heightProblem(storedHeight(c)), storedHeight(c), storedHeight(old)],
    ];
    // Gender has no legacy values to forgive: refused outright, whatever is stored.
    const genderCode = genderProblem(c.gender);
    if (genderCode) return { code: genderCode, characterId: c.id, name: c.name || '' };
    for (const [code, value, oldValue] of checks) {
      if (code && String(value ?? '').trim() !== String(oldValue ?? '').trim()) {
        return { code, characterId: c.id, name: c.name || '' };
      }
    }
  }
  return null;
}

module.exports = { HEIGHT_MIN_CM, HEIGHT_MAX_CM, AGE_MAX, GENDERS, heightProblem, ageProblem, genderProblem, findVitalsProblem };
