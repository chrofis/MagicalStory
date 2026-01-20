# Email Messaging Setup Guide for MagicalStory

## Overview

This guide covers how to implement email notifications for customers and admins in your MagicalStory application deployed on Railway.

---

## 1. Email Service Options

### Recommended: **Resend** (Best for Railway)
- **Why**: Modern API, excellent developer experience, generous free tier
- **Free Tier**: 3,000 emails/month, 100 emails/day
- **Pricing**: $20/month for 50,000 emails
- **Integration**: Simple REST API or Node.js SDK
- **Website**: https://resend.com

### Alternative Options

| Service | Free Tier | Pros | Cons |
|---------|-----------|------|------|
| **SendGrid** | 100 emails/day forever | Industry standard, reliable | Complex setup, owned by Twilio |
| **Postmark** | 100 emails/month | Fast delivery, great for transactional | Small free tier |
| **AWS SES** | 62,000/month (from EC2) | Cheapest at scale ($0.10/1000) | Complex IAM setup |
| **Mailgun** | 5,000/month for 3 months | Good API | Free tier expires |
| **Brevo (Sendinblue)** | 300 emails/day | Marketing + transactional | Lower sending limits |

### NOT Recommended
- **Gmail SMTP**: Rate limited, will get blocked
- **Self-hosted SMTP**: Deliverability issues, spam filters

---

## 2. Where to Set Up Email

### Email Service Provider (External to Railway)
You'll create an account with an email provider like Resend or SendGrid. This is **separate from Railway** - Railway hosts your app, the email provider sends emails.

### Railway Configuration
You'll add API keys to Railway as environment variables. The email sending code runs in your Node.js server on Railway.

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   Your App      │      │  Email Service  │      │   Customer      │
│   (Railway)     │─────▶│  (Resend/etc)   │─────▶│   Inbox         │
└─────────────────┘      └─────────────────┘      └─────────────────┘
     server.js            External API            Gmail/Outlook/etc
```

---

## 3. Setup Instructions (Using Resend)

### Step 1: Create Resend Account
1. Go to https://resend.com
2. Sign up with GitHub or email
3. Verify your email address

### Step 2: Add Your Domain
1. In Resend dashboard, go to **Domains**
2. Click **Add Domain**
3. Enter: `magicalstory.ch`
4. Add the DNS records Resend provides to your domain registrar (IONOS):
   - **SPF Record** (TXT): Authorizes Resend to send on your behalf
   - **DKIM Record** (TXT): Cryptographic signature for authenticity
   - **Optional DMARC** (TXT): Policy for failed authentication

Example DNS records to add at IONOS:
```
Type: TXT
Name: @
Value: v=spf1 include:resend.com ~all

Type: TXT
Name: resend._domainkey
Value: [provided by Resend]

Type: TXT
Name: _dmarc
Value: v=DMARC1; p=none;
```

5. Wait for verification (usually 5-30 minutes)

### Step 3: Get API Key
1. In Resend, go to **API Keys**
2. Click **Create API Key**
3. Name it: `magicalstory-production`
4. Copy the key (starts with `re_`)

### Step 4: Add to Railway
1. Go to Railway dashboard → MagicalStory project
2. Click on your service → **Variables**
3. Add new variable:
   ```
   RESEND_API_KEY=re_xxxxxxxxxxxx
   EMAIL_FROM=MagicalStory <noreply@magicalstory.ch>
   ADMIN_EMAIL=roger@youremail.com
   ```
4. Railway will auto-redeploy

### Step 5: Install Resend SDK
```bash
npm install resend
```

Update `package.json` dependencies.

---

## 4. Email Triggers & Use Cases

### Customer Emails

| Trigger | When | Priority |
|---------|------|----------|
| **Story Complete** | `story_jobs.status` → `completed` | High |
| **Story Failed** | `story_jobs.status` → `failed` | High |
| **Order Confirmed** | Stripe `checkout.session.completed` | High |
| **Book Shipped** | Gelato webhook (shipment update) | Medium |
| **Welcome Email** | User registration | Low |
| **Password Reset** | User requests reset | Medium |

### Admin Emails

| Trigger | When | Priority |
|---------|------|----------|
| **Story Generation Failed** | Any `story_jobs` failure | High |
| **Book Order Failed** | Payment succeeded but Gelato failed | Critical |
| **Payment Failed** | Stripe payment failure | Medium |
| **Low API Credits** | Claude/Gemini errors | Medium |
| **Daily Summary** | Cron job (optional) | Low |

---

## 5. Implementation Code

### Create Email Utility Module

Create a new file `email.js` in your project root:

```javascript
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
      subject: `Your magical story "${storyTitle}" is ready! ✨`,
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
async function sendStoryFailedEmail(userEmail, userName, errorMessage) {
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
      subject: `Order Confirmed - Your MagicalStory Book is Being Printed! 📚`,
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
async function sendAdminStoryFailureAlert(jobId, userId, userName, errorMessage) {
  if (!resend) {
    console.log('📧 Email not configured - skipping admin alert');
    return null;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: ADMIN_EMAIL,
      subject: `⚠️ Story Generation Failed - Job ${jobId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #ef4444;">⚠️ Story Generation Failed</h1>

          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; border-left: 4px solid #ef4444;">
            <p><strong>Job ID:</strong> ${jobId}</p>
            <p><strong>User ID:</strong> ${userId}</p>
            <p><strong>Username:</strong> ${userName}</p>
            <p><strong>Time:</strong> ${new Date().toISOString()}</p>
          </div>

          <h3>Error Message:</h3>
          <pre style="background: #1f2937; color: #f3f4f6; padding: 15px; border-radius: 8px; overflow-x: auto;">${errorMessage}</pre>

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
      subject: `🚨 CRITICAL: Book Order Failed After Payment - ${sessionId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #dc2626;">🚨 CRITICAL: Payment Received But Order Failed</h1>

          <div style="background: #fef2f2; padding: 20px; border-radius: 8px; border: 2px solid #dc2626;">
            <p><strong>⚠️ Customer has paid but their book was NOT ordered!</strong></p>
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
          <pre style="background: #1f2937; color: #f3f4f6; padding: 15px; border-radius: 8px; overflow-x: auto;">${errorMessage}</pre>

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
```

---

## 6. Integration Points in server.js

### 6.1 Story Generation Complete/Failed

Find the `processStoryJob` function (around line 4435) and add email notifications:

```javascript
// At the top of server.js, add:
const email = require('./email');

// In processStoryJob, after successful completion (around line 4430):
// After: await dbPool.query(`UPDATE story_jobs SET status = $1, result_data = $2...`)

// Add this block:
if (email.isEmailConfigured()) {
  // Get user email
  const userResult = await dbPool.query('SELECT email, username FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length > 0) {
    const user = userResult.rows[0];
    const storyTitle = inputData.storyTitle || 'Your Story';
    await email.sendStoryCompleteEmail(user.email, user.username, storyTitle);
  }
}

// In the catch block (around line 4440), after marking job as failed:
// After: await dbPool.query(`UPDATE story_jobs SET status = $1, error_message = $2...`)

// Add this block:
if (email.isEmailConfigured()) {
  // Notify admin
  const userResult = await dbPool.query('SELECT email, username FROM users WHERE id = $1', [userId]);
  const userName = userResult.rows[0]?.username || 'Unknown';
  await email.sendAdminStoryFailureAlert(jobId, userId, userName, error.message);

  // Notify customer
  if (userResult.rows[0]?.email) {
    await email.sendStoryFailedEmail(userResult.rows[0].email, userName, error.message);
  }
}
```

### 6.2 Order Confirmation After Stripe Payment

In the Stripe webhook handler (around line 285), after successful order creation:

```javascript
// After the order is inserted into the database and before processBookOrder:

if (email.isEmailConfigured()) {
  await email.sendOrderConfirmationEmail(
    customer_email,
    customer_name,
    {
      orderId: session.id.slice(-8).toUpperCase(),
      amount: (session.amount_total / 100).toFixed(2),
      currency: session.currency.toUpperCase(),
      shippingAddress: shipping_address
    }
  );
}
```

### 6.3 Book Order Failure Alert

In `processBookOrder` catch block (around line 3905):

```javascript
// After: await dbPool.query(`UPDATE orders SET payment_status = 'failed'...`)

if (email.isEmailConfigured()) {
  await email.sendAdminOrderFailureAlert(
    sessionId,
    customerInfo.email,
    customerInfo.name,
    error.message
  );
}
```

---

## 7. Environment Variables Summary

Add these to Railway:

```env
# Email Configuration (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=MagicalStory <noreply@magicalstory.ch>
ADMIN_EMAIL=your-email@example.com
```

---

## 8. Testing Checklist

### Before Going Live
- [ ] Resend account created
- [ ] Domain `magicalstory.ch` added and verified in Resend
- [ ] DNS records (SPF, DKIM) added at IONOS
- [ ] API key added to Railway environment variables
- [ ] `npm install resend` added to package.json
- [ ] `email.js` module created
- [ ] Integration code added to server.js

### Test Emails
1. **Test story completion**: Create a test story and verify email arrives
2. **Test story failure**: Temporarily break something to trigger failure email
3. **Test order confirmation**: Make a test Stripe payment
4. **Check spam folder**: Ensure emails don't land in spam

### Monitoring
- Resend dashboard shows sent/delivered/bounced stats
- Check Railway logs for email send confirmations
- Monitor bounce rates and adjust if needed

---

## 9. Cost Estimate

| Scenario | Monthly Emails | Cost |
|----------|----------------|------|
| 100 stories/month | ~200 (customer + admin) | Free |
| 500 stories/month | ~1,000 | Free |
| 1,000 stories/month | ~2,000 | Free |
| 2,000+ stories/month | ~4,000+ | $20/month |

Resend free tier (3,000/month) should cover most early-stage usage.

---

## 10. Future Enhancements

### Phase 2 (Optional)
- [ ] Shipping notification when Gelato ships (requires Gelato webhook)
- [ ] Password reset emails
- [ ] Welcome email on registration
- [ ] Weekly digest for admins

### Phase 3 (Optional)
- [ ] Email templates in separate HTML files
- [ ] Multi-language email support (DE, FR, EN)
- [ ] Unsubscribe links for marketing emails
- [ ] Email preference settings for users

---

## Quick Start Summary

1. **Sign up** at https://resend.com
2. **Add domain** `magicalstory.ch` and verify DNS
3. **Get API key** from Resend dashboard
4. **Add to Railway**: `RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_EMAIL`
5. **Install**: `npm install resend`
6. **Create**: `email.js` (copy from section 5)
7. **Integrate**: Add email calls to server.js (section 6)
8. **Deploy**: Push to Railway
9. **Test**: Trigger a story generation and check your inbox

---

## Support Resources

- Resend Documentation: https://resend.com/docs
- Resend Node.js SDK: https://resend.com/docs/sdks/nodejs
- Railway Environment Variables: https://docs.railway.app/develop/variables
- IONOS DNS Management: https://www.ionos.com/help/domains/dns-settings/
