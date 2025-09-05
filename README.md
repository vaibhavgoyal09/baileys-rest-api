
# Baileys REST API (Multi-Tenant + JWT)

A RESTful API wrapper for WhatsApp using the Baileys library, now upgraded to support multiple users/tenants with isolated WhatsApp sessions and per-tenant configuration (webhook URL, business info, etc.). API access uses JWT-based authentication.

## Features

- Multi-tenant session management (one WhatsApp session per tenant/user)
- JWT-based API authentication
- Per-tenant config:
  - Webhook URL
  - Business info (name, working hours, URLs, mobile numbers)
- Webhook notifications for real-time events (per-tenant)
- RESTful endpoints for session control and messaging
- Message ingestion with durable logging and batched SQLite persistence
- Error handling and logging

## Prerequisites

- Node.js >= 20.0.0
- npm or yarn

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/baileys-rest-api.git
   cd baileys-rest-api
   ```

2. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```

## Configuration

Create a `.env` file in the root directory based on `.env.sample`:

```
HOST=0.0.0.0
PORT=3000
ENVIRONMENT=production
# Used to sign/verify JWTs issued by /api/auth/token
JWT_SECRET=replace-with-strong-secret
# Optional: tuning for ingestion
INGEST_QUEUE_CAPACITY=5000
INGEST_BATCH_SIZE=100
INGEST_BATCH_MAX_WAIT_MS=250
INGEST_WORKERS=2
INGEST_RETRY_BASE_MS=100
INGEST_RETRY_MAX_MS=5000
INGEST_RETRY_MAX_ATTEMPTS=10
INGEST_RETRY_MAX_HORIZON_MS=600000
```

Notes:
- JWT_SECRET is required for issuing and verifying API tokens.
- Ingestion settings can be adjusted depending on throughput.

## Build and Run

Development:
```bash
npm run dev
```

Production:
```bash
npm start
```

The server will start at `http://HOST:PORT` (defaults: http://0.0.0.0:3000).

## Authentication

All protected endpoints require a Bearer JWT in the Authorization header.

- Issue a JWT (bootstrap) with:
  - POST `/api/auth/token`
  - Body:
    ```
    {
      "tenantId": "tenant-a",
      "webhook_url": "https://your-webhook-endpoint.com" // optional, can be null
    }
    ```
  - Response:
    ```
    {
      "success": true,
      "token": "eyJhbGciOi...",
      "token_type": "Bearer",
      "tenantId": "tenant-a",
      "webhook_url": "https://your-webhook-endpoint.com"
    }
    ```

- Use the token for subsequent requests:
  ```
  Authorization: Bearer <token>
  ```

This bootstrap endpoint simulates user provisioning. In production, replace with your auth system and sign tokens with the same JWT_SECRET.

## Multi-Tenant Model

- Each tenantId represents an isolated WhatsApp session.
- Baileys auth state is stored under `./sessions/<tenantId>/` using Baileys `useMultiFileAuthState`.
- Per-tenant configuration (webhook_url and business_info) is stored in `./data/config.db`.
- Messages and chats are persisted in `./data/whatsapp.db` (shared DB). If you require strict per-tenant data storage, partitioning can be introduced later.

## Webhooks

Per-tenant webhook delivery is implemented. For each tenant, set `webhook_url`:

- PUT `/api/business/webhook` (requires Authorization header)

Body:
```
{ "webhook_url": "https://example.com/hooks/wa" }
```

Events delivered (headers include `X-Tenant-Id` and `X-Event-Type`):
- `connection`:
  - `{ "event":"connection", "tenantId":"...", "data": { "status": "connected|waiting_qr|logged_out" } }`
- `message.received`:
  - `{ "event":"message.received", "tenantId":"...", "data": { "message": {...}, "business": {...} } }`
- `error`:
  - `{ "event":"error", "tenantId":"...", "data": { "error": "..." } }`

## API Endpoints

Authentication
- POST `/api/auth/token`
  - Body: `{ "tenantId": "string", "webhook_url": "string|null (optional)" }`
  - Description: Issues JWT for a tenant; upserts tenant config.
  - Public (no Authorization). Replace with your own auth in production.

Sessions (Authorization required)
- POST `/api/session/start`
  - Description: Starts/Resumes WhatsApp session for the tenant associated with the JWT.
  - Response:
    - If QR required:
      ```
      {
        "success": true,
        "status": "waiting_qr",
        "qr": "<raw_qr_string>",
        "qrBase64": "data:image/png;base64,..."
      }
      ```
    - If connected:
      ```
      {
        "success": true,
        "status": "connected",
        "message": "WhatsApp connection successful"
      }
      ```

- GET `/api/session/status`
  - Description: Returns connection status for the authenticated tenant
  - Response:
    ```
    {
      "success": true,
      "isConnected": true|false,
      "qr": null|"raw_qr_string",
      "qrBase64": "data:image/png;base64,..." // only when qr present
    }
    ```

- POST `/api/session/logout`
  - Description: Logs out and removes the tenant's Baileys credentials.
  - Response:
    ```
    { "success": true, "status":"logged_out", "message":"Session successfully terminated" }
    ```

Messages (Authorization required)
- POST `/api/message/check-number`
  - Body: `{ "to": "1234567890" }`
  - Description: Check if a number exists on WhatsApp for this tenant's session.
  - Response: `{ "exists": true|false, "jid": "jid@server|null" }`

- POST `/api/message/send-text`
  - Body: `{ "to": "1234567890 or 1234567890@s.whatsapp.net", "message": "Hello!" }`
  - Description: Send a text message from the tenant's WA session.
  - Response: Baileys sendMessage result.

- GET `/api/message/conversations?limit=50&cursor=<ts>`
  - Description: Returns stored conversations from SQLite store (shared DB).
  - Note: Not tenant-partitioned in DB yet.

- GET `/api/message/messages?jid=<jid>&limit=50&cursor=<ts>`
  - Description: Returns stored messages for a chat from SQLite store.

Business (Authorization required)
- GET `/api/business`
  - Description: Returns stored business info for the tenant.

- PUT `/api/business`
  - Body:
    ```
    {
      "name": "string|null",
      "working_hours": "string|null",
      "location_url": "http/https URL|null",
      "shipping_details": "string|null",
      "instagram_url": "http/https URL|null",
      "website_url": "http/https URL|null",
      "mobile_numbers": ["+1234567890", "9876543210"]|null
    }
    ```
  - Description: Update business info for the tenant.

- POST `/api/business/refresh`
  - Description: When connected, tries to fetch available business profile info via Baileys and persist.

- PUT `/api/business/webhook`
  - Body: `{ "webhook_url": "http/https URL|null" }`
  - Description: Set or update the tenant webhook URL.

## Architectural Notes

- JWT-based API auth:
  - Middleware: `middlewares/verifyToken.ts`
  - Utils: `utils/jwt.ts`
  - Token payload: `{ userId: string }` (userId == tenantId)
- Multi-tenant session manager:
  - `services/waManager.ts`: manages a map of TenantSession objects
  - Baileys auth state stored under `./sessions/<tenantId>/`
- Per-tenant config store:
  - `services/configStore.ts`: SQLite DB `./data/config.db` with `users` and `business_info` tables
- Message ingestion and persistence:
  - `services/ingestion.ts` with append-only log and workers
  - `services/sqliteStore.ts` persists chats/messages to `./data/whatsapp.db`

## Frontend Usage

The project includes a web-based frontend for managing WhatsApp sessions and user configurations. The frontend files are located in the `frontend/` directory.

### Accessing the Frontend

1. **Start the backend server**:
   ```bash
   npm run dev
   ```

2. **Open the login page**:
   - Navigate to `frontend/login.html` in your web browser
   - Or serve the frontend using a local web server

### Frontend Features

- **Login/Registration**:
  - New users can register by providing a Tenant ID and Webhook URL
  - Existing users can login with their Tenant ID
  - JWT tokens are automatically stored and managed

- **Session Management** (`session-manager.html`):
  - Start/stop WhatsApp sessions
  - Check session status
  - View QR codes for authentication
  - Send messages and check phone numbers
  - Manage business profile information
  - View conversations and messages

- **User Management** (`user-management.html`):
  - View current user information
  - Update webhook URL
  - Manage user settings (future expansion)

### Authentication Flow

1. User visits `login.html` and enters Tenant ID
2. Frontend calls `/api/auth/token` to get JWT
3. JWT is stored in localStorage for future requests
4. All subsequent API calls include `Authorization: Bearer <token>` header
5. User is redirected to session manager after successful login

### File Structure

```
frontend/
├── login.html              # Login and registration page
├── session-manager.html    # Main session management interface
└── user-management.html    # User management and settings
```

## Development Workflow

1. Issue a token for a tenant and set a webhook (optional):
   ```bash
   curl -X POST http://localhost:3000/api/auth/token \
