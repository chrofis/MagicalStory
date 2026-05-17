// email.js - Email utility module for MagicalStory

const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');
const { CREDIT_CONFIG } = require('./server/config/credits');

// Initialize Resend client
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || 'MagicalStory <noreply@magicalstory.ch>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'info@magicalstory.ch';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@magicalstory.ch';

// ===========================================
// ERROR HANDLING
// ===========================================

/**
 * Email error codes for distinguishing failure types
 */
const EmailErrorCode = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',    // RESEND_API_KEY not set
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  INVALID_EMAIL: 'INVALID_EMAIL',
  API_ERROR: 'API_ERROR',              // Resend API returned error
  SEND_FAILED: 'SEND_FAILED',          // Network/timeout error
  UNEXPECTED: 'UNEXPECTED'
};

/**
 * Create a structured email result object
 * @param {boolean} success - Whether the email was sent
 * @param {object} data - Email data (id, etc) on success
 * @param {object} error - Error details on failure
 */
function createEmailResult(success, data = null, error = null) {
  return { success, data, error };
}

/**
 * Create a structured error object
 * @param {string} code - Error code from EmailErrorCode
 * @param {string} message - Human-readable error message
 * @param {boolean} isRetryable - Whether the operation can be retried
 */
function createEmailError(code, message, isRetryable = false) {
  return { code, message, isRetryable };
}

/**
 * Validate email address format
 */
function validateEmailAddress(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

// ===========================================
// EMAIL TEMPLATES
// ===========================================

// Load email templates from emails/ folder
const EMAIL_TEMPLATES = {};

function loadEmailTemplates() {
  const emailsDir = path.join(__dirname, 'emails');
  const templateFiles = ['story-complete.html', 'trial-story-complete.html', 'trial-reminder.html', 'story-failed.html', 'order-confirmation.html', 'order-shipped.html', 'order-failed.html', 'email-verification.html', 'password-reset.html'];

  for (const file of templateFiles) {
    const filePath = path.join(emailsDir, file);
    try {
      if (fs.existsSync(filePath)) {
        const templateName = file.replace('.html', '');
        EMAIL_TEMPLATES[templateName] = fs.readFileSync(filePath, 'utf8');
      }
    } catch (err) {
      console.error(`❌ Failed to load email template ${file}:`, err.message);
    }
  }
  const count = Object.keys(EMAIL_TEMPLATES).length;
  if (count > 0) {
    console.log(`📧 Loaded ${count} email templates`);
  }
}

// Load templates on startup
loadEmailTemplates();

// Map language values to template markers
function normalizeLanguage(language) {
  if (!language) return 'ENGLISH';
  const lang = language.toUpperCase();
  // Match exact values and prefix-based language codes (de-ch, de-at, fr-ch, etc.)
  if (lang === 'GERMAN' || lang === 'DEUTSCH' || lang.startsWith('DE') || lang.startsWith('GSW')) return 'GERMAN';
  if (lang === 'FRENCH' || lang === 'FRANCAIS' || lang === 'FRANÇAIS' || lang.startsWith('FR')) return 'FRENCH';
  return 'ENGLISH';
}

// Parse a specific language section from template
function getTemplateSection(templateName, language) {
  const template = EMAIL_TEMPLATES[templateName];
  if (!template) {
    console.error(`❌ Email template not found: ${templateName}`);
    return null;
  }

  const langMarker = `[${normalizeLanguage(language)}]`;
  const languages = ['[ENGLISH]', '[GERMAN]', '[FRENCH]'];

  // Find the start of the requested language section
  const startIdx = template.indexOf(langMarker);
  if (startIdx === -1) {
    console.warn(`⚠️ Language ${language} not found in ${templateName}, falling back to English`);
    return getTemplateSection(templateName, 'English');
  }

  // Find the end (next language marker or end of file)
  let endIdx = template.length;
  for (const marker of languages) {
    if (marker === langMarker) continue;
    const idx = template.indexOf(marker, startIdx + langMarker.length);
    if (idx !== -1 && idx < endIdx) {
      endIdx = idx;
    }
  }

  const section = template.substring(startIdx + langMarker.length, endIdx).trim();

  // Parse subject, text, and html from section
  const subjectMatch = section.match(/^Subject:\s*(.+)$/m);
  const textMatch = section.match(/Text:\s*([\s\S]*?)(?=---\s*\nHtml:)/);
  const htmlMatch = section.match(/Html:\s*([\s\S]*?)$/);

  return {
    subject: subjectMatch ? subjectMatch[1].trim() : '',
    text: textMatch ? textMatch[1].trim() : '',
    html: htmlMatch ? htmlMatch[1].trim() : ''
  };
}

// Fill placeholders in template string
function fillTemplate(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
  }
  return result;
}

// Extract first name from full name for greeting
function getGreetingName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return 'there';
  }
  // Get the first word (first name) from the full name
  const firstName = fullName.trim().split(/\s+/)[0];
  return firstName || 'there';
}

// Check if email is configured
function isEmailConfigured() {
  return !!resend;
}

// ===========================================
// CUSTOMER EMAILS
// ===========================================

/**
 * Send story completion notification to customer
 * @param {string} userEmail - Customer email address
 * @param {string} firstName - Customer's first name (from shipping info or username)
 * @param {string} storyTitle - Title of the completed story
 * @param {string} storyId - ID of the story for direct link
 * @param {string} language - Language for email content (English, German, French)
 */
async function sendStoryCompleteEmail(userEmail, firstName, storyTitle, storyId, language = 'English', options = {}) {
  if (!resend) {
    console.log('📧 Email not configured - skipping story complete notification');
    return null;
  }

  // Use trial-specific template when a claim URL is provided (trial user flow)
  const templateName = options.claimUrl ? 'trial-story-complete' : 'story-complete';
  const template = getTemplateSection(templateName, language);
  if (!template) {
    console.error(`❌ Failed to get ${templateName} template`);
    return null;
  }

  // Point at the React reader route. The client handles auth: a logged-out
  // owner gets bounced to login with a return URL back here, same as the
  // editor's old behaviour. /shared/ skips the server-side /s/ handler that
  // gates on is_shared and sends non-authenticated recipients to the landing
  // page.
  //
  // Signed `?key=` is added so the /shared/<token> HTML handler can
  // recognise an email-link click and inject the R2 cover preload even
  // for private (owner-only) stories. The signature is only an HTML-paint
  // hint — actual story data still requires the owner's JWT. See
  // server/lib/shareLinkSig.js for the threat model.
  let storyUrl;
  if (options.shareToken) {
    storyUrl = `https://www.magicalstory.ch/shared/${options.shareToken}`;
    try {
      const { sign } = require('./server/lib/shareLinkSig');
      const key = sign(options.shareToken);
      if (key) storyUrl += `?key=${encodeURIComponent(key)}`;
    } catch (err) {
      console.warn('⚠️ [email] could not sign share link, falling back to bare URL:', err.message);
    }
  } else if (storyId) {
    storyUrl = `https://www.magicalstory.ch/create?storyId=${storyId}`;
  } else {
    storyUrl = 'https://www.magicalstory.ch';
  }

  // Fill in placeholders
  const values = {
    greeting: firstName || 'there',
    title: storyTitle,
    storyUrl: storyUrl,
    claimUrl: options.claimUrl || '',
    credits: String(CREDIT_CONFIG.LIMITS.INITIAL_USER)
  };

  try {
    const emailPayload = {
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    };

    // Attach PDF if provided (for trial story completion emails)
    if (options.pdfBuffer) {
      emailPayload.attachments = [{
        filename: options.pdfFilename || `${storyTitle || 'story'}.pdf`,
        content: options.pdfBuffer, // Resend accepts Buffer directly
      }];
      console.log(`📧 Attaching PDF to story complete email (${(options.pdfBuffer.length / 1024).toFixed(1)}KB)`);
    }

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error('❌ Failed to send story complete email:', error);
      return null;
    }

    console.log(`📧 Story complete email sent to ${userEmail} (${language}), id: ${data.id}${options.pdfBuffer ? ' [with PDF]' : ''}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Send story generation failure notification to customer
 * @param {string} userEmail - Customer email address
 * @param {string} firstName - Customer's first name
 * @param {string} language - Language for email content (English, German, French)
 */
async function sendStoryFailedEmail(userEmail, firstName, language = 'English') {
  if (!resend) {
    console.log('📧 Email not configured - skipping story failed notification');
    return null;
  }

  // Get template for the specified language
  const template = getTemplateSection('story-failed', language);
  if (!template) {
    console.error('❌ Failed to get story-failed template');
    return null;
  }

  // Fill in placeholders
  const values = {
    greeting: firstName || 'there'
  };

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    });

    if (error) {
      console.error('❌ Failed to send story failed email:', error);
      return null;
    }

    console.log(`📧 Story failed email sent to ${userEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Variant copy for the trial reminder email. Keyed first by reminderType
 * ('day5' | 'day25'), then by normalized language. Day-5 leads with the
 * value still on the table; day-25 leads with urgency.
 *
 * Swiss German: ss, never ß.
 */
const TRIAL_REMINDER_COPY = {
  day5: {
    ENGLISH: {
      subject: 'You still have {credits} free credits waiting',
      headline: 'Your {credits} free credits are still waiting.',
      body: 'You tried MagicalStory a few days ago — your free credits are still on your account, enough to create one more full story, completely free. Set your password to claim them.',
      ctaLabel: 'Claim my free story',
      perksIntro: 'With a full account you also unlock:',
    },
    GERMAN: {
      subject: 'Deine {credits} Gratis-Credits warten noch auf dich',
      headline: 'Deine {credits} Gratis-Credits warten noch.',
      body: 'Du hast MagicalStory vor ein paar Tagen ausprobiert — deine Gratis-Credits liegen weiterhin auf deinem Konto, genug für eine weitere komplette Geschichte, vollständig gratis. Setze dein Passwort, um sie zu sichern.',
      ctaLabel: 'Gratis-Geschichte holen',
      perksIntro: 'Mit einem vollständigen Konto erhältst du ausserdem:',
    },
    FRENCH: {
      subject: 'Vos {credits} crédits gratuits vous attendent toujours',
      headline: 'Vos {credits} crédits gratuits vous attendent toujours.',
      body: 'Vous avez essayé MagicalStory il y a quelques jours — vos crédits gratuits sont toujours sur votre compte, de quoi créer une histoire complète de plus, entièrement gratuite. Définissez votre mot de passe pour les réclamer.',
      ctaLabel: 'Réclamer mon histoire gratuite',
      perksIntro: 'Avec un compte complet, vous débloquez aussi :',
    },
  },
  day25: {
    ENGLISH: {
      subject: 'Your free credits expire in {daysLeft} days',
      headline: 'Last chance — your free credits expire in {daysLeft} days.',
      body: 'Your trial claim link is about to expire. Set your password now to keep your {credits} free credits and the story you already created. After {daysLeft} days the link disappears for good.',
      ctaLabel: 'Claim my account now',
      perksIntro: 'Once you claim, you also unlock:',
    },
    GERMAN: {
      subject: 'Deine Gratis-Credits laufen in {daysLeft} Tagen ab',
      headline: 'Letzte Chance — deine Gratis-Credits laufen in {daysLeft} Tagen ab.',
      body: 'Dein Aktivierungslink läuft bald ab. Setze jetzt dein Passwort, um deine {credits} Gratis-Credits und deine bereits erstellte Geschichte zu behalten. Nach {daysLeft} Tagen verschwindet der Link endgültig.',
      ctaLabel: 'Konto jetzt aktivieren',
      perksIntro: 'Sobald du aktivierst, erhältst du ausserdem:',
    },
    FRENCH: {
      subject: 'Vos crédits gratuits expirent dans {daysLeft} jours',
      headline: 'Dernière chance — vos crédits gratuits expirent dans {daysLeft} jours.',
      body: 'Votre lien d\'activation est sur le point d\'expirer. Définissez votre mot de passe maintenant pour garder vos {credits} crédits gratuits et l\'histoire que vous avez déjà créée. Après {daysLeft} jours, le lien disparaît pour de bon.',
      ctaLabel: 'Activer mon compte maintenant',
      perksIntro: 'Une fois votre compte activé, vous débloquez aussi :',
    },
  },
};

/**
 * Send a reminder email to an unclaimed trial account.
 *
 * @param {string} userEmail
 * @param {string} firstName
 * @param {string} claimUrl - Already-built /claim/<token> URL
 * @param {string} language - English | German | French (case-insensitive, prefix-tolerant)
 * @param {object} options
 * @param {('day5'|'day25')} options.reminderType - which reminder this is
 * @param {number} [options.daysLeft] - required for day25 (days until token expiry)
 * @param {Buffer} [options.pdfBuffer] - optional PDF attachment (we deliberately
 *   skip this for reminders; user already has it from the original email)
 * @param {string} [options.pdfFilename]
 */
async function sendTrialReminderEmail(userEmail, firstName, claimUrl, language = 'English', options = {}) {
  if (!resend) {
    console.log('📧 Email not configured - skipping trial reminder');
    return null;
  }
  if (!validateEmailAddress(userEmail)) {
    console.error('❌ [EMAIL] Invalid trial-reminder recipient:', userEmail);
    return null;
  }

  const reminderType = options.reminderType || 'day5';
  if (!TRIAL_REMINDER_COPY[reminderType]) {
    console.error(`❌ [EMAIL] Unknown trial reminderType: ${reminderType}`);
    return null;
  }

  const template = getTemplateSection('trial-reminder', language);
  if (!template) {
    console.error('❌ Failed to get trial-reminder template');
    return null;
  }

  const langKey = normalizeLanguage(language); // ENGLISH | GERMAN | FRENCH
  const copy = TRIAL_REMINDER_COPY[reminderType][langKey] || TRIAL_REMINDER_COPY[reminderType].ENGLISH;

  const credits = String(CREDIT_CONFIG.LIMITS.INITIAL_USER);
  const daysLeft = String(options.daysLeft != null ? options.daysLeft : 5);

  // Fill variant-specific strings first (they themselves contain {credits}/{daysLeft}),
  // then drop them into the outer template as flat fields.
  const variantValues = { credits, daysLeft };
  const subject = fillTemplate(copy.subject, variantValues);
  const headline = fillTemplate(copy.headline, variantValues);
  const body = fillTemplate(copy.body, variantValues);

  const values = {
    greeting: firstName || 'there',
    claimUrl,
    subject,
    headline,
    body,
    ctaLabel: copy.ctaLabel,
    perksIntro: copy.perksIntro,
    credits,
    daysLeft,
  };

  try {
    const emailPayload = {
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    };

    if (options.pdfBuffer) {
      emailPayload.attachments = [{
        filename: options.pdfFilename || 'story.pdf',
        content: options.pdfBuffer,
      }];
    }

    const { data, error } = await resend.emails.send(emailPayload);

    if (error) {
      console.error('❌ Failed to send trial reminder email:', error);
      return null;
    }

    console.log(`📧 Trial ${reminderType} reminder sent to ${userEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error (trial reminder):', err);
    return null;
  }
}

/**
 * Format delivery estimate based on language
 * @param {Date|string} minDate - Minimum delivery date
 * @param {Date|string} maxDate - Maximum delivery date
 * @param {string} language - Language for formatting
 * @returns {string} Formatted delivery estimate string
 */
function formatDeliveryEstimate(minDate, maxDate, language) {
  // Default fallbacks by language
  const defaults = {
    'English': '5-7 business days',
    'German': '5-7 Werktage',
    'French': '5-7 jours ouvrables'
  };

  if (!minDate && !maxDate) {
    return defaults[language] || defaults['English'];
  }

  // Locale mapping
  const locales = {
    'English': 'en-US',
    'German': 'de-DE',
    'French': 'fr-FR'
  };
  const locale = locales[language] || 'en-US';

  const formatOptions = { month: 'short', day: 'numeric' };

  try {
    const minDateObj = minDate ? new Date(minDate) : null;
    const maxDateObj = maxDate ? new Date(maxDate) : null;

    if (minDateObj && maxDateObj) {
      const minFormatted = minDateObj.toLocaleDateString(locale, formatOptions);
      const maxFormatted = maxDateObj.toLocaleDateString(locale, formatOptions);
      return `${minFormatted} - ${maxFormatted}`;
    } else if (minDateObj) {
      return minDateObj.toLocaleDateString(locale, formatOptions);
    } else if (maxDateObj) {
      const byLabel = { 'English': 'by', 'German': 'bis', 'French': 'avant le' };
      return `${byLabel[language] || 'by'} ${maxDateObj.toLocaleDateString(locale, formatOptions)}`;
    }
  } catch (e) {
    console.error('❌ Error formatting delivery estimate:', e);
  }

  return defaults[language] || defaults['English'];
}

/**
 * Send order confirmation email
 * @param {string} customerEmail - Customer email address
 * @param {string} customerName - Customer's full name
 * @param {object} orderDetails - Order details including orderId, amount, currency, shippingAddress, deliveryEstimateMin, deliveryEstimateMax
 * @param {string} language - Language for email content (English, German, French)
 */
async function sendOrderConfirmationEmail(customerEmail, customerName, orderDetails, language = 'English') {
  if (!resend) {
    console.log('📧 Email not configured - skipping order confirmation');
    return null;
  }

  // Get template for the specified language
  const template = getTemplateSection('order-confirmation', language);
  if (!template) {
    console.error('❌ Failed to get order-confirmation template');
    return null;
  }

  // Format delivery estimate
  const deliveryEstimate = formatDeliveryEstimate(
    orderDetails.deliveryEstimateMin,
    orderDetails.deliveryEstimateMax,
    language
  );

  // Fill in placeholders
  const values = {
    greeting: getGreetingName(customerName),
    orderId: orderDetails.orderId,
    amount: orderDetails.amount,
    currency: orderDetails.currency,
    addressLine1: orderDetails.shippingAddress?.line1 || '',
    city: orderDetails.shippingAddress?.city || '',
    postalCode: orderDetails.shippingAddress?.postal_code || '',
    country: orderDetails.shippingAddress?.country || '',
    deliveryEstimate: deliveryEstimate
  };

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    });

    if (error) {
      console.error('❌ Failed to send order confirmation email:', error);
      return null;
    }

    console.log(`📧 Order confirmation email sent to ${customerEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Send order shipped notification email
 * @param {string} customerEmail - Customer email address
 * @param {string} customerName - Customer's full name
 * @param {object} trackingDetails - Tracking info including orderId, trackingNumber, trackingUrl
 * @param {string} language - Language for email content (English, German, French)
 */
async function sendOrderShippedEmail(customerEmail, customerName, trackingDetails, language = 'English') {
  if (!resend) {
    console.log('📧 Email not configured - skipping order shipped notification');
    return null;
  }

  // Get template for the specified language
  const template = getTemplateSection('order-shipped', language);
  if (!template) {
    console.error('❌ Failed to get order-shipped template');
    return null;
  }

  // Fill in placeholders
  const values = {
    greeting: getGreetingName(customerName),
    orderId: trackingDetails.orderId || 'N/A',
    trackingNumber: trackingDetails.trackingNumber || 'N/A',
    trackingUrl: trackingDetails.trackingUrl || '#'
  };

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      bcc: 'magicalstory.ch+adf14de298@invite.trustpilot.com',
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    });

    if (error) {
      console.error('❌ Failed to send order shipped email:', error);
      return null;
    }

    console.log(`📧 Order shipped email sent to ${customerEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Send order failed notification to customer
 * @param {string} customerEmail - Customer email address
 * @param {string} customerName - Customer's full name
 * @param {string} errorMessage - Error description
 */
async function sendOrderFailedEmail(customerEmail, customerName, errorMessage, language = 'English') {
  if (!resend) {
    console.log('📧 Email not configured - skipping order failed notification');
    return null;
  }

  const template = getTemplateSection('order-failed', language);
  if (!template) {
    console.error('❌ Failed to get order-failed template');
    return null;
  }

  const values = {
    greeting: getGreetingName(customerName),
  };

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    });

    if (error) {
      console.error('❌ Failed to send order failed email:', error);
      return null;
    }

    console.log(`📧 Order failed email sent to ${customerEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

// ===========================================
// AUTHENTICATION EMAILS
// ===========================================

/**
 * Send email verification link
 * @param {string} userEmail - User's email address
 * @param {string} userName - User's name or username
 * @param {string} verifyUrl - Verification URL with token
 * @param {string} language - Language for email content (English, German, French)
 * @returns {object} { success: boolean, data?: object, error?: { code, message, isRetryable } }
 */
async function sendEmailVerificationEmail(userEmail, userName, verifyUrl, language = 'English') {
  console.log(`📧 [EMAIL] sendEmailVerificationEmail called for ${userEmail}`);

  // Validate email address
  if (!validateEmailAddress(userEmail)) {
    console.error('❌ [EMAIL] Invalid email address:', userEmail);
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.INVALID_EMAIL,
      'Invalid email address format',
      false
    ));
  }

  if (!resend) {
    console.error('❌ [EMAIL] Resend API key not configured - RESEND_API_KEY environment variable is missing');
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.NOT_CONFIGURED,
      'Email service not configured',
      false
    ));
  }

  // Get template for the specified language
  const template = getTemplateSection('email-verification', language);
  if (!template) {
    console.error('❌ [EMAIL] Failed to get email-verification template - template may not be loaded');
    console.error('   Available templates:', Object.keys(EMAIL_TEMPLATES));
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.TEMPLATE_NOT_FOUND,
      `Template 'email-verification' not found for ${language}`,
      false
    ));
  }

  console.log(`📧 [EMAIL] Template loaded for ${language}, sending to ${userEmail}...`);

  // Fill in placeholders
  const values = {
    verifyUrl: verifyUrl
  };

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    });

    if (error) {
      console.error('❌ Failed to send email verification email:', error);
      return createEmailResult(false, null, createEmailError(
        EmailErrorCode.API_ERROR,
        error.message || 'Resend API error',
        true // API errors are often retryable
      ));
    }

    console.log(`📧 Email verification sent to ${userEmail} (${language}), id: ${data.id}`);
    return createEmailResult(true, data, null);
  } catch (err) {
    console.error('❌ Email send error:', err);
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.SEND_FAILED,
      err.message || 'Failed to send email',
      true // Network errors are often retryable
    ));
  }
}

/**
 * Send password reset link
 * @param {string} userEmail - User's email address
 * @param {string} userName - User's name or username
 * @param {string} resetUrl - Password reset URL with token
 * @param {string} language - Language for email content (English, German, French)
 * @returns {object} { success: boolean, data?: object, error?: { code, message, isRetryable } }
 */
async function sendPasswordResetEmail(userEmail, userName, resetUrl, language = 'English') {
  // Validate email address
  if (!validateEmailAddress(userEmail)) {
    console.error('❌ [EMAIL] Invalid email address:', userEmail);
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.INVALID_EMAIL,
      'Invalid email address format',
      false
    ));
  }

  if (!resend) {
    console.log('📧 Email not configured - skipping password reset email');
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.NOT_CONFIGURED,
      'Email service not configured',
      false
    ));
  }

  // Get template for the specified language
  const template = getTemplateSection('password-reset', language);
  if (!template) {
    console.error('❌ Failed to get password-reset template');
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.TEMPLATE_NOT_FOUND,
      `Template 'password-reset' not found for ${language}`,
      false
    ));
  }

  // Fill in placeholders
  const values = {
    resetUrl: resetUrl
  };

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: fillTemplate(template.subject, values),
      text: fillTemplate(template.text, values),
      html: fillTemplate(template.html, values),
    });

    if (error) {
      console.error('❌ Failed to send password reset email:', error);
      return createEmailResult(false, null, createEmailError(
        EmailErrorCode.API_ERROR,
        error.message || 'Resend API error',
        true
      ));
    }

    console.log(`📧 Password reset email sent to ${userEmail} (${language}), id: ${data.id}`);
    return createEmailResult(true, data, null);
  } catch (err) {
    console.error('❌ Email send error:', err);
    return createEmailResult(false, null, createEmailError(
      EmailErrorCode.SEND_FAILED,
      err.message || 'Failed to send email',
      true
    ));
  }
}

// ===========================================
// ADMIN EMAILS
// ===========================================

/**
 * Send admin alert for story generation failure
 */
async function sendAdminStoryFailureAlert(jobId, userId, userName, userEmail, errorMessage) {
  if (!resend) {
    console.log('📧 Email not configured - skipping admin alert');
    return null;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: ADMIN_EMAIL,
      subject: `[MagicalStory] Story Generation Failed - Job ${jobId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #ef4444;">Story Generation Failed</h1>

          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; border-left: 4px solid #ef4444;">
            <p><strong>Job ID:</strong> ${jobId}</p>
            <p><strong>User ID:</strong> ${userId}</p>
            <p><strong>Username:</strong> ${userName}</p>
            <p><strong>User Email:</strong> ${userEmail}</p>
            <p><strong>Time:</strong> ${new Date().toISOString()}</p>
          </div>

          <h3>Error Message:</h3>
          <pre style="background: #1f2937; color: #f3f4f6; padding: 15px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap;">${errorMessage}</pre>

          <p>
            <a href="https://www.magicalstory.ch/admin"
               style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              View Admin Dashboard
            </a>
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send admin alert:', error);
      return null;
    }

    console.log(`📧 Admin alert sent for job ${jobId}, email id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * CRITICAL: Send admin alert when payment succeeded but book order failed
 */
async function sendAdminOrderFailureAlert(sessionId, customerEmail, customerName, errorMessage) {
  if (!resend) {
    console.log('📧 Email not configured - skipping critical admin alert');
    return null;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: ADMIN_EMAIL,
      subject: `[CRITICAL] Book Order Failed After Payment - ${sessionId.slice(-8)}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">CRITICAL: Payment Received But Order Failed</h1>

          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; border: 2px solid #dc2626;">
            <p><strong>Customer has paid but their book was NOT ordered!</strong></p>
            <p>Immediate action required: Either manually process the order or issue a refund.</p>
          </div>

          <h3>Details:</h3>
          <ul>
            <li><strong>Stripe Session:</strong> ${sessionId}</li>
            <li><strong>Customer:</strong> ${customerName}</li>
            <li><strong>Email:</strong> ${customerEmail}</li>
            <li><strong>Time:</strong> ${new Date().toISOString()}</li>
          </ul>

          <h3>Error:</h3>
          <pre style="background: #1f2937; color: #f3f4f6; padding: 15px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap;">${errorMessage}</pre>

          <h3>Action Required:</h3>
          <ol>
            <li>Check the order in the admin dashboard</li>
            <li>Try to manually trigger the print order</li>
            <li>If not possible, contact customer and issue refund via Stripe</li>
          </ol>

          <p>
            <a href="https://dashboard.stripe.com/payments"
               style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-right: 10px;">
              Stripe Dashboard
            </a>
            <a href="https://www.magicalstory.ch/admin"
               style="display: inline-block; background: #374151; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Admin Dashboard
            </a>
          </p>
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send critical admin alert:', error);
      return null;
    }

    console.log(`📧 CRITICAL admin alert sent for session ${sessionId}, email id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

// Export all functions
module.exports = {
  // Error handling utilities
  EmailErrorCode,
  createEmailResult,
  createEmailError,
  validateEmailAddress,
  // Config check
  isEmailConfigured,
  // Customer emails
  sendStoryCompleteEmail,
  sendStoryFailedEmail,
  sendTrialReminderEmail,
  sendOrderConfirmationEmail,
  sendOrderShippedEmail,
  sendOrderFailedEmail,
  // Auth emails (return structured results)
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
  // Admin emails
  sendAdminStoryFailureAlert,
  sendAdminOrderFailureAlert,
};
