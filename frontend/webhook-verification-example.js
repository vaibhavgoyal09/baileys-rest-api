/**
 * Webhook Signature Verification Example
 *
 * This file demonstrates how to verify webhook signatures sent by the Baileys REST API.
 * Copy this code to your webhook endpoint to ensure webhook authenticity.
 */

const crypto = require('crypto');

/**
 * Verify webhook signature
 * @param {string} payload - The raw request body as string
 * @param {string} signature - The signature from X-Signature header (format: "sha256=...")
 * @param {string} secret - Your webhook secret from the API
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(payload, signature, secret) {
  try {
    // Extract the signature from header (format: "sha256=signature")
    const [algorithm, receivedSignature] = signature.split('=');

    if (algorithm !== 'sha256') {
      console.log('Invalid algorithm:', algorithm);
      return false;
    }

    if (!receivedSignature) {
      console.log('No signature provided');
      return false;
    }

    // Compute expected signature
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    // Use timing-safe comparison to prevent timing attacks
    const isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex')
    );

    console.log('Signature verification:', isValid ? 'VALID' : 'INVALID');
    return isValid;
  } catch (error) {
    console.error('Error verifying webhook signature:', error.message);
    return false;
  }
}

// Express.js example
const express = require('express');
const app = express();

// Your webhook secret - get this from /api/auth/webhooks/:id/secret
const WEBHOOK_SECRET = 'your_webhook_secret_here';

app.use(express.json());

app.post('/webhook', (req, res) => {
  // Get the signature from headers
  const signature = req.headers['x-signature'];

  if (!signature) {
    console.log('No X-Signature header found');
    return res.status(401).json({ error: 'Missing signature' });
  }

  // Get the raw payload
  const payload = JSON.stringify(req.body);

  // Verify the signature
  if (!verifyWebhookSignature(payload, signature, WEBHOOK_SECRET)) {
    console.log('Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Signature is valid, process the webhook
  console.log('✅ Valid webhook received:', req.body);

  // Process your webhook logic here
  const event = req.body.event;
  const data = req.body.data;

  switch (event) {
    case 'message.received':
      console.log('New message received:', data.message);
      // Handle incoming message
      break;

    case 'connection':
      console.log('Connection status changed:', data.status);
      // Handle connection status change
      break;

    case 'error':
      console.log('Error occurred:', data.error);
      // Handle error
      break;

    default:
      console.log('Unknown event:', event);
  }

  res.json({ success: true, message: 'Webhook processed successfully' });
});

app.listen(3001, () => {
  console.log('Webhook server listening on port 3001');
});

// Example webhook payload structure:
/*
{
  "event": "message.received",
  "username": "your_username",
  "timestamp": "2025-09-09T10:24:50.586Z",
  "data": {
    "message": {
      "id": "message_id",
      "from": "1234567890@s.whatsapp.net",
      "fromMe": false,
      "timestamp": 1634567890,
      "type": "conversation",
      "pushName": "John Doe",
      "content": {
        "type": "text",
        "text": "Hello!"
      },
      "isGroup": false
    },
    "business": {
      "name": "My Business",
      "working_hours": "Mon-Fri 9AM-6PM",
      "mobile_numbers": ["+1234567890"]
    }
  },
  "webhook": {
    "id": "webhook_id",
    "name": "My Webhook",
    "url": "https://your-webhook-url.com/webhook"
  }
}
*/

// Headers sent with webhook:
/*
Content-Type: application/json
User-Agent: Baileys-API-Webhook
X-Event-Type: message.received
X-Username: your_username
X-Webhook-Id: webhook_id
X-Webhook-Name: My Webhook
X-Signature: sha256=computed_hmac_signature
*/