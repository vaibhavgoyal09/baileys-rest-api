import {
  default as makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import { fileURLToPath } from "url";
import { pino } from "pino";
import fs from "fs/promises";
import { logger, errorLogger } from "../utils/logger.js";
import Store, { Chat } from "./prismaStore.js";
import ingestion from "./ingestion.js";
import ConfigStore from "./prismaConfigStore.js";

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
    this.sessionPath = path.join(__dirname, "../sessions");
  }

  async isSessionValid(): Promise<boolean> {
    try {
      // Check if session directory exists
      await fs.access(this.sessionPath);

      // Check if creds.json exists (main auth file)
      const credsPath = path.join(this.sessionPath, "creds.json");
      await fs.access(credsPath);

      // Try to read and parse creds.json to ensure it's valid
      const credsData = await fs.readFile(credsPath, "utf-8");
      const creds = JSON.parse(credsData);

      // Basic validation: check if it has essential fields
      if (creds && creds.me && creds.platform) {
        logger.debug("Session appears valid");
        return true;
      }

      logger.warn("Session creds.json exists but appears invalid");
      return false;
    } catch (error) {
      logger.debug("Session validation failed:", error);
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
          this.sock.ev.off("connection.update", this.connectionUpdateHandler);
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
          } else if (connection === "open") {
            cleanup();
            resolve(null);
          }
        };

        this.sock.ev.on("connection.update", this.connectionUpdateHandler);
      } else {
        cleanup();
        resolve(null);
      }
    });
  }

  async initialize(
    isReconnecting: boolean = false,
  ): Promise<WhatsAppServiceResult> {
    try {
      // Check if session directory exists
      try {
        await fs.access(this.sessionPath);
      } catch (error) {
        if (isReconnecting) {
          logger.warn("No session found, cannot reconnect");
          return {
            success: false,
            status: "error",
            message: "No session found, cannot reconnect",
          };
        }
      }

      if (isReconnecting) {
        this.reconnectAttempts += 1;
        if (this.reconnectAttempts > this.MAX_RECONNECT_ATTEMPTS) {
          logger.warn(
            `Maximum reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) exceeded`,
          );
          await this.handleLogout("max_attempts_exceeded");
          return await this.initialize(false);
        }
        logger.info(
          `Attempting to reconnect... (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`,
        );
      } else {
        this.resetReconnectAttempts();
      }

      const { state, saveCreds } = await useMultiFileAuthState(
        this.sessionPath,
      );

      this.sock = makeWASocket({
        auth: state,
        browser: Browsers.macOS("Desktop"),
        syncFullHistory: true,
        logger: pino({ level: "silent" }),
      });
      this.sock.ev.on("connection.update", async (update: any) => {
        logger.debug({ msg: "Connection update received", update });
        if (update.qr) {
          console.log("QR Code received:", update.qr);
        }
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          // If already connected and trying to reconnect, cancel the operation
          if (this.isConnected && isReconnecting) {
            logger.info({
              msg: "Connection already active, reconnection cancelled",
            });
            return;
          }

          const statusCode =
            lastDisconnect?.error instanceof Boom
              ? (lastDisconnect.error as any).output?.statusCode
              : undefined;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && !this.isConnected) {
            await this.initialize(true);
          } else if (!shouldReconnect) {
            logger.info({
              msg: "Session terminated",
            });
            await this.handleLogout("connection_closed");
            await this.initialize(false);
          }
        } else if (connection === "open") {
          this.isConnected = true;
          this.qr = null;
          this.resetReconnectAttempts();
          logger.info({
            msg: "WhatsApp connection successful!",
          });
          await WhatsAppService.notifyWebhook("connection", {
            status: "connected",
          });

          // Attempt to refresh business info on successful connection
          try {
            await this.refreshBusinessInfo();
          } catch (e) {
            errorLogger.error({
              msg: "Failed to refresh business info after connect",
              error: (e as Error)?.message || e,
            });
          }

          // on reconnect, explicitly backfill message history for chats
          if (isReconnecting) {
            try {
              await this.syncHistoryOnReconnect();
            } catch (e) {
              errorLogger.error({
                msg: "Error during manual history sync on reconnect",
                error: (e as Error)?.message || e,
              });
            }
          }

          // hydrate SQLite from in-memory store immediately and once again after a short delay
          // try {
          //   await this.syncChatsFromStore();
          //   setTimeout(() => {
          //     this.syncChatsFromStore().catch(() => {});
          //   }, 3000);
          // } catch {}
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      // removed duplicate empty handler for messaging-history.set (handled below with processHistory)

      this.sock.ev.on("chats.set", async ({ chats }: any) => {
        try {
          const list = chats || [];
          logger.debug({
            msg: "chats.set event fired",
            count: list.length,
            chats: list.slice(0, 3), // Log first 3 chats for debugging
          });
          await Store.upsertChats(list);
          logger.debug({
            msg: "Chats set synced successfully",
            count: list.length,
          });
        } catch (e) {
          errorLogger.error({
            msg: "Error syncing chats.set",
            error: (e as Error)?.message || e,
          });
        }
      });

      // also handle chats.upsert to catch subsequent updates or when initial set isn't emitted
      this.sock.ev.on("chats.upsert", async (payload: any) => {
        try {
          const list = Array.isArray(payload) ? payload : payload?.chats || [];
          const arr = list || [];
          logger.debug({
            msg: "chats.upsert event fired",
            count: arr.length,
            chats: arr.slice(0, 3),
          });
          if (arr.length) {
            await Store.upsertChats(arr);
            logger.debug({ msg: "Chats upsert processed", count: arr.length });
          }
        } catch (e) {
          errorLogger.error({
            msg: "Error processing chats.upsert",
            error: (e as Error)?.message || e,
          });
        }
      });

      // process full sync history to populate chats, contacts and messages at first connection and on reconnect
      const processHistory = async (history: any) => {
        try {
          const chats = history?.chats || [];
          const contacts = history?.contacts || [];
          const messages = history?.messages || [];

          logger.debug({
            msg: "messaging-history received",
            chats: chats.length,
            contacts: contacts.length,
            messages: messages.length,
          });

          if (chats.length) {
            await Store.upsertChats(chats);
          }

          if (contacts.length) {
            for (const c of contacts) {
              const jid = c.id || c.jid;
              if (!jid) continue;
              const name = c.name || c.notify || c.pushName || null;
              await Store.upsertChatPartial(jid, { name });
            }
          }

          if (messages.length) {
            for (const msg of messages) {
              const messageType = Object.keys(msg.message || {})[0] || "";
              if (messageType === "protocolMessage") continue;

              const info: MessageInfo = {
                id: msg.key?.id,
                from: msg.key?.remoteJid,
                fromMe: !!msg.key?.fromMe,
                timestamp:
                  Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
                type: messageType,
                pushName: msg.pushName || null,
                content: WhatsAppService.extractMessageContent(msg),
                isGroup: (msg.key?.remoteJid || "").endsWith("@g.us"),
              };

              if (info.id && info.from) {
                try {
                  const res = await ingestion.enqueueMessage(info);
                  if (!res.accepted) {
                    errorLogger.error({
                      msg: "Failed to enqueue history message",
                      error: res.reason,
                      idempotencyKey: res.idempotencyKey,
                      correlationId: res.correlationId,
                    });
                  }
                } catch (e) {
                  errorLogger.error({
                    msg: "Failed to enqueue history message",
                    error: (e as Error)?.message || e,
                  });
                }
              }
            }
          }

          logger.info({
            msg: "messaging-history processed",
            chats: chats.length,
            contacts: contacts.length,
            messages: messages.length,
          });
        } catch (e) {
          errorLogger.error({
            msg: "Error processing messaging-history",
            error: (e as Error)?.message || e,
          });
        }
      };

      // attach to both possible event names across versions
      this.sock.ev.on("messaging-history.set", processHistory as any);
      this.sock.ev.on("messaging.history-set", processHistory as any);

      // also backfill contacts when set in bulk (some versions emit contacts.set once)
      this.sock.ev.on("contacts.set", async (contacts: any) => {
        try {
          const list = Array.isArray(contacts)
            ? contacts
            : contacts?.contacts || [];
          for (const c of list || []) {
            const jid = c.id || c.jid;
            if (!jid) continue;
            const name = c.name || c.notify || c.pushName || null;
            await Store.upsertChatPartial(jid, { name });
          }
          logger.debug({
            msg: "contacts.set processed",
            count: (list || []).length,
          });
        } catch (e) {
          errorLogger.error({
            msg: "Error processing contacts.set",
            error: (e as Error)?.message || e,
          });
        }
      });

      this.sock.ev.on("contacts.upsert", async (contacts: any) => {
        try {
          for (const c of contacts || []) {
            const jid = c.id || c.jid;
            if (!jid) continue;
            const name = c.name || c.notify || c.pushName || null;
            await Store.upsertChatPartial(jid, { name });
          }
          logger.debug({
            msg: "Contacts upsert processed",
            count: (contacts || []).length,
          });
        } catch (e) {
          errorLogger.error({
            msg: "Error processing contacts.upsert",
            error: (e as Error)?.message || e,
          });
        }
      });

      this.sock.ev.on("messages.upsert", async (m: any) => {
        logger.info({
          msg: "messages.upsert event triggered",
          type: m.type,
          messageCount: m.messages ? m.messages.length : 0,
        });

        if (m.type === "notify") {
          try {
            await Promise.all(
              m.messages.map(async (msg: any) => {
                // Skip protocol messages as they are system messages
                const messageType = Object.keys(msg.message || {})[0] || "";
                if (messageType === "protocolMessage") {
                  return;
                }

                // Debug log for raw message
                console.log({
                  msg: "Raw message received",
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
                  isGroup: msg.key.remoteJid?.endsWith("@g.us") || false,
                };

                // Debug log for processed message
                logger.debug({
                  msg: "Processed message info",
                  data: messageInfo,
                });

                // Enqueue to ingestion service
                try {
                  const res = await ingestion.enqueueMessage(messageInfo);
                  logger.info({
                    msg: "Message enqueued successfully",
                    accepted: res.accepted,
                    idempotencyKey: res.idempotencyKey,
                    correlationId: res.correlationId,
                  });
                  if (!res.accepted) {
                    errorLogger.error({
                      msg: "Failed to enqueue incoming message",
                      error: res.reason,
                      idempotencyKey: res.idempotencyKey,
                      correlationId: res.correlationId,
                    });
                  }
                } catch (e) {
                  errorLogger.error({
                    msg: "Failed to enqueue incoming message",
                    error: (e as Error)?.message || e,
                  });
                }

                // Send to webhook with business details
                const businessInfo = await Store.getBusinessInfo();
                await WhatsAppService.notifyWebhook("message.received", {
                  message: messageInfo,
                  business: businessInfo,
                }, "default"); // Use "default" username for now
                logger.info({
                  msg: "New message processed",
                  messageId: messageInfo.id,
                  from: messageInfo.from,
                  type: messageInfo.type,
                  content: messageInfo.content,
                  isGroup: messageInfo.isGroup,
                  timestamp: new Date(
                    messageInfo.timestamp * 1000,
                  ).toISOString(),
                });
              }),
            );
          } catch (error: any) {
            errorLogger.error({
              msg: "Error processing incoming message",
              error: error.message,
            });
            await WhatsAppService.notifyWebhook("error", {
              type: "message_processing_error",
              error: error.message,
            });
          }
        }
      });

      // Wait for QR code or successful connection
      const qr = await this.waitForQR();

      // If QR code is received
      if (qr) {
        await WhatsAppService.notifyWebhook("connection", {
          status: "waiting_qr",
          qr,
        });
        return {
          success: true,
          status: "waiting_qr",
          qr,
        };
      }

      // If connection is successful
      if (this.isConnected) {
        return {
          success: true,
          status: "connected",
          message: "WhatsApp connection successful",
        };
      }

      // In case of timeout or other issues
      return {
        success: false,
        status: "error",
        message: "Failed to get QR code or establish connection",
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during WhatsApp connection initialization",
        error: error?.message || error,
      });
      await WhatsAppService.notifyWebhook("error", { error: error.message });
      return {
        success: false,
        status: "error",
        message: "Failed to initialize WhatsApp connection",
        error: error.message,
      };
    }
  }

  async handleLogout(
    reason: string = "normal_logout",
  ): Promise<WhatsAppServiceResult> {
    try {
      // Clean up session files
      await fs.rm(this.sessionPath, { recursive: true, force: true });

      // Reset state
      this.sock = null;
      this.isConnected = false;
      this.qr = null;

      // Notify webhook
      await WhatsAppService.notifyWebhook("connection", {
        status: "logged_out",
        reason,
      });

      logger.info(`Session files cleaned and session terminated (${reason})`);

      return {
        success: true,
        status: "logged_out",
        message: "Session successfully terminated",
        reason,
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during session cleanup",
        error: error?.message || error,
      });
      return {
        success: false,
        status: "error",
        message: "Error occurred while terminating session",
        error: error.message,
      };
    }
  }

  async logout(): Promise<WhatsAppServiceResult> {
    try {
      if (this.sock) {
        await this.sock.logout();
        return await this.handleLogout("user_logout");
      }
      return {
        success: false,
        status: "error",
        message: "No active session found",
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during logout",
        error: error?.message || error,
      });
      return {
        success: false,
        status: "error",
        message: "Error occurred while logging out",
        error: error.message,
      };
    }
  }

  static async notifyWebhook(event: string, data: any, username?: string): Promise<void> {
    const webhookUrl = await ConfigStore.getWebhookUrl("default");
    if (!webhookUrl) {
      logger.warn({
        msg: "Webhook URL not configured, skipping notification",
      });
      return;
    }

    // Check if this is a message event and if the sender is excluded
    if (event === "message.received" && data?.message?.from && username) {
      const senderNumber = WhatsAppService.extractPhoneNumber(data.message.from);
      if (senderNumber) {
        const isExcluded = await ConfigStore.isNumberExcluded(username, senderNumber);
        if (isExcluded) {
          logger.debug({
            msg: "Skipping webhook for excluded number",
            phoneNumber: senderNumber,
            username,
            messageId: data.message.id,
          });
          return;
        }
      }
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Baileys-API-Webhook",
          "X-Event-Type": event,
        },
        body: JSON.stringify({
          event,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Webhook request failed with status ${response.status}: ${response.statusText}`,
        );
      }

      logger.debug({
        msg: "Webhook notification sent successfully",
        event,
        status: response.status,
      });
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during webhook notification",
        event,
        error: error.message,
        data: JSON.stringify(data),
      });
    }
  }

  // Helper method to extract phone number from JID
  private static extractPhoneNumber(jid: string): string | null {
    if (!jid) return null;
    
    // Remove @s.whatsapp.net or @g.us suffix
    const parts = jid.split('@');
    const cleanJid = parts[0];
    if (!cleanJid) return null;
    
    // Remove any non-digit characters and ensure it starts with +
    const digits = cleanJid.replace(/[^\d]/g, '');
    if (!digits) return null;
    
    // Return in international format (assuming numbers are stored with country code)
    return `+${digits}`;
  }

  getConnectionStatus(): ConnectionStatus {
    return {
      isConnected: this.isConnected,
      qr: this.qr,
    };
  }

  /**
   * Attempt to fetch business info from Baileys/WhatsApp if available and persist it.
   * Falls back gracefully if running on a non-business account or API not available.
   */
  async refreshBusinessInfo(): Promise<{
    stored: Awaited<ReturnType<typeof Store.getBusinessInfo>>;
    fetched: any | null;
    persisted: boolean;
    reason?: string;
  }> {
    try {
      // read existing
      const existing = await Store.getBusinessInfo();

      if (!this.sock || !this.isConnected) {
        // no active connection, just return what we have
        return {
          stored: existing,
          fetched: null,
          persisted: false,
          reason: "not_connected",
        };
      }

      // Try to determine self JID and name
      const meJid: string | null =
        (this.sock.user && (this.sock.user.id || this.sock.user.jid)) ||
        (this.sock.authState &&
          this.sock.authState.creds &&
          this.sock.authState.creds.me &&
          (this.sock.authState.creds.me.id ||
            this.sock.authState.creds.me.jid)) ||
        null;

      const meName: string | null =
        (this.sock.user && (this.sock.user.name || this.sock.user.pushName)) ||
        (this.sock.authState &&
          this.sock.authState.creds &&
          this.sock.authState.creds.me &&
          (this.sock.authState.creds.me.name ||
            this.sock.authState.creds.me.pushName)) ||
        null;

      let fetchedProfile: any | null = null;

      // Baileys business profile API (some versions support getBusinessProfile)
      try {
        if (typeof this.sock.getBusinessProfile === "function" && meJid) {
          fetchedProfile = await this.sock.getBusinessProfile(meJid);
        }
      } catch (e) {
        // ignore if not available
        errorLogger.error({
          msg: "getBusinessProfile failed",
          error: (e as Error)?.message || e,
        });
      }

      // Also try to fetch "about" / status text if available (not strictly business)
      let about: string | null = null;
      try {
        if (typeof this.sock.fetchStatus === "function" && meJid) {
          const s = await this.sock.fetchStatus(meJid);
          about = s?.status || null;
        }
      } catch {
        // ignore
      }

      // Map fields we care about
      // Many of these may not be available; map best-effort from fetchedProfile
      const mapped = {
        name:
          meName ||
          fetchedProfile?.title ||
          fetchedProfile?.businessName ||
          existing.name ||
          null,
        working_hours: fetchedProfile?.businessHours
          ? JSON.stringify(fetchedProfile.businessHours)
          : existing.working_hours || null,
        location_url: fetchedProfile?.address
          ? null
          : existing.location_url || null, // no direct URL; could be composed externally
        shipping_details: existing.shipping_details || null, // not available via WA — keep existing
        instagram_url: Array.isArray(fetchedProfile?.connectedAccounts)
          ? fetchedProfile.connectedAccounts.find(
              (a: any) => a?.type?.toLowerCase?.() === "instagram",
            )?.value ||
            existing.instagram_url ||
            null
          : existing.instagram_url || null,
        website_url: (() => {
          // Some versions expose websites array
          const websites =
            fetchedProfile?.websites || fetchedProfile?.website || [];
          if (Array.isArray(websites) && websites.length) return websites[0];
          if (typeof websites === "string" && websites) return websites;
          return existing.website_url || null;
        })(),
        mobile_numbers: (() => {
          // We know our own number; we can add it if derivable from JID
          const nums = Array.isArray(existing.mobile_numbers)
            ? [...existing.mobile_numbers]
            : [];
          if (meJid && meJid.includes("@")) {
            const base = (meJid ?? "").split("@")[0];
            const digits = (base || "").replace(/[^\d]/g, "");
            if (digits && !nums.includes(digits)) nums.push(digits);
          }
          return nums.length ? nums : existing.mobile_numbers || null;
        })(),
      };

      // If we fetched nothing meaningful, still persist name/about improvements if any
      await Store.setBusinessInfo({
        name: mapped.name,
        working_hours: mapped.working_hours,
        location_url: mapped.location_url,
        shipping_details: mapped.shipping_details,
        instagram_url: mapped.instagram_url,
        website_url: mapped.website_url,
        mobile_numbers: mapped.mobile_numbers ?? null,
      });

      const updated = await Store.getBusinessInfo();

      return {
        stored: updated,
        fetched: fetchedProfile ? { ...fetchedProfile, about } : null,
        persisted: true,
      };
    } catch (e) {
      errorLogger.error({
        msg: "refreshBusinessInfo failed",
        error: (e as Error)?.message || e,
      });
      return {
        stored: await Store.getBusinessInfo(),
        fetched: null,
        persisted: false,
        reason: "exception",
      };
    }
  }

  async getConversations(options: any = {}): Promise<any[]> {
    // touch instance field to satisfy eslint class-methods-use-this
    const { isConnected } = this; // eslint-disable-line no-unused-vars
    try {
      const limit = Number(options.limit) || 50;
      const cursor =
        options.cursor !== undefined && options.cursor !== null
          ? Number(options.cursor)
          : null;

      logger.debug({
        msg: "getConversations called",
        options,
        limit,
        cursor,
        isConnected: this.isConnected,
      });

      // First try to sync chats if database is empty
      const existingConversations = await Store.listConversations({
        limit: 1,
        cursor: null,
      });
      logger.debug({
        msg: "Checking database state",
        existingCount: existingConversations.length,
        hasSocket: !!this.sock,
        hasStore: !!(this.sock && this.sock.store),
      });

      if (existingConversations.length === 0 && this.sock) {
        logger.debug({
          msg: "No conversations in database, attempting to sync chats",
        });
        // await this.syncChatsFromStore();
      }

      const conversations = await Store.listConversations({ limit, cursor });

      logger.debug({
        msg: "getConversations result",
        count: conversations.length,
        conversations: conversations.slice(0, 3), // Log first 3 for debugging
      });

      return conversations;
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to get conversations",
        error: error?.message || error,
      });
      return [];
    }
  }

  async getMessages(jid: string, options: any = {}): Promise<any[]> {
    try {
      const limit = Number(options.limit) || 50;
      const cursor =
        options.cursor !== undefined && options.cursor !== null
          ? Number(options.cursor)
          : null;
      return await Store.listMessages(jid, { limit, cursor });
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to get messages",
        error: error?.message || error,
      });
      return [];
    }
  }

  // small helper to pause between paginated fetches
  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // paginate older history for a single chat using fetchMessageHistory (<=50 per page)
  private async syncHistoryForChat(
    jid: string,
    maxPages = 6,
    batch = 50,
  ): Promise<void> {
    try {
      let page = 0;
      // we require an oldest anchor to go further back in history
      let anchor = await Store.getOldestMessageAnchor(jid);
      if (!anchor) {
        logger.debug({
          msg: "No local messages to anchor history backfill, skipping chat",
          jid,
        });
        return;
      }

      let prevOldestId = anchor.key.id;

      while (anchor && page < maxPages) {
        logger.info({
          msg: "Fetching older history page",
          jid,
          page: page + 1,
          batch,
          anchorId: anchor.key.id,
          anchorTs: anchor.messageTimestamp,
        });

        try {
          // messages will arrive via `messaging.history-set` and be persisted by our handler
          await this.sock.fetchMessageHistory(
            batch,
            anchor.key,
            anchor.messageTimestamp,
          );
        } catch (e) {
          errorLogger.error({
            msg: "fetchMessageHistory failed",
            jid,
            page,
            error: (e as Error)?.message || e,
          });
          break;
        }

        // wait a bit for events to arrive & persist
        await this.delay(500);

        // compute new oldest anchor after persist
        const newAnchor = await Store.getOldestMessageAnchor(jid);
        if (!newAnchor) {
          logger.debug({
            msg: "No more messages after fetch, stopping backfill",
            jid,
            page,
          });
          break;
        }

        if (newAnchor.key.id === prevOldestId) {
          // did not move further back => nothing older (or rate limited)
          logger.debug({
            msg: "Oldest anchor unchanged after fetch, stopping",
            jid,
            page,
            anchorId: prevOldestId,
          });
          break;
        }

        prevOldestId = newAnchor.key.id;
        anchor = newAnchor;
        page += 1;
      }

      logger.info({
        msg: "Completed backfill for chat",
        jid,
        pagesFetched: page,
      });
    } catch (e) {
      errorLogger.error({
        msg: "syncHistoryForChat error",
        jid,
        error: (e as Error)?.message || e,
      });
    }
  }

  // trigger history backfill for many chats on reconnect
  async syncHistoryOnReconnect(): Promise<void> {
    if (!this.sock || !this.isConnected) {
      logger.warn("Cannot sync history on reconnect: socket not connected");
      return;
    }
    try {
      const conversations =
        (await Store.listConversations({ limit: 1000, cursor: null })) || [];
      logger.info({
        msg: "Starting history backfill on reconnect",
        chatCount: conversations.length,
      });

      // sequential to avoid flooding
      for (const conv of conversations) {
        const jid = conv?.jid;
        if (!jid) continue;
        await this.syncHistoryForChat(jid, 6, 50);
        // small pause between chats
        await this.delay(200);
      }

      logger.info({
        msg: "History backfill on reconnect completed",
      });
    } catch (e) {
      errorLogger.error({
        msg: "syncHistoryOnReconnect failed",
        error: (e as Error)?.message || e,
      });
    }
  }

  async sendMessage(to: string, message: string): Promise<any> {
    if (!this.isConnected) {
      throw new Error("WhatsApp connection is not active");
    }

    // normalize to JID if a plain phone number was provided
    let jid = String(to || "");
    if (!jid.includes("@")) {
      const digits = jid.replace(/[^\d]/g, "");
      if (digits) {
        jid = `${digits}@s.whatsapp.net`;
      }
    }

    try {
      const result = await this.sock.sendMessage(jid, { text: message });
      logger.info({
        msg: "Message sent",
        to: jid,
        messageId: result.key.id,
      });

      // Persist outgoing message
      try {
        const timestamp =
          result.messageTimestamp || Math.floor(Date.now() / 1000);
        const messageInfo: MessageInfo = {
          id: result.key.id,
          from: result.key.remoteJid || jid,
          fromMe: true,
          timestamp,
          type: "conversation",
          pushName: null,
          content: { type: "text", text: message },
          isGroup: (jid || "").endsWith("@g.us"),
        };
        const res = await ingestion.enqueueMessage(messageInfo);
        if (!res.accepted) {
          errorLogger.error({
            msg: "Failed to enqueue outgoing message",
            error: res.reason,
            idempotencyKey: res.idempotencyKey,
            correlationId: res.correlationId,
          });
        }
      } catch (e) {
        errorLogger.error({
          msg: "Failed to persist outgoing message",
          error: (e as Error)?.message || e,
        });
      }

      return result;
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to send message",
        error: error.message,
      });
      throw error;
    }
  }

  async checkNumber(phoneNumber: string): Promise<any> {
    if (!this.isConnected) {
      throw new Error("WhatsApp connection is not active");
    }

    try {
      // Check if the number exists on WhatsApp
      const [result] = await this.sock.onWhatsApp(
        phoneNumber.replace(/[^\d]/g, ""),
      );

      if (result) {
        logger.info({
          msg: "Phone number check completed",
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
        msg: "Phone number check completed",
        phoneNumber,
        exists: false,
      });
      return {
        exists: false,
        jid: null,
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to check phone number",
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
    const messageContent =
      msg.message && messageType ? msg.message[messageType] : null;

    switch (messageType) {
      case "conversation":
        return { type: "text", text: messageContent ?? "" };

      case "extendedTextMessage":
        return {
          type: "text",
          text: messageContent?.text || "",
          contextInfo: messageContent?.contextInfo || null,
        };

      case "imageMessage":
        return {
          type: "image",
          caption: messageContent.caption,
          mimetype: messageContent.mimetype,
        };

      case "videoMessage":
        return {
          type: "video",
          caption: messageContent.caption,
          mimetype: messageContent.mimetype,
        };

      case "audioMessage":
        return {
          type: "audio",
          mimetype: messageContent.mimetype,
          seconds: messageContent.seconds,
        };

      case "documentMessage":
        return {
          type: "document",
          fileName: messageContent.fileName,
          mimetype: messageContent.mimetype,
        };

      case "stickerMessage":
        return {
          type: "sticker",
          mimetype: messageContent.mimetype,
        };

      case "locationMessage":
        return {
          type: "location",
          degreesLatitude: messageContent.degreesLatitude,
          degreesLongitude: messageContent.degreesLongitude,
          name: messageContent.name,
        };

      case "contactMessage":
        return {
          type: "contact",
          displayName: messageContent.displayName,
          vcard: messageContent.vcard,
        };

      case "protocolMessage":
        // Protocol messages are system messages (acks, receipts, etc.) - no user content
        return null;

      default:
        return {
          type: messageType,
          content: "Message type not specifically handled",
        };
    }
  }
}

const whatsAppService = new WhatsAppService();
export default whatsAppService;
