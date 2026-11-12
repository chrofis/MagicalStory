// Yes/no switch + description for free-text character traits (glasses, "other" marks).
// The switch, not the typed words, decides "none": code never reads prose
// (docs/decisions.md 2026-11-12 "glasses/other are a yes/no switch"). 'none' is the
// canonical stored sentinel that the photo analyzer also writes and every server
// reader (avatarOverrides.isNone, styledAvatars, avatars.js, promptBuilders) understands.
export const TRAIT_NONE = 'none';

/** Generic description stored when the user answers "yes" to glasses but types nothing. */
export const GLASSES_YES_DEFAULT = 'glasses';

/** Switch state for a stored value: 'none' / empty -> no; any other text -> yes. */
export function traitSwitchIsYes(stored: string | undefined | null): boolean {
  const v = (stored ?? '').trim();
  return v !== '' && v.toLowerCase() !== TRAIT_NONE;
}

/** The text box content for a stored value ('' while the switch says no). */
export function traitSwitchText(stored: string | undefined | null): string {
  return traitSwitchIsYes(stored) ? (stored as string) : '';
}

/**
 * The value to store for a switch position + description.
 * no  -> 'none'. yes + text -> the text. yes + empty -> `emptyYes` (glasses must still
 * state glasses; for "other" there is nothing to state, so '' = absent).
 */
export function traitSwitchValue(yes: boolean, text: string, emptyYes: string = ''): string {
  if (!yes) return TRAIT_NONE;
  const t = text.trim();
  return t !== '' ? text : emptyYes;
}
