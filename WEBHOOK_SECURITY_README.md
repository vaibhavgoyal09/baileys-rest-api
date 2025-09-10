# 🔐 Webhook Security & Signature Verification

## Overview

The Baileys REST API now includes HMAC-SHA256 signature verification for webhook security. This ensures that webhook notifications are genuinely sent from your server and haven't been tampered with by malicious actors.

## How It Works

### 1. **Webhook Secret Generation**
- Each webhook automatically gets a unique 64-character hex secret when created
- Secrets are stored securely in the database
- Existing webhooks get random secrets during migration

### 2. **Signature Creation**
When sending webhooks, the server:
1. Creates the JSON payload
2. Computes `HMAC-SHA256(payload, webhook_secret)`
3. Includes `X-Signature: sha256=<signature>` header

### 3. **Client Verification**
Clients should:
1. Extract the signature from `X-Signature` header
2. Compute expected signature using their webhook secret
3. Compare signatures using timing-safe comparison

## Frontend Features

### Webhook Management
- **View Secrets**: Click the "🔑 Secret" button to reveal webhook secrets
- **Copy to Clipboard**: Use the copy button to easily copy secrets
- **Secure Display**: Secrets are hidden by default for security
- **User Dashboard**: Current user info shows webhook secrets (truncated for security)

### Security Best Practices
- 🔐 Keep webhook secrets secure and never expose them publicly
- 🔄 Rotate webhook secrets periodically for enhanced security
- ✅ Always verify signatures before processing webhooks
- 🚫 Don't log webhook secrets in application logs

## API Endpoints

### Get Webhook Secret
```http
GET /api/auth/webhooks/:id/secret
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "success": true,
  "webhook": {
    "id": "webhook_id",
    "secret": "64_char_hex_secret"
  }
}
```

## Implementation Examples

### Node.js/Express
```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const [algorithm, receivedSignature] = signature.split('=');
  if (algorithm !== 'sha256') return false;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(receivedSignature, 'hex')
  );
}

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-signature'];
  const payload = JSON.stringify(req.body);

  if (!verifyWebhookSignature(payload, signature, WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process webhook
  res.json({ success: true });
});
```

### Python
```python
import hmac
import hashlib
import json

def verify_webhook_signature(payload, signature, secret):
    algorithm, received_signature = signature.split('=', 1)
    if algorithm != 'sha256':
        return False

    expected_signature = hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()

    return hmac.compare_digest(expected_signature, received_signature)

@app.route('/webhook', methods=['POST'])
def webhook():
    signature = request.headers.get('X-Signature')
    payload = json.dumps(request.get_json())

    if not verify_webhook_signature(payload, signature, WEBHOOK_SECRET):
        return jsonify({'error': 'Invalid signature'}), 401

    # Process webhook
    return jsonify({'success': True})
```

### PHP
```php
function verifyWebhookSignature($payload, $signature, $secret) {
    list($algorithm, $receivedSignature) = explode('=', $signature, 2);
    if ($algorithm !== 'sha256') {
        return false;
    }

    $expectedSignature = hash_hmac('sha256', $payload, $secret);
    return hash_equals($expectedSignature, $receivedSignature);
}

$app->post('/webhook', function($request, $response) {
    $signature = $request->getHeaderLine('X-Signature');
    $payload = json_encode($request->getParsedBody());

    if (!verifyWebhookSignature($payload, $signature, WEBHOOK_SECRET)) {
        return $response->withJson(['error' => 'Invalid signature'], 401);
    }

    // Process webhook
    return $response->withJson(['success' => true]);
});
```

## Webhook Payload Structure

```json
{
  "event": "message.received",
  "username": "your_username",
  "timestamp": "2025-09-09T10:24:50.586Z",
  "data": {
    // Event-specific data
  },
  "webhook": {
    "id": "webhook_id",
    "name": "My Webhook",
    "url": "https://your-webhook-url.com/webhook"
  }
}
```

## Headers Sent

```http
Content-Type: application/json
User-Agent: Baileys-API-Webhook
X-Event-Type: message.received
X-Username: your_username
X-Webhook-Id: webhook_id
X-Webhook-Name: My Webhook
X-Signature: sha256=computed_hmac_signature
```

## Supported Events

- `message.received` - New incoming message
- `connection` - WhatsApp connection status change
- `error` - Error occurred during processing

## Security Considerations

### Timing Attack Protection
- Uses `crypto.timingSafeEqual()` (Node.js) or equivalent timing-safe comparison
- Prevents attackers from using timing differences to guess signatures

### Secret Management
- Secrets are 64-character hex strings (32 bytes)
- Generated using cryptographically secure random number generator
- Stored securely in database with proper access controls

### Best Practices
1. **Always verify signatures** before processing webhooks
2. **Use HTTPS** for webhook endpoints
3. **Implement rate limiting** to prevent abuse
4. **Log suspicious activity** without exposing secrets
5. **Rotate secrets periodically** for enhanced security

## Migration Notes

- Existing webhooks automatically get random secrets
- No breaking changes to existing webhook functionality
- Signature verification is optional but recommended
- Legacy webhook endpoints continue to work without verification

## Troubleshooting

### Common Issues

**"Invalid signature" error:**
- Verify webhook secret is correct
- Ensure payload is stringified exactly as received
- Check for extra whitespace or encoding issues

**"Missing X-Signature header":**
- Ensure webhook URL is accessible
- Check server logs for webhook delivery failures
- Verify webhook is active in settings

**Timing issues:**
- Webhook processing should be fast
- Implement proper error handling
- Use appropriate timeouts

## Files Updated

- `prisma/schema.prisma` - Added secret field
- `services/waManager.ts` - Added signature generation
- `routes/auth.ts` - Added secret retrieval endpoint
- `services/prismaConfigStore.ts` - Updated webhook handling
- `utils/webhookVerification.ts` - Client verification utility
- `frontend/settings.html` - Secret management UI
- `frontend/index.html` - Security information
- `frontend/webhook-verification-example.js` - Implementation examples

## Next Steps

1. **Apply Migration**: Run `npx prisma migrate deploy`
2. **Regenerate Client**: Run `npx prisma generate`
3. **Test Webhooks**: Create test webhooks and verify signatures
4. **Implement Verification**: Add signature verification to your webhook endpoints
5. **Monitor Logs**: Check for any webhook delivery issues

---

**🔐 Security Note**: Webhook signature verification is a critical security feature. Always implement it in production environments to prevent webhook spoofing attacks.