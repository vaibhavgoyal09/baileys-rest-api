# Baileys REST API Documentation

## Base URL
```
http://localhost:3001/api
```

## Authentication
All endpoints (except `/auth/token`, `/auth/register`, `/auth/login`) require JWT authentication via Bearer token.

### Headers
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

---

## 🔐 Authentication Endpoints

### POST `/auth/token`
**Bootstrap endpoint for issuing JWT tokens**

#### Request
```http
POST /api/auth/token
Content-Type: application/json

{
  "username": "your_username",
  "webhook_url": "https://your-webhook-url.com/webhook" // optional
}
```

#### Parameters
- `username` (string, required): Unique identifier for the user/tenant (3-128 chars)
- `webhook_url` (string, optional): Webhook URL for receiving notifications (must be valid HTTP/HTTPS URL)

#### Response (Success - 200)
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "username": "your_username",
  "webhook_url": "https://your-webhook-url.com/webhook"
}
```

#### Response (Error - 400/500)
```json
{
  "success": false,
  "message": "Error description"
}
```

---

### POST `/auth/register`
**Register a new user account**

#### Request
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "your_password"
}
```

#### Parameters
- `name` (string, required): User's full name (1-100 chars)
- `email` (string, required): Valid email address
- `password` (string, required): Password (minimum 8 characters)

#### Response (Success - 201)
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "username": "johndoe123abc",
  "webhooks": []
}
```

---

### POST `/auth/login`
**Authenticate user and get JWT token**

#### Request
```http
POST /api/auth/login
Content-Type: application/json

{
  "username": "johndoe123abc", // or email
  "password": "your_password"
}
```

#### Parameters
- `username` (string, required): Username or email address
- `password` (string, required): User's password

#### Response (Success - 200)
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "username": "johndoe123abc",
  "webhooks": [
    {
      "id": "webhook_id",
      "url": "https://your-webhook-url.com/webhook",
      "name": "My Webhook",
      "secret": "64_char_hex_secret",
      "isActive": true
    }
  ]
}
```

---

### GET `/auth/user`
**Get current user information**

#### Request
```http
GET /api/auth/user
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "user": {
    "name": "John Doe",
    "email": "john@example.com",
    "webhooks": [
      {
        "id": "webhook_id",
        "url": "https://your-webhook-url.com/webhook",
        "name": "My Webhook",
        "secret": "64_char_hex_secret",
        "isActive": true
      }
    ],
    "createdAt": "2025-09-09T10:24:50.586Z"
  }
}
```

---

### GET `/auth/api-key`
**Get API key (JWT token) for the authenticated user**

#### Request
```http
GET /api/auth/api-key
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "api_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "username": "your_username"
}
```

**Note:** The API key is the same as your JWT access token used for authentication.

---

## 🎣 Webhook Management Endpoints

### GET `/auth/webhooks`
**List all webhooks for the authenticated user**

#### Request
```http
GET /api/auth/webhooks
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "webhooks": [
    {
      "id": "webhook_id_1",
      "url": "https://your-webhook-url.com/webhook1",
      "name": "Primary Webhook",
      "secret": "64_char_hex_secret_1",
      "isActive": true
    },
    {
      "id": "webhook_id_2",
      "url": "https://your-webhook-url.com/webhook2",
      "name": "Backup Webhook",
      "secret": "64_char_hex_secret_2",
      "isActive": false
    }
  ]
}
```

---

### POST `/auth/webhooks`
**Create a new webhook**

#### Request
```http
POST /api/auth/webhooks
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "url": "https://your-webhook-url.com/webhook",
  "name": "My Webhook",
  "isActive": true
}
```

#### Parameters
- `url` (string, required): Webhook URL (must be valid HTTP/HTTPS URL)
- `name` (string, optional): Friendly name for the webhook
- `isActive` (boolean, optional): Whether webhook is active (default: true)

#### Response (Success - 201)
```json
{
  "success": true,
  "webhook": {
    "id": "new_webhook_id",
    "url": "https://your-webhook-url.com/webhook",
    "name": "My Webhook",
    "isActive": true
  }
}
```

---

### PUT `/auth/webhooks/:id`
**Update an existing webhook**

#### Request
```http
PUT /api/auth/webhooks/webhook_id_123
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "url": "https://updated-webhook-url.com/webhook",
  "name": "Updated Webhook",
  "isActive": false
}
```

#### Parameters
- `id` (URL parameter, required): Webhook ID
- `url` (string, optional): New webhook URL
- `name` (string, optional): New webhook name
- `isActive` (boolean, optional): New active status

#### Response (Success - 200)
```json
{
  "success": true,
  "message": "Webhook updated successfully"
}
```

---

### DELETE `/auth/webhooks/:id`
**Delete a webhook**

#### Request
```http
DELETE /api/auth/webhooks/webhook_id_123
Authorization: Bearer <jwt_token>
```

#### Parameters
- `id` (URL parameter, required): Webhook ID to delete

#### Response (Success - 200)
```json
{
  "success": true,
  "message": "Webhook deleted successfully"
}
```

---

### GET `/auth/webhooks/:id/secret`
**Get webhook secret for signature verification**

#### Request
```http
GET /api/auth/webhooks/webhook_id_123/secret
Authorization: Bearer <jwt_token>
```

#### Parameters
- `id` (URL parameter, required): Webhook ID

#### Response (Success - 200)
```json
{
  "success": true,
  "webhook": {
    "id": "webhook_id_123",
    "secret": "64_char_hex_secret_for_hmac_verification"
  }
}
```

---

## 📱 WhatsApp Session Management

### POST `/session/start`
**Start or resume WhatsApp session**

#### Request
```http
POST /api/session/start
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "status": "waiting_qr",
  "qr": "QR_CODE_STRING",
  "qrBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

#### Response (Already Connected - 200)
```json
{
  "success": true,
  "status": "connected",
  "message": "WhatsApp connection successful"
}
```

---

### GET `/session/status`
**Get current session status**

#### Request
```http
GET /api/session/status
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "isConnected": true,
  "qr": null,
  "qrBase64": null
}
```

---

### POST `/session/logout`
**Logout from WhatsApp session**

#### Request
```http
POST /api/session/logout
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "status": "logged_out",
  "message": "Session successfully terminated",
  "reason": "user_logout"
}
```

---

## 💬 Message Endpoints

### POST `/message/check-number`
**Check if a phone number is registered on WhatsApp**

#### Request
```http
POST /api/message/check-number
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "to": "+1234567890"
}
```

#### Parameters
- `to` (string, required): Phone number to check (with or without +)

#### Response (Success - 200)
```json
{
  "exists": true,
  "jid": "1234567890@s.whatsapp.net"
}
```

---

### POST `/message/send-text`
**Send a text message**

#### Request
```http
POST /api/message/send-text?username=your_username
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "to": "+1234567890",
  "message": "Hello from Baileys API!"
}
```

#### Query Parameters
- `username` (string, required): Username/tenant ID

#### Body Parameters
- `to` (string, required): Recipient phone number (with or without +)
- `message` (string, required): Message text to send

#### Response (Success - 200)
```json
{
  "key": {
    "remoteJid": "1234567890@s.whatsapp.net",
    "fromMe": true,
    "id": "message_id"
  },
  "messageTimestamp": 1634567890,
  "status": "sent"
}
```

---

### GET `/message/conversations`
**List recent conversations**

#### Request
```http
GET /api/message/conversations?limit=20&cursor=0
Authorization: Bearer <jwt_token>
```

#### Query Parameters
- `limit` (number, optional): Number of conversations to return (1-500, default: 50)
- `cursor` (number, optional): Pagination cursor

#### Response (Success - 200)
```json
{
  "conversations": [
    {
      "jid": "1234567890@s.whatsapp.net",
      "name": "John Doe",
      "isGroup": false,
      "unreadCount": 0,
      "lastMessageTimestamp": 1634567890,
      "lastMessageText": "Hello!"
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

---

### GET `/message/messages`
**List messages for a specific conversation**

#### Request
```http
GET /api/message/messages?jid=1234567890@s.whatsapp.net&limit=20&cursor=0
Authorization: Bearer <jwt_token>
```

#### Query Parameters
- `jid` (string, required): WhatsApp JID of the conversation
- `limit` (number, optional): Number of messages to return (default: 50)
- `cursor` (number, optional): Pagination cursor

#### Response (Success - 200)
```json
{
  "messages": [
    {
      "id": "message_id",
      "jid": "1234567890@s.whatsapp.net",
      "fromMe": false,
      "timestamp": 1634567890,
      "type": "conversation",
      "pushName": "John Doe",
      "content": {
        "type": "text",
        "text": "Hello!"
      },
      "isGroup": false
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

---

## 🏢 Business Information Endpoints

### GET `/business`
**Get business information**

#### Request
```http
GET /api/business
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "data": {
    "name": "My Business",
    "working_hours": "Mon-Fri 9AM-6PM",
    "location_url": "https://maps.google.com/...",
    "shipping_details": "Free shipping over $50",
    "instagram_url": "https://instagram.com/mybusiness",
    "website_url": "https://mybusiness.com",
    "mobile_numbers": ["+1234567890", "+0987654321"],
    "last_updated": 1634567890123
  }
}
```

---

### PUT `/business`
**Update business information**

#### Request
```http
PUT /api/business
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "name": "Updated Business Name",
  "working_hours": "Mon-Sun 8AM-8PM",
  "website_url": "https://updated-website.com",
  "mobile_numbers": ["+1111111111"]
}
```

#### Parameters (all optional)
- `name` (string): Business name
- `working_hours` (string): Business hours description
- `location_url` (string): Valid HTTP/HTTPS URL
- `shipping_details` (string): Shipping information
- `instagram_url` (string): Valid HTTP/HTTPS URL
- `website_url` (string): Valid HTTP/HTTPS URL
- `mobile_numbers` (array): Array of phone numbers (6-18 digits, optional + prefix)

#### Response (Success - 200)
```json
{
  "success": true,
  "message": "Business info updated",
  "data": {
    "name": "Updated Business Name",
    "working_hours": "Mon-Sun 8AM-8PM",
    "website_url": "https://updated-website.com",
    "mobile_numbers": ["+1111111111"],
    "last_updated": 1634567890123
  }
}
```

---

### POST `/business/refresh`
**Refresh business information from WhatsApp**

#### Request
```http
POST /api/business/refresh
Authorization: Bearer <jwt_token>
```

#### Response (Success - 200)
```json
{
  "success": true,
  "stored": {
    "name": "My Business",
    "working_hours": "Mon-Fri 9AM-6PM",
    "mobile_numbers": ["+1234567890"],
    "last_updated": 1634567890123
  },
  "fetched": {
    "title": "My Business",
    "businessHours": {
      "timezone": "America/New_York",
      "config": {}
    },
    "connectedAccounts": [
      {
        "type": "instagram",
        "value": "mybusiness"
      }
    ],
    "about": "Welcome to my business!"
  },
  "persisted": true
}
```

---

### PUT `/business/webhook`
**Set webhook URL (legacy endpoint)**

#### Request
```http
PUT /api/business/webhook
Authorization: Bearer <jwt_token>
Content-Type: application/json

{
  "webhook_url": "https://your-webhook-url.com/webhook"
}
```

#### Parameters
- `webhook_url` (string, required): Webhook URL or null to disable

#### Response (Success - 200)
```json
{
  "success": true,
  "message": "Webhook updated",
  "webhook_url": "https://your-webhook-url.com/webhook"
}
```

---

## 🔗 Webhook Events

### Webhook Headers
When webhooks are triggered, the following headers are included:

```http
Content-Type: application/json
User-Agent: Baileys-API-Webhook
X-Event-Type: message.received
X-Username: your_username
X-Webhook-Id: webhook_id
X-Webhook-Name: My Webhook
X-Signature: sha256=computed_hmac_signature
```

### Webhook Payload Structure
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

### Supported Events

#### `connection`
Triggered when WhatsApp connection status changes.

```json
{
  "event": "connection",
  "username": "your_username",
  "timestamp": "2025-09-09T10:24:50.586Z",
  "data": {
    "status": "connected" // or "waiting_qr", "logged_out", etc.
  },
  "webhook": {
    "id": "webhook_id",
    "name": "My Webhook",
    "url": "https://your-webhook-url.com/webhook"
  }
}
```

#### `message.received`
Triggered when a new message is received.

```json
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
```

#### `error`
Triggered when errors occur.

```json
{
  "event": "error",
  "username": "your_username",
  "timestamp": "2025-09-09T10:24:50.586Z",
  "data": {
    "type": "message_processing_error",
    "error": "Failed to process incoming message"
  },
  "webhook": {
    "id": "webhook_id",
    "name": "My Webhook",
    "url": "https://your-webhook-url.com/webhook"
  }
}
```

---

## 🔐 Webhook Signature Verification

### How to Verify Webhook Signatures

1. **Get the webhook secret** using `GET /api/auth/webhooks/:id/secret`
2. **Extract the signature** from the `X-Signature` header (format: `sha256=<signature>`)
3. **Compute expected signature** using HMAC-SHA256
4. **Compare signatures** using timing-safe comparison

### Example Verification Code (Node.js)

```javascript
import crypto from 'crypto';

function verifyWebhookSignature(payload, signature, secret) {
  const [algorithm, receivedSignature] = signature.split('=');

  if (algorithm !== 'sha256') {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature, 'hex'),
    Buffer.from(receivedSignature, 'hex')
  );
}

// Usage in Express route
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

### Using the Provided Utility

```javascript
import { createWebhookVerifier } from './utils/webhookVerification.js';

const verifier = createWebhookVerifier('your-webhook-secret');

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-signature'];
  const payload = JSON.stringify(req.body);

  if (!verifier.verifySignature(payload, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Process webhook
  res.json({ success: true });
});
```

---

## 📊 Health Check Endpoints

### GET `/health`
**Basic health check**

#### Response (Success - 200)
```json
{
  "ok": true,
  "db": true,
  "queueDepth": 0,
  "counters": {
    "processed": 150,
    "failed": 2
  }
}
```

### GET `/ready`
**Readiness check with queue depth validation**

#### Response (Success - 200)
```json
{
  "ready": true,
  "db": true,
  "backlogOk": true,
  "queueDepth": 0,
  "threshold": 4500
}
```

### GET `/metrics`
**Detailed metrics**

#### Response (Success - 200)
```json
{
  "queueDepth": 0,
  "counters": {
    "processed": 150,
    "failed": 2
  },
  "rates": {
    "processedPerSecond": 0.5
  }
}
```

---

## ⚠️ Error Responses

All endpoints return errors in the following format:

```json
{
  "success": false,
  "message": "Error description"
}
```

### Common HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing/invalid token)
- `404` - Not Found
- `500` - Internal Server Error

---

## 🔧 Environment Variables

```bash
# Server Configuration
HOST=localhost
PORT=3001

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/baileys_db

# JWT
JWT_SECRET=your_jwt_secret_key

# Queue Configuration
INGEST_QUEUE_CAPACITY=5000
INGEST_READY_MAX_QUEUE_DEPTH=4500
```

---

## 📝 Notes

1. **Authentication**: All endpoints except `/auth/token`, `/auth/register`, and `/auth/login` require JWT authentication
2. **Webhook Verification**: Always verify webhook signatures to ensure authenticity
3. **Rate Limiting**: Implement appropriate rate limiting on your webhook endpoints
4. **Error Handling**: Always check the `success` field in responses
5. **Pagination**: Use `cursor` and `limit` parameters for large result sets
6. **Phone Numbers**: Can be provided with or without country code prefix (+)
7. **Timestamps**: All timestamps are in Unix epoch format (seconds) unless specified otherwise

---

## 🆘 Support

For issues or questions:
1. Check the error message in the response
2. Verify your JWT token is valid and not expired
3. Ensure webhook URLs are accessible and return 2xx status codes
4. Check server logs for detailed error information