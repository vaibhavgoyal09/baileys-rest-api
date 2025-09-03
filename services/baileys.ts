import { default as makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { fileURLToPath } from 'url';
import { pino } from 'pino';
import fs from 'fs/promises';
import { logger, errorLogger } from '../utils/logger.js';
import Store, { Chat } from './sqliteStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WhatsAppServiceResult {
  success: boolean;
  status: string;
  message?: string;
  qr?: string;
  error?: string;
  reason?: string;
}

interface ConnectionStatus {
  isConnected: boolean;
  qr: string | null;
  qrBase64?: string;
}

interface MessageInfo {
  id: string;
  from: string;
  fromMe: boolean;
  timestamp: number;
  type: string;
  pushName: string | null;
  content: any;
  isGroup: boolean;
}

class WhatsAppService {
  private sock: any = null;
  private isConnected: boolean = false;
  private qr: string | null = null;
  private sessionPath: string;
  private connectionUpdateHandler: any = null;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS: number = 5;

  constructor() {
    this.sessionPath = path.join(__dirname, '../sessions');
  }

  async isSessionValid(): Promise<boolean> {
    try {
      // Check if session directory exists
      await fs.access(this.sessionPath);

      // Check if creds.json exists (main auth file)
      const credsPath = path.join(this.sessionPath, 'creds.json');
      await fs.access(credsPath);

      // Try to read and parse creds.json to ensure it's valid
      const credsData = await fs.readFile(credsPath, 'utf-8');
      const creds = JSON.parse(credsData);

      // Basic validation: check if it has essential fields
      if (creds && creds.me && creds.platform) {
        logger.debug('Session appears valid');
        return true;
      }

      logger.warn('Session creds.json exists but appears invalid');
      return false;
    } catch (error) {
      logger.debug('Session validation failed:', error);
      return false;
    }
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  async waitForQR(timeout: number = 300000): Promise<string | null> {
    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;

      // Function to cleanup event handlers
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.connectionUpdateHandler && this.sock?.ev) {
          this.sock.ev.off('connection.update', this.connectionUpdateHandler);
          this.connectionUpdateHandler = null;
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        // Resolve with null on timeout
        resolve(null);
      }, timeout);

      if (this.sock) {
        this.connectionUpdateHandler = (update: any) => {
          const { connection, qr } = update;

          if (qr) {
            cleanup();
            this.qr = qr;
            resolve(qr);
          } else if (connection === 'open') {
            cleanup();
            resolve(null);
          }
        };

        this.sock.ev.on('connection.update', this.connectionUpdateHandler);
      } else {
        cleanup();
        resolve(null);
      }
    });
  }

  async initialize(isReconnecting: boolean = false): Promise<WhatsAppServiceResult> {
    try {
      // Check if session directory exists
      try {
        await fs.access(this.sessionPath);
      } catch (error) {
        if (isReconnecting) {
          logger.warn('No session found, cannot reconnect');
          return {
            success: false,
            status: 'error',
            message: 'No session found, cannot reconnect',
          };
        }
      }

      if (isReconnecting) {
        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
          logger.warn(`Maximum reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) exceeded`);
          await this.handleLogout('max_attempts_exceeded');
          return await this.initialize(false);
        }
        logger.info(`Attempting to reconnect... (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
      } else {
        this.resetReconnectAttempts();
      }

      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      this.sock = makeWASocket({
        auth: state,

        browser: ['Baileys Bot', 'Chrome', '120.0.6099.109'],
        logger: pino({ level: 'silent' }),
      });

      this.sock.ev.on('connection.update', async (update: any) => {
        logger.debug({ msg: 'Connection update received', update });
        if (update.qr) {
          console.log('QR Code received:', update.qr);
        }
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          // If already connected and trying to reconnect, cancel the operation
          if (this.isConnected && isReconnecting) {
            logger.info({
              msg: 'Connection already active, reconnection cancelled',
            });
            return;
          }

          const statusCode = (lastDisconnect?.error instanceof Boom) ? (lastDisconnect.error as any).output?.statusCode : undefined;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && !this.isConnected) {
            await this.initialize(true);
          } else if (!shouldReconnect) {
            logger.info({
              msg: 'Session terminated',
            });
            await this.handleLogout('connection_closed');
            await this.initialize(false);
          }
        } else if (connection === 'open') {
          this.isConnected = true;
          this.qr = null;
          this.resetReconnectAttempts();
          logger.info({
            msg: 'WhatsApp connection successful!',
          });
          await WhatsAppService.notifyWebhook('connection', { status: 'connected' });
        }
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('chats.set', ({ chats }: any) => {
        try {
          const list = chats || [];
          logger.debug({
            msg: 'chats.set event fired',
            count: list.length,
            chats: list.slice(0, 3) // Log first 3 chats for debugging
          });
          Store.upsertChats(list);
          logger.debug({ msg: 'Chats set synced successfully', count: list.length });
        } catch (e) {
          errorLogger.error({ msg: 'Error syncing chats.set', error: (e as Error)?.message || e });
        }
      });

      this.sock.ev.on('contacts.upsert', (contacts: any) => {
        try {
          (contacts || []).forEach((c: any) => {
            const jid = c.id || c.jid;
            if (!jid) return;
            const name = c.name || c.notify || c.pushName || null;
            Store.upsertChatPartial(jid, { name });
          });
          logger.debug({ msg: 'Contacts upsert processed', count: (contacts || []).length });
        } catch (e) {
          errorLogger.error({ msg: 'Error processing contacts.upsert', error: (e as Error)?.message || e });
        }
      });

      this.sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type === 'notify') {
          try {
            await Promise.all(m.messages.map(async (msg: any) => {
              // Skip protocol messages as they are system messages
              const messageType = Object.keys(msg.message || {})[0] || '';
              if (messageType === 'protocolMessage') {
                return;
              }

              // Debug log for raw message
              logger.debug({
                msg: 'Raw message received',
                data: msg,
              });

              // Extract relevant message information
              const messageInfo: MessageInfo = {
                id: msg.key.id,
                from: msg.key.remoteJid,
                fromMe: msg.key.fromMe,
                timestamp: msg.messageTimestamp,
                type: messageType,
                pushName: msg.pushName,
                content: WhatsAppService.extractMessageContent(msg),
                isGroup: msg.key.remoteJid?.endsWith('@g.us') || false,
              };

              // Debug log for processed message
              logger.debug({
                msg: 'Processed message info',
                data: messageInfo,
              });

              // Persist to store
              try {
                Store.saveMessage(messageInfo);
              } catch (e) {
                errorLogger.error({ msg: 'Failed to persist incoming message', error: (e as Error)?.message || e });
              }

              // Send to webhook
              await WhatsAppService.notifyWebhook('message.received', messageInfo);
              logger.info({
                msg: 'New message processed',
                messageId: messageInfo.id,
                from: messageInfo.from,
                type: messageInfo.type,
                content: messageInfo.content,
                isGroup: messageInfo.isGroup,
                timestamp: new Date(messageInfo.timestamp * 1000).toISOString(),
              });
            }));
          } catch (error: any) {
            errorLogger.error({
              msg: 'Error processing incoming message',
              error: error.message,
            });
            await WhatsAppService.notifyWebhook('error', {
              type: 'message_processing_error',
              error: error.message,
            });
          }
        }
      });

      // Wait for QR code or successful connection
      const qr = await this.waitForQR();

      // If QR code is received
      if (qr) {
        await WhatsAppService.notifyWebhook('connection', { status: 'waiting_qr', qr });
        return {
          success: true,
          status: 'waiting_qr',
          qr,
        };
      }

      // If connection is successful
      if (this.isConnected) {
        return {
          success: true,
          status: 'connected',
          message: 'WhatsApp connection successful',
        };
      }

      // In case of timeout or other issues
      return {
        success: false,
        status: 'error',
        message: 'Failed to get QR code or establish connection',
      };
    } catch (error: any) {
      errorLogger.error({
        msg: 'Error during WhatsApp connection initialization',
        error: error?.message || error,
      });
      await WhatsAppService.notifyWebhook('error', { error: error.message });
      return {
        success: false,
        status: 'error',
        message: 'Failed to initialize WhatsApp connection',
        error: error.message,
      };
    }
  }

  async handleLogout(reason: string = 'normal_logout'): Promise<WhatsAppServiceResult> {
    try {
      // Clean up session files
      await fs.rm(this.sessionPath, { recursive: true, force: true });

      // Reset state
      this.sock = null;
      this.isConnected = false;
      this.qr = null;

      // Notify webhook
      await WhatsAppService.notifyWebhook('connection', {
        status: 'logged_out',
        reason,
      });

      logger.info(`Session files cleaned and session terminated (${reason})`);

      return {
        success: true,
        status: 'logged_out',
        message: 'Session successfully terminated',
        reason,
      };
    } catch (error: any) {
      errorLogger.error({
        msg: 'Error during session cleanup',
        error: error?.message || error,
      });
      return {
        success: false,
        status: 'error',
        message: 'Error occurred while terminating session',
        error: error.message,
      };
    }
  }

  async logout(): Promise<WhatsAppServiceResult> {
    try {
      if (this.sock) {
        await this.sock.logout();
        return await this.handleLogout('user_logout');
      }
      return {
        success: false,
        status: 'error',
        message: 'No active session found',
      };
    } catch (error: any) {
      errorLogger.error({
        msg: 'Error during logout',
        error: error?.message || error,
      });
      return {
        success: false,
        status: 'error',
        message: 'Error occurred while logging out',
        error: error.message,
      };
    }
  }

  static async notifyWebhook(event: string, data: any): Promise<void> {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      logger.warn({
        msg: 'Webhook URL not configured, skipping notification',
      });
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Baileys-API-Webhook',
          'X-Event-Type': event,
        },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      if (!response.ok) {
        throw new Error(`Webhook request failed with status ${response.status}: ${response.statusText}`);
      }

      logger.debug({
        msg: 'Webhook notification sent successfully',
        event,
        status: response.status,
      });
    } catch (error: any) {
      errorLogger.error({
        msg: 'Error during webhook notification',
        event,
        error: error.message,
        data: JSON.stringify(data),
      });
    }
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      isConnected: this.isConnected,
      qr: this.qr,
    };
  }

  async syncChatsFromStore(): Promise<void> {
    try {
      if (!this.sock || !this.sock.store) {
        logger.warn({ msg: 'Cannot sync chats: socket or store not available' });
        return;
      }

      const chats = this.sock.store.chats || new Map();
      const chatsArray = Array.from(chats.values()).filter((chat: any) => chat && chat.id);

      logger.debug({
        msg: 'Syncing chats from store',
        chatCount: chatsArray.length,
        chats: chatsArray.slice(0, 3) // Log first 3 chats
      });

      if (chatsArray.length > 0) {
        Store.upsertChats(chatsArray as Chat[]);
        logger.info({ msg: 'Chats synced from store successfully', count: chatsArray.length });
      } else {
        logger.warn({ msg: 'No chats found in store to sync' });
      }
    } catch (error: any) {
      errorLogger.error({
        msg: 'Failed to sync chats from store',
        error: error?.message || error
      });
    }
  }

  async getConversations(options: any = {}): Promise<any[]> {
    // touch instance field to satisfy eslint class-methods-use-this
    const { isConnected } = this; // eslint-disable-line no-unused-vars
    try {
      const limit = Number(options.limit) || 50;
      const cursor = (options.cursor !== undefined && options.cursor !== null)
        ? Number(options.cursor)
        : null;

      logger.debug({
        msg: 'getConversations called',
        options,
        limit,
        cursor,
        isConnected: this.isConnected
      });

      // First try to sync chats if database is empty
      const existingConversations = Store.listConversations({ limit: 1, cursor: null });
      logger.debug({
        msg: 'Checking database state',
        existingCount: existingConversations.length,
        hasSocket: !!this.sock,
        hasStore: !!(this.sock && this.sock.store)
      });

      if (existingConversations.length === 0 && this.sock) {
        logger.debug({ msg: 'No conversations in database, attempting to sync chats' });
        await this.syncChatsFromStore();
      }

      const conversations = Store.listConversations({ limit, cursor });

      logger.debug({
        msg: 'getConversations result',
        count: conversations.length,
        conversations: conversations.slice(0, 3) // Log first 3 for debugging
      });

      return conversations;
    } catch (error: any) {
      errorLogger.error({
        msg: 'Failed to get conversations',
        error: error?.message || error,
      });
      return [];
    }
  }

  async getMessages(jid: string, options: any = {}): Promise<any[]> {
    try {
      const limit = Number(options.limit) || 50;
      const cursor = (options.cursor !== undefined && options.cursor !== null)
        ? Number(options.cursor)
        : null;
      return Store.listMessages(jid, { limit, cursor });
    } catch (error: any) {
      errorLogger.error({
        msg: 'Failed to get messages',
        error: error?.message || error,
      });
      return [];
    }
  }

  async sendMessage(to: string, message: string): Promise<any> {
    if (!this.isConnected) {
      throw new Error('WhatsApp connection is not active');
    }

    // normalize to JID if a plain phone number was provided
    let jid = String(to || '');
    if (!jid.includes('@')) {
      const digits = jid.replace(/[^\d]/g, '');
      if (digits) {
        jid = `${digits}@s.whatsapp.net`;
      }
    }

    try {
      const result = await this.sock.sendMessage(jid, { text: message });
      logger.info({
        msg: 'Message sent',
        to: jid,
        messageId: result.key.id,
      });

      // Persist outgoing message
      try {
        const timestamp = result.messageTimestamp || Math.floor(Date.now() / 1000);
        const messageInfo: MessageInfo = {
          id: result.key.id,
          from: result.key.remoteJid || jid,
          fromMe: true,
          timestamp,
          type: 'conversation',
          pushName: null,
          content: { type: 'text', text: message },
          isGroup: (jid || '').endsWith('@g.us'),
        };
        Store.saveMessage(messageInfo);
      } catch (e) {
        errorLogger.error({ msg: 'Failed to persist outgoing message', error: (e as Error)?.message || e });
      }

      return result;
    } catch (error: any) {
      errorLogger.error({
        msg: 'Failed to send message',
        error: error.message,
      });
      throw error;
    }
  }

  async checkNumber(phoneNumber: string): Promise<any> {
    if (!this.isConnected) {
      throw new Error('WhatsApp connection is not active');
    }

    try {
      // Check if the number exists on WhatsApp
      const [result] = await this.sock.onWhatsApp(phoneNumber.replace(/[^\d]/g, ''));

      if (result) {
        logger.info({
          msg: 'Phone number check completed',
          phoneNumber,
          exists: true,
          jid: result.jid,
        });
        return {
          exists: true,
          jid: result.jid,
        };
      }

      logger.info({
        msg: 'Phone number check completed',
        phoneNumber,
        exists: false,
      });
      return {
        exists: false,
        jid: null,
      };
    } catch (error: any) {
      errorLogger.error({
        msg: 'Failed to check phone number',
        phoneNumber,
        error: error.message,
      });
      throw error;
    }
  }

  // Change to static method
  static extractMessageContent(msg: any): any {
    if (!msg.message) return null;

    // Get the first message type (text, image, video, etc.)
    const messageType = Object.keys(msg.message)[0];
    const messageContent = msg.message && messageType ? msg.message[messageType] : null;

    switch (messageType) {
      case 'conversation':
        return { type: 'text', text: messageContent };

      case 'extendedTextMessage':
        return {
          type: 'text',
          text: messageContent.text,
          contextInfo: messageContent.contextInfo,
        };

      case 'imageMessage':
        return {
          type: 'image',
          caption: messageContent.caption,
          mimetype: messageContent.mimetype,
        };

      case 'videoMessage':
        return {
          type: 'video',
          caption: messageContent.caption,
          mimetype: messageContent.mimetype,
        };

      case 'audioMessage':
        return {
          type: 'audio',
          mimetype: messageContent.mimetype,
          seconds: messageContent.seconds,
        };

      case 'documentMessage':
        return {
          type: 'document',
          fileName: messageContent.fileName,
          mimetype: messageContent.mimetype,
        };

      case 'stickerMessage':
        return {
          type: 'sticker',
          mimetype: messageContent.mimetype,
        };

      case 'locationMessage':
        return {
          type: 'location',
          degreesLatitude: messageContent.degreesLatitude,
          degreesLongitude: messageContent.degreesLongitude,
          name: messageContent.name,
        };

      case 'contactMessage':
        return {
          type: 'contact',
          displayName: messageContent.displayName,
          vcard: messageContent.vcard,
        };

      case 'protocolMessage':
        // Protocol messages are system messages (acks, receipts, etc.) - no user content
        return null;

      default:
        return {
          type: messageType,
          content: 'Message type not specifically handled',
        };
    }
  }
}

const whatsAppService = new WhatsAppService();
export default whatsAppService;