// email.js - Email utility module for MagicalStory

const { Resend } = require('resend');

// Initialize Resend client
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_FROM = process.env.EMAIL_FROM || 'MagicalStory <noreply@magicalstory.ch>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@magicalstory.ch';

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

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: userEmail,
      subject: `Your magical story "${storyTitle}" is ready!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #6366f1;">Your Story is Ready!</h1>
          <p>Hello ${userName},</p>
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
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">
            MagicalStory - Personalized AI-Generated Children's Books<br>
            <a href="https://www.magicalstory.ch">www.magicalstory.ch</a>
          </p>
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

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: userEmail,
      subject: 'We encountered an issue with your story',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #ef4444;">Story Generation Issue</h1>
          <p>Hello ${userName},</p>
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

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: customerEmail,
      subject: `Order Confirmed - Your MagicalStory Book is Being Printed!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #22c55e;">Order Confirmed!</h1>
          <p>Hello ${customerName},</p>
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
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">
            MagicalStory - Personalized AI-Generated Children's Books<br>
            <a href="https://www.magicalstory.ch">www.magicalstory.ch</a>
          </p>
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
            <li>Try to manually trigger the Gelato order</li>
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
