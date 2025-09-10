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
import crypto from "crypto";
import { logger, errorLogger } from "../utils/logger.js";
import Store from "./prismaStore.js";
import ingestion from "./ingestion.js";
import ConfigStore from "./prismaConfigStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WhatsAppServiceResult {
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

type Username = string;

class TenantSession {
  username: Username;
  sock: any = null;
  isConnected = false;
  qr: string | null = null;
  sessionPath: string;
  connectionUpdateHandler: any = null;
  reconnectAttempts = 0;
  readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(username: Username) {
    this.username = username;
    this.sessionPath = path.join(__dirname, "..", "sessions", username);
  }

  async isSessionValid(): Promise<boolean> {
    try {
      await fs.access(this.sessionPath);
      const credsPath = path.join(this.sessionPath, "creds.json");
      await fs.access(credsPath);
      const credsData = await fs.readFile(credsPath, "utf-8");
      const creds = JSON.parse(credsData);
      if (creds && creds.me && creds.platform) {
        logger.debug({ msg: "Session appears valid", username: this.username });
        return true;
      }
      logger.warn({
        msg: "Session creds.json exists but appears invalid",
        username: this.username,
      });
      return false;
    } catch (error) {
      logger.debug({
        msg: "Session validation failed",
        username: this.username,
        error,
      });
      return false;
    }
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  async waitForQR(timeout: number = 300000): Promise<string | null> {
    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (this.connectionUpdateHandler && this.sock?.ev) {
          this.sock.ev.off("connection.update", this.connectionUpdateHandler);
          this.connectionUpdateHandler = null;
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
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
      try {
        await fs.access(this.sessionPath);
      } catch (error) {
        if (isReconnecting) {
          logger.warn({
            msg: "No session found, cannot reconnect",
            username: this.username,
          });
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
          logger.warn({
            msg: `Maximum reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) exceeded`,
            username: this.username,
          });
          await this.handleLogout("max_attempts_exceeded");
          return await this.initialize(false);
        }
        logger.info({
          msg: "Attempting to reconnect...",
          attempt: `${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`,
          username: this.username,
        } as any);
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
        logger.debug({
          msg: "Connection update received",
          update,
          username: this.username,
        });
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          if (this.isConnected && isReconnecting) {
            logger.info({
              msg: "Connection already active, reconnection cancelled",
              username: this.username,
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
              username: this.username,
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
            username: this.username,
          });

          await TenantManager.notifyWebhook(this.username, "connection", {
            status: "connected",
          });

          try {
            await this.refreshBusinessInfo();
          } catch (e) {
            errorLogger.error({
              msg: "Failed to refresh business info after connect",
              username: this.username,
              error: (e as Error)?.message || e,
            });
          }
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("chats.set", async ({ chats }: any) => {
        try {
          const list = chats || [];
          await Store.upsertChats(list);
        } catch (e) {
          errorLogger.error({
            msg: "Error syncing chats.set",
            error: (e as Error)?.message || e,
            username: this.username,
          });
        }
      });

      this.sock.ev.on("chats.upsert", (payload: any) => {
        try {
          const list = Array.isArray(payload) ? payload : payload?.chats || [];
          if (list.length) {
            Store.upsertChats(list);
          }
        } catch (e) {
          errorLogger.error({
            msg: "Error processing chats.upsert",
            error: (e as Error)?.message || e,
            username: this.username,
          });
        }
      });

      const processHistory = async (history: any) => {
        try {
          const chats = history?.chats || [];
          const contacts = history?.contacts || [];
          const messages = history?.messages || [];

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
                content: TenantManager.extractMessageContent(msg),
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
                      username: this.username,
                    });
                  }
                } catch (e) {
                  errorLogger.error({
                    msg: "Failed to enqueue history message",
                    error: (e as Error)?.message || e,
                    username: this.username,
                  });
                }
              }
            }
          }
        } catch (e) {
          errorLogger.error({
            msg: "Error processing messaging-history",
            error: (e as Error)?.message || e,
            username: this.username,
          });
        }
      };

      this.sock.ev.on("messaging-history.set", processHistory as any);
      this.sock.ev.on("messaging.history-set", processHistory as any);

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
        } catch (e) {
          errorLogger.error({
            msg: "Error processing contacts.set",
            error: (e as Error)?.message || e,
            username: this.username,
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
        } catch (e) {
          errorLogger.error({
            msg: "Error processing contacts.upsert",
            error: (e as Error)?.message || e,
            username: this.username,
          });
        }
      });

      this.sock.ev.on("messages.upsert", async (m: any) => {
        console.log({
          msg: "messages.upsert event triggered",
          type: m.type,
          messageCount: m.messages ? m.messages.length : 0,
          username: this.username,
        });

        if (m.type === "notify") {
          try {
            await Promise.all(
              m.messages.map(async (msg: any) => {
                const messageType = Object.keys(msg.message || {})[0] || "";
                if (messageType === "protocolMessage") return;

                const messageInfo: MessageInfo = {
                  id: msg.key.id,
                  from: msg.key.remoteJid,
                  fromMe: msg.key.fromMe,
                  timestamp: msg.messageTimestamp,
                  type: messageType,
                  pushName: msg.pushName,
                  content: TenantManager.extractMessageContent(msg),
                  isGroup: msg.key.remoteJid?.endsWith("@g.us") || false,
                };

                try {
                  const res = await ingestion.enqueueMessage(messageInfo);
                  logger.info({
                    msg: "Message enqueued successfully",
                    accepted: res.accepted,
                    idempotencyKey: res.idempotencyKey,
                    correlationId: res.correlationId,
                    username: this.username,
                  });
                  if (!res.accepted) {
                    errorLogger.error({
                      msg: "Failed to enqueue incoming message",
                      error: res.reason,
                      idempotencyKey: res.idempotencyKey,
                      correlationId: res.correlationId,
                      username: this.username,
                    });
                  }
                } catch (e) {
                  errorLogger.error({
                    msg: "Failed to enqueue incoming message",
                    error: (e as Error)?.message || e,
                    username: this.username,
                  });
                }

                const businessInfo = await ConfigStore.getBusinessInfo(
                  this.username,
                );
                await TenantManager.notifyWebhook(
                  this.username,
                  "message.received",
                  {
                    message: messageInfo,
                    business: businessInfo,
                  },
                );
              }),
            );
          } catch (error: any) {
            errorLogger.error({
              msg: "Error processing incoming message",
              error: error.message,
              username: this.username,
            });
            await TenantManager.notifyWebhook(this.username, "error", {
              type: "message_processing_error",
              error: error.message,
            });
          }
        }
      });

      const qr = await this.waitForQR();

      if (qr) {
        await TenantManager.notifyWebhook(this.username, "connection", {
          status: "waiting_qr",
          qr,
        });
        return {
          success: true,
          status: "waiting_qr",
          qr,
        };
      }

      if (this.isConnected) {
        return {
          success: true,
          status: "connected",
          message: "WhatsApp connection successful",
        };
      }

      return {
        success: false,
        status: "error",
        message: "Failed to get QR code or establish connection",
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during WhatsApp connection initialization",
        username: this.username,
        error: error?.message || error,
      });
      await TenantManager.notifyWebhook(this.username, "error", {
        error: error.message,
      });
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
      await fs.rm(this.sessionPath, { recursive: true, force: true });
      this.sock = null;
      this.isConnected = false;
      this.qr = null;

      await TenantManager.notifyWebhook(this.username, "connection", {
        status: "logged_out",
        reason,
      });

      logger.info({
        msg: "Session files cleaned and session terminated",
        reason,
        username: this.username,
      });

      return {
        success: true,
        status: "logged_out",
        message: "Session successfully terminated",
        reason,
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during session cleanup",
        username: this.username,
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
        username: this.username,
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

  getConnectionStatus(): ConnectionStatus {
    return {
      isConnected: this.isConnected,
      qr: this.qr,
    };
  }

  async refreshBusinessInfo(): Promise<{
    stored: Awaited<ReturnType<typeof ConfigStore.getBusinessInfo>>;
    fetched: any | null;
    persisted: boolean;
    reason?: string;
  }> {
    try {
      const existing = await ConfigStore.getBusinessInfo(this.username);

      if (!this.sock || !this.isConnected) {
        return {
          stored: existing,
          fetched: null,
          persisted: false,
          reason: "not_connected",
        };
      }

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

      try {
        if (typeof this.sock.getBusinessProfile === "function" && meJid) {
          fetchedProfile = await this.sock.getBusinessProfile(meJid);
        }
      } catch (e) {
        errorLogger.error({
          msg: "getBusinessProfile failed",
          username: this.username,
          error: (e as Error)?.message || e,
        });
      }

      let about: string | null = null;
      try {
        if (typeof this.sock.fetchStatus === "function" && meJid) {
          const s = await this.sock.fetchStatus(meJid);
          about = s?.status || null;
        }
      } catch {
        // ignore
      }

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
          : existing.location_url || null,
        shipping_details: existing.shipping_details || null,
        instagram_url: Array.isArray(fetchedProfile?.connectedAccounts)
          ? fetchedProfile.connectedAccounts.find(
              (a: any) => a?.type?.toLowerCase?.() === "instagram",
            )?.value ||
            existing.instagram_url ||
            null
          : existing.instagram_url || null,
        website_url: (() => {
          const websites =
            fetchedProfile?.websites || fetchedProfile?.website || [];
          if (Array.isArray(websites) && websites.length) return websites[0];
          if (typeof websites === "string" && websites) return websites;
          return existing.website_url || null;
        })(),
        mobile_numbers: (() => {
          const nums = Array.isArray(existing.mobile_numbers)
            ? [...existing.mobile_numbers]
            : [];
          if (meJid && meJid.includes("@")) {
            const base = (meJid ?? "").split("@")[0];
            // Extract only numeric digits from JID
            let digits = (base || "").replace(/[^\d]/g, "");

            // For international numbers, ensure we have a valid length
            // Remove common suffixes that might be added to JIDs
            if (digits.length > 12) {
              // If longer than typical international number, try to extract the main number
              // This handles cases where extra digits are appended
              digits = digits.substring(0, 12); // Keep first 12 digits (country + number)
            }

            // Ensure it's a reasonable phone number length (7-15 digits)
            if (
              digits.length >= 7 &&
              digits.length <= 15 &&
              !nums.includes(digits)
            ) {
              nums.push(digits);
            }
          }
          return nums.length ? nums : (existing.mobile_numbers as any) || null;
        })(),
      };

      await ConfigStore.setBusinessInfo(this.username, {
        name: mapped.name,
        working_hours: mapped.working_hours,
        location_url: mapped.location_url,
        shipping_details: mapped.shipping_details,
        instagram_url: mapped.instagram_url,
        website_url: mapped.website_url,
        mobile_numbers: (mapped as any).mobile_numbers ?? null,
      });

      const updated = await ConfigStore.getBusinessInfo(this.username);

      return {
        stored: updated,
        fetched: fetchedProfile ? { ...fetchedProfile, about } : null,
        persisted: true,
      };
    } catch (e) {
      errorLogger.error({
        msg: "refreshBusinessInfo failed",
        username: this.username,
        error: (e as Error)?.message || e,
      });
      return {
        stored: await ConfigStore.getBusinessInfo(this.username),
        fetched: null,
        persisted: false,
        reason: "exception",
      };
    }
  }

  async sendMessage(to: string, message: string): Promise<any> {
    if (!this.isConnected) {
      throw new Error("WhatsApp connection is not active");
    }

    let jid = String(to || "");
    if (!jid.includes("@")) {
      const digits = jid.replace(/[^\d]/g, "");
      if (digits) {
        jid = `${digits}@s.whatsapp.net`;
      }
    }

    try {
      const result = await this.sock.sendMessage(jid, { text: message });
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
            username: this.username,
          });
        }
      } catch (e) {
        errorLogger.error({
          msg: "Failed to persist outgoing message",
          error: (e as Error)?.message || e,
          username: this.username,
        });
      }

      return result;
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to send message",
        error: error.message,
        username: this.username,
      });
      throw error;
    }
  }

  async checkNumber(phoneNumber: string): Promise<any> {
    if (!this.isConnected) {
      throw new Error("WhatsApp connection is not active");
    }

    try {
      const [result] = await this.sock.onWhatsApp(
        phoneNumber.replace(/[^\d]/g, ""),
      );
      if (result) {
        return {
          exists: true,
          jid: result.jid,
        };
      }
      return {
        exists: false,
        jid: null,
      };
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to check phone number",
        phoneNumber,
        error: error.message,
        username: this.username,
      });
      throw error;
    }
  }
}

class TenantManager {
  private sessions = new Map<Username, TenantSession>();
  private sessionsBasePath = path.join(__dirname, "..", "sessions");

  private getOrCreate(username: Username): TenantSession {
    let s = this.sessions.get(username);
    if (!s) {
      s = new TenantSession(username);
      this.sessions.set(username, s);
    }
    return s;
  }

  async initialize(username: Username): Promise<WhatsAppServiceResult> {
    return this.getOrCreate(username).initialize();
  }

  async logout(username: Username): Promise<WhatsAppServiceResult> {
    const s = this.getOrCreate(username);
    return s.logout();
  }

  getConnectionStatus(username: Username): ConnectionStatus {
    return this.getOrCreate(username).getConnectionStatus();
  }

  async isSessionValid(username: Username): Promise<boolean> {
    return this.getOrCreate(username).isSessionValid();
  }

  async sendMessage(
    username: Username,
    to: string,
    message: string,
  ): Promise<any> {
    return this.getOrCreate(username).sendMessage(to, message);
  }

  async checkNumber(username: Username, phoneNumber: string): Promise<any> {
    return this.getOrCreate(username).checkNumber(phoneNumber);
  }

  async refreshBusinessInfo(username: Username) {
    return this.getOrCreate(username).refreshBusinessInfo();
  }

  // Discover available tenant sessions by scanning sessions directory
  async listAvailableTenantIds(): Promise<Username[]> {
    try {
      const entries = await fs.readdir(this.sessionsBasePath, {
        withFileTypes: true,
      } as any);
      const dirs = entries
        .filter((e: any) => e.isDirectory?.() || e.isDirectory)
        .map((e: any) => e.name);
      const candidates: Username[] = [];
      for (const dir of dirs) {
        try {
          // consider a valid candidate if creds.json exists
          const credsPath = path.join(this.sessionsBasePath, dir, "creds.json");
          await fs.access(credsPath);
          candidates.push(dir);
        } catch {
          // ignore non-session folders
        }
      }
      return candidates;
    } catch {
      return [];
    }
  }

  // Auto-connect to all discovered sessions on startup
  async autoConnectAll(): Promise<void> {
    try {
      const tenantIds = await this.listAvailableTenantIds();
      if (!tenantIds.length) {
        logger.info({ msg: "No existing sessions found for auto-connect" });
        return;
      }

      logger.info({
        msg: "Auto-connecting sessions on startup",
        count: tenantIds.length,
        tenants: tenantIds,
      });

      for (const tenantId of tenantIds) {
        try {
          const valid = await this.isSessionValid(tenantId);
          if (!valid) {
            logger.warn({
              msg: "Skipping auto-connect: session invalid",
              tenantId,
            });
            continue;
          }
          const res = await this.initialize(tenantId);
          logger.info({
            msg: "Auto-connect attempt finished",
            tenantId,
            status: res.status,
            success: res.success,
          });
        } catch (e: any) {
          errorLogger.error({
            msg: "Auto-connect failed for tenant",
            tenantId,
            error: (e as Error)?.message || e,
          });
        }
      }
    } catch (e: any) {
      errorLogger.error({
        msg: "Auto-connect routine encountered an error",
        error: (e as Error)?.message || e,
      });
    }
  }

  static async notifyWebhook(
    username: Username,
    event: string,
    data: any,
  ): Promise<void> {
    try {
      const webhooks = await ConfigStore.getWebhooks(username);
      const activeWebhooks = webhooks.filter((w) => w.isActive);

      console.log(
        "Checking webhooks for user:",
        username,
        "event:",
        event,
        "active webhooks:",
        activeWebhooks.length,
      );

      if (activeWebhooks.length === 0) {
        console.log(
          "No active webhooks configured, skipping notification for event:",
          event,
          "username:",
          username,
        );
        return;
      }

      // Send notifications to all active webhooks asynchronously
      const notificationPromises = activeWebhooks.map(async (webhook) => {
        console.log(
          "Sending webhook notification for event:",
          event,
          "to URL:",
          webhook.url,
          "name:",
          webhook.name || "unnamed",
        );

        try {
          const payload = JSON.stringify({
            event,
            username,
            timestamp: new Date().toISOString(),
            data,
            webhook: {
              id: webhook.id,
              name: webhook.name,
              url: webhook.url,
            },
          });

          // Generate HMAC signature using webhook secret
          const signature = crypto
            .createHmac('sha256', webhook.secret || '')
            .update(payload)
            .digest('hex');

          const response = await fetch(webhook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Baileys-API-Webhook",
              "X-Event-Type": event,
              "X-Username": username,
              "X-Webhook-Id": webhook.id || "",
              "X-Webhook-Name": webhook.name || "",
              "X-Signature": `sha256=${signature}`,
            },
            body: payload,
          });

          if (!response.ok) {
            console.log(
              "Webhook request failed for",
              webhook.url,
              "status:",
              response.status,
              response.statusText,
            );
            throw new Error(
              `Webhook request failed with status ${response.status}: ${response.statusText}`,
            );
          }

          console.log(
            "Webhook notification sent successfully for event:",
            event,
            "to:",
            webhook.url,
            "status:",
            response.status,
          );
        } catch (error: any) {
          console.log(
            "Error during webhook notification:",
            event,
            "username:",
            username,
            "webhook:",
            webhook.url,
            "error:",
            error.message,
          );
          // Don't throw error to avoid failing other webhooks
        }
      });

      // Wait for all notifications to complete (but don't fail if some fail)
      await Promise.allSettled(notificationPromises);
    } catch (error: any) {
      console.log(
        "Error getting webhooks for notification:",
        event,
        "username:",
        username,
        "error:",
        error.message,
      );
    }
  }

  static extractMessageContent(msg: any): any {
    if (!msg.message) return null;
    const messageType = Object.keys(msg.message)[0];
    const messageContent = messageType ? msg.message[messageType] : null;

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
        return null;
      default:
        return {
          type: messageType,
          content: "Message type not specifically handled",
        };
    }
  }
}

const waManager = new TenantManager();
export default waManager;
