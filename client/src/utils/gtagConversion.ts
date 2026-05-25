// Google Ads conversion-event helpers.
//
// Two events defined in the MagicalStory Google Ads account:
//   1. Page view conversion        — fires on /try landing (low intent, high volume)
//   2. Trial Email Submitted       — fires when user submits email on TrialGenerationPage
//                                    (high intent, qualified lead — primary for PMax bidding)
//
// The global gtag.js loader is already in client/index.html.

declare global {
  interface Window {
    gtag?: (command: string, ...args: unknown[]) => void;
  }
}

const SEND_TO_PAGE_VIEW = 'AW-17995593741/cDfDCJTFs4McEI3w-4RD';
const SEND_TO_EMAIL_LEAD = 'AW-17995593741/oCLQCMLTt7McEI3w-4RD';

function fireConversion(sendTo: string, value: number, currency = 'CHF') {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
  window.gtag('event', 'conversion', { send_to: sendTo, value, currency });
}

export function trackTrialPageVisit() {
  fireConversion(SEND_TO_PAGE_VIEW, 1.0);
}

export function trackEmailLead() {
  fireConversion(SEND_TO_EMAIL_LEAD, 5.0);
}
