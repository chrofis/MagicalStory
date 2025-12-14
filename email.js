// email.js - Email utility module for MagicalStory

const { Resend } = require('resend');

// Initialize Resend client
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || 'MagicalStory <noreply@magicalstory.ch>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || 'info@magicalstory.ch';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@magicalstory.ch';

// Common footer for all customer emails
const EMAIL_FOOTER = `
  <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
  <p style="color: #666; font-size: 12px;">
    MagicalStory - Personalized AI-Generated Children's Books<br>
    <a href="https://www.magicalstory.ch">www.magicalstory.ch</a><br><br>
    Questions? Reply to this email or contact us at <a href="mailto:info@magicalstory.ch">info@magicalstory.ch</a><br>
    MagicalStory, Switzerland
  </p>
`;

/**
 * Get a proper greeting name from userName
 * Prefers first name, falls back to username, avoids using email addresses
 */
function getGreetingName(userName) {
  if (!userName) return 'there';

  // If it looks like an email address, don't use it
  if (userName.includes('@')) {
    // Try to extract name from email (e.g., "john.doe@..." -> "John")
    const localPart = userName.split('@')[0];
    // If local part is reasonable (letters only, not too long), capitalize and use it
    if (/^[a-zA-Z]+$/.test(localPart) && localPart.length <= 20) {
      return localPart.charAt(0).toUpperCase() + localPart.slice(1).toLowerCase();
    }
    return 'there';
  }

  // Use first word if it's a full name
  const firstName = userName.split(' ')[0];
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
 */
async function sendStoryCompleteEmail(userEmail, userName, storyTitle) {
  if (!resend) {
    console.log('📧 Email not configured - skipping story complete notification');
    return null;
  }

  const greeting = getGreetingName(userName);

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: `Your magical story "${storyTitle}" is ready!`,
      text: `Hello ${greeting},\n\nGreat news! Your personalized story "${storyTitle}" has been created and is waiting for you.\n\nVisit https://www.magicalstory.ch to view your story.\n\nYou can now:\n- Preview your complete story with illustrations\n- Order a printed hardcover book\n- Download as PDF\n\nThank you for using MagicalStory!\n\n--\nMagicalStory - Personalized AI-Generated Children's Books\nwww.magicalstory.ch`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6366f1;">Your Story is Ready!</h1>
          <p>Hello ${greeting},</p>
          <p>Great news! Your personalized story <strong>"${storyTitle}"</strong> has been created and is waiting for you.</p>
          <p>
            <a href="https://www.magicalstory.ch"
               style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              View Your Story
            </a>
          </p>
          <p>You can now:</p>
          <ul>
            <li>Preview your complete story with illustrations</li>
            <li>Order a printed hardcover book</li>
            <li>Download as PDF</li>
          </ul>
          <p>Thank you for using MagicalStory!</p>
          ${EMAIL_FOOTER}
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send story complete email:', error);
      return null;
    }

    console.log(`📧 Story complete email sent to ${userEmail}, id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Send story generation failure notification to customer
 */
async function sendStoryFailedEmail(userEmail, userName) {
  if (!resend) {
    console.log('📧 Email not configured - skipping story failed notification');
    return null;
  }

  const greeting = getGreetingName(userName);

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: userEmail,
      subject: 'We encountered an issue with your story',
      text: `Hello ${greeting},\n\nWe're sorry, but we encountered a problem while creating your story.\n\nOur team has been notified and is looking into this. You can try creating your story again at https://www.magicalstory.ch, or contact us if the problem persists.\n\nWe apologize for any inconvenience.\n\nBest regards,\nThe MagicalStory Team\n\n--\nMagicalStory - Personalized AI-Generated Children's Books\nwww.magicalstory.ch`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #ef4444;">Story Generation Issue</h1>
          <p>Hello ${greeting},</p>
          <p>We're sorry, but we encountered a problem while creating your story.</p>
          <p>Our team has been notified and is looking into this. You can try creating your story again, or contact us if the problem persists.</p>
          <p>
            <a href="https://www.magicalstory.ch"
               style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">
              Try Again
            </a>
          </p>
          <p>We apologize for any inconvenience.</p>
          <p>Best regards,<br>The MagicalStory Team</p>
          ${EMAIL_FOOTER}
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send story failed email:', error);
      return null;
    }

    console.log(`📧 Story failed email sent to ${userEmail}, id: ${data.id}`);
    return data;
  } catch (err) {
    console.error('❌ Email send error:', err);
    return null;
  }
}

/**
 * Send order confirmation email
 */
async function sendOrderConfirmationEmail(customerEmail, customerName, orderDetails) {
  if (!resend) {
    console.log('📧 Email not configured - skipping order confirmation');
    return null;
  }

  const greeting = getGreetingName(customerName);

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      subject: `Order Confirmed - Your MagicalStory Book is Being Printed!`,
      text: `Hello ${greeting},\n\nThank you for your order! Your personalized storybook is now being printed.\n\nOrder Details:\n- Order ID: ${orderDetails.orderId}\n- Amount: ${orderDetails.amount} ${orderDetails.currency}\n- Shipping to: ${orderDetails.shippingAddress.line1}, ${orderDetails.shippingAddress.city}, ${orderDetails.shippingAddress.postal_code}, ${orderDetails.shippingAddress.country}\n\nYou'll receive another email when your book ships with tracking information.\nEstimated delivery: 5-10 business days\n\nThank you for choosing MagicalStory!\n\n--\nMagicalStory - Personalized AI-Generated Children's Books\nwww.magicalstory.ch`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #22c55e;">Order Confirmed!</h1>
          <p>Hello ${greeting},</p>
          <p>Thank you for your order! Your personalized storybook is now being printed.</p>

          <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Order Details</h3>
            <p><strong>Order ID:</strong> ${orderDetails.orderId}</p>
            <p><strong>Amount:</strong> ${orderDetails.amount} ${orderDetails.currency}</p>
            <p><strong>Shipping to:</strong><br>
              ${orderDetails.shippingAddress.line1}<br>
              ${orderDetails.shippingAddress.city}, ${orderDetails.shippingAddress.postal_code}<br>
              ${orderDetails.shippingAddress.country}
            </p>
          </div>

          <p>You'll receive another email when your book ships with tracking information.</p>
          <p>Estimated delivery: 5-10 business days</p>

          <p>Thank you for choosing MagicalStory!</p>
          ${EMAIL_FOOTER}
        </div>
      `,
    });

    if (error) {
      console.error('❌ Failed to send order confirmation email:', error);
      return null;
    }

    console.log(`📧 Order confirmation email sent to ${customerEmail}, id: ${data.id}`);
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
  sendAdminStoryFailureAlert,
  sendAdminOrderFailureAlert,
};
