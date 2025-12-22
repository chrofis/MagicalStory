// email.js - Email utility module for MagicalStory

const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');

// Initialize Resend client
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || 'MagicalStory <noreply@magicalstory.ch>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'info@magicalstory.ch';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@magicalstory.ch';

// ===========================================
// EMAIL TEMPLATES
// ===========================================

// Load email templates from emails/ folder
const EMAIL_TEMPLATES = {};

function loadEmailTemplates() {
  const emailsDir = path.join(__dirname, 'emails');
  const templateFiles = ['story-complete.html', 'story-failed.html', 'order-confirmation.html', 'order-shipped.html', 'email-verification.html', 'password-reset.html'];

  for (const file of templateFiles) {
    const filePath = path.join(emailsDir, file);
    try {
      if (fs.existsSync(filePath)) {
        const templateName = file.replace('.html', '');
        EMAIL_TEMPLATES[templateName] = fs.readFileSync(filePath, 'utf8');
        console.log(`📧 Loaded email template: ${templateName}`);
      }
    } catch (err) {
      console.error(`❌ Failed to load email template ${file}:`, err.message);
    }
  }
}

// Load templates on startup
loadEmailTemplates();

// Map language values to template markers
function normalizeLanguage(language) {
  if (!language) return 'ENGLISH';
  const lang = language.toUpperCase();
  if (lang === 'GERMAN' || lang === 'DE' || lang === 'DEUTSCH') return 'GERMAN';
  if (lang === 'FRENCH' || lang === 'FR' || lang === 'FRANCAIS' || lang === 'FRANÇAIS') return 'FRENCH';
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
async function sendStoryCompleteEmail(userEmail, firstName, storyTitle, storyId, language = 'English') {
  if (!resend) {
    console.log('📧 Email not configured - skipping story complete notification');
    return null;
  }

  // Get template for the specified language
  const template = getTemplateSection('story-complete', language);
  if (!template) {
    console.error('❌ Failed to get story-complete template');
    return null;
  }

  // Build direct story URL (uses /create?storyId= format)
  const storyUrl = storyId
    ? `https://www.magicalstory.ch/create?storyId=${storyId}`
    : 'https://www.magicalstory.ch';

  // Fill in placeholders
  const values = {
    greeting: firstName || 'there',
    title: storyTitle,
    storyUrl: storyUrl
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
      console.error('❌ Failed to send story complete email:', error);
      return null;
    }

    console.log(`📧 Story complete email sent to ${userEmail} (${language}), id: ${data.id}`);
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
 * Send order confirmation email
 * @param {string} customerEmail - Customer email address
 * @param {string} customerName - Customer's full name
 * @param {object} orderDetails - Order details including orderId, amount, currency, shippingAddress
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

  // Fill in placeholders
  const values = {
    greeting: getGreetingName(customerName),
    orderId: orderDetails.orderId,
    amount: orderDetails.amount,
    currency: orderDetails.currency,
    addressLine1: orderDetails.shippingAddress?.line1 || '',
    city: orderDetails.shippingAddress?.city || '',
    postalCode: orderDetails.shippingAddress?.postal_code || '',
    country: orderDetails.shippingAddress?.country || ''
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

// ===========================================
// AUTHENTICATION EMAILS
// ===========================================

/**
 * Send email verification link
 * @param {string} userEmail - User's email address
 * @param {string} userName - User's name or username
 * @param {string} verifyUrl - Verification URL with token
 * @param {string} language - Language for email content (English, German, French)
 */
async function sendEmailVerificationEmail(userEmail, userName, verifyUrl, language = 'English') {
  console.log(`📧 [EMAIL] sendEmailVerificationEmail called for ${userEmail}`);

  if (!resend) {
    console.error('❌ [EMAIL] Resend API key not configured - RESEND_API_KEY environment variable is missing');
    return null;
  }

  // Get template for the specified language
  const template = getTemplateSection('email-verification', language);
  if (!template) {
    console.error('❌ [EMAIL] Failed to get email-verification template - template may not be loaded');
    console.error('   Available templates:', Object.keys(EMAIL_TEMPLATES));
    return null;
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
      return null;
    }

    console.log(`📧 Email verification sent to ${userEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Send password reset link
 * @param {string} userEmail - User's email address
 * @param {string} userName - User's name or username
 * @param {string} resetUrl - Password reset URL with token
 * @param {string} language - Language for email content (English, German, French)
 */
async function sendPasswordResetEmail(userEmail, userName, resetUrl, language = 'English') {
  if (!resend) {
    console.log('📧 Email not configured - skipping password reset email');
    return null;
  }

  // Get template for the specified language
  const template = getTemplateSection('password-reset', language);
  if (!template) {
    console.error('❌ Failed to get password-reset template');
    return null;
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
      return null;
    }

    console.log(`📧 Password reset email sent to ${userEmail} (${language}), id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
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
  isEmailConfigured,
  sendStoryCompleteEmail,
  sendStoryFailedEmail,
  sendOrderConfirmationEmail,
  sendOrderShippedEmail,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
  sendAdminStoryFailureAlert,
  sendAdminOrderFailureAlert,
};
