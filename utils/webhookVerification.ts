import crypto from 'crypto';

/**
 * Webhook verification utility for clients to verify incoming webhook signatures
 */
export class WebhookVerifier {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /**
   * Verify the signature of an incoming webhook
   * @param payload The raw request body as string
   * @param signature The signature from X-Signature header (format: "sha256=...")
   * @returns boolean indicating if the signature is valid
   */
  verifySignature(payload: string, signature: string): boolean {
    try {
      // Extract the signature from header (format: "sha256=signature")
      const parts = signature.split('=');
      const algorithm = parts[0];
      const receivedSignature = parts[1];

      if (algorithm !== 'sha256' || !receivedSignature) {
        return false;
      }

      // Compute expected signature
      const expectedSignature = crypto
        .createHmac('sha256', this.secret)
        .update(payload)
        .digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
      );
    } catch (error) {
      console.error('Error verifying webhook signature:', error);
      return false;
    }
  }

  /**
   * Express middleware to verify webhook signatures
   * @param req Express request object
   * @param res Express response object
   * @param next Express next function
   */
  middleware(req: any, res: any, next: any): void {
    const signature = req.headers['x-signature'];
    const payload = JSON.stringify(req.body);

    if (!signature) {
      res.status(401).json({
        success: false,
        message: 'Missing X-Signature header'
      });
      return;
    }

    if (!this.verifySignature(payload, signature)) {
      res.status(401).json({
        success: false,
        message: 'Invalid signature'
      });
      return;
    }

    next();
  }
}

/**
 * Utility function to create a webhook verifier
 * @param secret The webhook secret
 * @returns WebhookVerifier instance
 */
export function createWebhookVerifier(secret: string): WebhookVerifier {
  return new WebhookVerifier(secret);
}

/**
 * Example usage:
 *
 * // On your webhook endpoint
 * import { createWebhookVerifier } from './utils/webhookVerification.js';
 *
 * const verifier = createWebhookVerifier('your-webhook-secret');
 *
 * app.post('/webhook', (req, res) => {
 *   const signature = req.headers['x-signature'];
 *   const payload = JSON.stringify(req.body);
 *
 *   if (!verifier.verifySignature(payload, signature)) {
 *     return res.status(401).json({ error: 'Invalid signature' });
 *   }
 *
 *   // Process the webhook
 *   res.json({ success: true });
 * });
 */