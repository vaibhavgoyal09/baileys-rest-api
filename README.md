# Baileys REST API

A RESTful API wrapper for WhatsApp using the Baileys library, enabling programmatic interactions with WhatsApp Web.

## Features

- RESTful API endpoints for WhatsApp operations
- QR code-based authentication
- Webhook notifications for real-time events
- Support for sending messages
- Phone number validation
- Session management
- Error handling and logging

## Prerequisites

- Node.js >= 20.0.0
- Yarn or npm

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
HOST=localhost
PORT=3001
WEBHOOK_URL=https://your-webhook-endpoint.com
```

- `HOST`: The host address for the server (optional, defaults to localhost)
- `PORT`: The port number for the server (optional, defaults to 3001)
- `WEBHOOK_URL`: URL for webhook notifications (optional)

## Usage

### Starting the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The server will start at `http://localhost:3001`

### Authentication

Include the authorization header in all API requests:
```
Authorization: Bearer <your-token>
```

Note: Replace `<your-token>` with your actual authentication token.

### API Endpoints

#### Sessions

1. **Start Session**
   - **POST** `/api/session/start`
   - Description: Initializes a new WhatsApp session
   - Response:
     - If QR code is required: `{ "status": "waiting_qr", "qr": "...", "qrBase64": "..." }`
     - If connected: `{ "status": "connected", "message": "Success" }`

2. **Get Session Status**
   - **GET** `/api/session/status`
   - Description: Retrieves the current connection status
   - Response: `{ "isConnected": true|false, "qr": null|"qr_code" }`

3. **Logout**
   - **POST** `/api/session/logout`
   - Description: Terminates the current session and cleans up
   - Response: `{ "success": true, "message": "Session terminated" }`

#### Messages

1. **Check Number**
   - **POST** `/api/message/check-number`
   - Body: `{ "to": "1234567890" }`
   - Description: Checks if a phone number is registered on WhatsApp
   - Response: `{ "exists": true, "jid": "jid@server" }`

2. **Send Text Message**
   - **POST** `/api/message/send-text`
   - Body: `{ "to": "1234567890@s.whatsapp.net", "message": "Hello!" }`
   - Description: Sends a text message to a phone number or group
   - Response: `{ "key": { "id": "message_id" }, "messageTimestamp": timestamp }`

### Webhook Integration

The API supports webhook notifications for real-time events. Configure the `WEBHOOK_URL` in your `.env` file to receive notifications for:

- Connection events (`connection`): `{ "event": "connection", "data": { "status": "connected|waiting_qr|logged_out" } }`
- Incoming messages (`message.received`): Message details including content, sender, etc.
- Errors (`error`): Error notifications

## Examples

### Start a WhatsApp Session

```bash
curl -X POST http://localhost:3001/api/session/start \
  -H "Authorization: Bearer your-token"
```

### Send a Message

```bash
curl -X POST http://localhost:3001/api/message/send-text \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"to": "1234567890@s.whatsapp.net", "message": "Hello from Baileys REST API!"}'
```

### Check a Phone Number

```bash
curl -X POST http://localhost:3001/api/message/check-number \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"to": "1234567890"}'
```

## License

MIT License - see LICENSE file for details.

## Author

Vaibhav Goyal