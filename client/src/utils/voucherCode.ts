/** Voucher codes are typed or pasted by hand: ignore case, spaces and stray dashes. Server validates the result. */
export function normalizeVoucherCode(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // MS + 4 groups of 5 = 22 chars: put the dashes back so the code matches the printed form.
  if (compact.length === 22 && compact.startsWith('MS')) {
    return `MS-${compact.slice(2, 7)}-${compact.slice(7, 12)}-${compact.slice(12, 17)}-${compact.slice(17, 22)}`;
  }
  return input.trim().toUpperCase();
}
