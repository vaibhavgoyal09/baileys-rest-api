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
import Store from "./sqliteStore.js";
import ingestion from "./ingestion.js";
import ConfigStore from "./configStore.js";

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

type TenantId = string;

class TenantSession {
  tenantId: TenantId;
  sock: any = null;
  isConnected = false;
  qr: string | null = null;
  sessionPath: string;
  connectionUpdateHandler: any = null;
  reconnectAttempts = 0;
  readonly MAX_RECONNECT_ATTEMPTS = 5;

  constructor(tenantId: TenantId) {
    this.tenantId = tenantId;
    this.sessionPath = path.join(__dirname, "..", "sessions", tenantId);
  }

  async isSessionValid(): Promise<boolean> {
    try {
      await fs.access(this.sessionPath);
      const credsPath = path.join(this.sessionPath, "creds.json");
      await fs.access(credsPath);
      const credsData = await fs.readFile(credsPath, "utf-8");
      const creds = JSON.parse(credsData);
      if (creds && creds.me && creds.platform) {
        logger.debug({ msg: "Session appears valid", tenantId: this.tenantId });
        return true;
      }
      logger.warn({
        msg: "Session creds.json exists but appears invalid",
        tenantId: this.tenantId,
      });
      return false;
    } catch (error) {
      logger.debug({
        msg: "Session validation failed",
        tenantId: this.tenantId,
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
            tenantId: this.tenantId,
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
            tenantId: this.tenantId,
          });
          await this.handleLogout("max_attempts_exceeded");
          return await this.initialize(false);
        }
        logger.info({
          msg: "Attempting to reconnect...",
          attempt: `${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS}`,
          tenantId: this.tenantId,
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
          tenantId: this.tenantId,
        });
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
          if (this.isConnected && isReconnecting) {
            logger.info({
              msg: "Connection already active, reconnection cancelled",
              tenantId: this.tenantId,
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
              tenantId: this.tenantId,
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
            tenantId: this.tenantId,
          });

          await TenantManager.notifyWebhook(this.tenantId, "connection", {
            status: "connected",
          });

          try {
            await this.refreshBusinessInfo();
          } catch (e) {
            errorLogger.error({
              msg: "Failed to refresh business info after connect",
              tenantId: this.tenantId,
              error: (e as Error)?.message || e,
            });
          }
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("chats.set", ({ chats }: any) => {
        try {
          const list = chats || [];
          Store.upsertChats(list);
        } catch (e) {
          errorLogger.error({
            msg: "Error syncing chats.set",
            error: (e as Error)?.message || e,
            tenantId: this.tenantId,
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
            tenantId: this.tenantId,
          });
        }
      });

      const processHistory = async (history: any) => {
        try {
          const chats = history?.chats || [];
          const contacts = history?.contacts || [];
          const messages = history?.messages || [];

          if (chats.length) {
            Store.upsertChats(chats);
          }

          if (contacts.length) {
            for (const c of contacts) {
              const jid = c.id || c.jid;
              if (!jid) continue;
              const name = c.name || c.notify || c.pushName || null;
              Store.upsertChatPartial(jid, { name });
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
                      tenantId: this.tenantId,
                    });
                  }
                } catch (e) {
                  errorLogger.error({
                    msg: "Failed to enqueue history message",
                    error: (e as Error)?.message || e,
                    tenantId: this.tenantId,
                  });
                }
              }
            }
          }
        } catch (e) {
          errorLogger.error({
            msg: "Error processing messaging-history",
            error: (e as Error)?.message || e,
            tenantId: this.tenantId,
          });
        }
      };

      this.sock.ev.on("messaging-history.set", processHistory as any);
      this.sock.ev.on("messaging.history-set", processHistory as any);

      this.sock.ev.on("contacts.set", (contacts: any) => {
        try {
          const list = Array.isArray(contacts)
            ? contacts
            : contacts?.contacts || [];
          for (const c of list || []) {
            const jid = c.id || c.jid;
            if (!jid) continue;
            const name = c.name || c.notify || c.pushName || null;
            Store.upsertChatPartial(jid, { name });
          }
        } catch (e) {
          errorLogger.error({
            msg: "Error processing contacts.set",
            error: (e as Error)?.message || e,
            tenantId: this.tenantId,
          });
        }
      });

      this.sock.ev.on("contacts.upsert", (contacts: any) => {
        try {
          (contacts || []).forEach((c: any) => {
            const jid = c.id || c.jid;
            if (!jid) return;
            const name = c.name || c.notify || c.pushName || null;
            Store.upsertChatPartial(jid, { name });
          });
        } catch (e) {
          errorLogger.error({
            msg: "Error processing contacts.upsert",
            error: (e as Error)?.message || e,
            tenantId: this.tenantId,
          });
        }
      });

      this.sock.ev.on("messages.upsert", async (m: any) => {
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
                  if (!res.accepted) {
                    errorLogger.error({
                      msg: "Failed to enqueue incoming message",
                      error: res.reason,
                      idempotencyKey: res.idempotencyKey,
                      correlationId: res.correlationId,
                      tenantId: this.tenantId,
                    });
                  }
                } catch (e) {
                  errorLogger.error({
                    msg: "Failed to enqueue incoming message",
                    error: (e as Error)?.message || e,
                    tenantId: this.tenantId,
                  });
                }

                const businessInfo = ConfigStore.getBusinessInfo(this.tenantId);
                await TenantManager.notifyWebhook(
                  this.tenantId,
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
              tenantId: this.tenantId,
            });
            await TenantManager.notifyWebhook(this.tenantId, "error", {
              type: "message_processing_error",
              error: error.message,
            });
          }
        }
      });

      const qr = await this.waitForQR();

      if (qr) {
        await TenantManager.notifyWebhook(this.tenantId, "connection", {
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
        tenantId: this.tenantId,
        error: error?.message || error,
      });
      await TenantManager.notifyWebhook(this.tenantId, "error", {
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

      await TenantManager.notifyWebhook(this.tenantId, "connection", {
        status: "logged_out",
        reason,
      });

      logger.info({
        msg: "Session files cleaned and session terminated",
        reason,
        tenantId: this.tenantId,
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
        tenantId: this.tenantId,
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
        tenantId: this.tenantId,
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
    stored: ReturnType<typeof ConfigStore.getBusinessInfo>;
    fetched: any | null;
    persisted: boolean;
    reason?: string;
  }> {
    try {
      const existing = ConfigStore.getBusinessInfo(this.tenantId);

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
          tenantId: this.tenantId,
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
            const digits = (base || "").replace(/[^\d]/g, "");
            if (digits && !nums.includes(digits)) nums.push(digits);
          }
          return nums.length ? nums : (existing.mobile_numbers as any) || null;
        })(),
      };

      ConfigStore.setBusinessInfo(this.tenantId, {
        name: mapped.name,
        working_hours: mapped.working_hours,
        location_url: mapped.location_url,
        shipping_details: mapped.shipping_details,
        instagram_url: mapped.instagram_url,
        website_url: mapped.website_url,
        mobile_numbers: (mapped as any).mobile_numbers ?? null,
      });

      const updated = ConfigStore.getBusinessInfo(this.tenantId);

      return {
        stored: updated,
        fetched: fetchedProfile ? { ...fetchedProfile, about } : null,
        persisted: true,
      };
    } catch (e) {
      errorLogger.error({
        msg: "refreshBusinessInfo failed",
        tenantId: this.tenantId,
        error: (e as Error)?.message || e,
      });
      return {
        stored: ConfigStore.getBusinessInfo(this.tenantId),
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
            tenantId: this.tenantId,
          });
        }
      } catch (e) {
        errorLogger.error({
          msg: "Failed to persist outgoing message",
          error: (e as Error)?.message || e,
          tenantId: this.tenantId,
        });
      }

      return result;
    } catch (error: any) {
      errorLogger.error({
        msg: "Failed to send message",
        error: error.message,
        tenantId: this.tenantId,
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
        tenantId: this.tenantId,
      });
      throw error;
    }
  }
}

class TenantManager {
  private sessions = new Map<TenantId, TenantSession>();
  private sessionsBasePath = path.join(__dirname, "..", "sessions");

  private getOrCreate(tenantId: TenantId): TenantSession {
    let s = this.sessions.get(tenantId);
    if (!s) {
      s = new TenantSession(tenantId);
      this.sessions.set(tenantId, s);
    }
    return s;
  }

  async initialize(tenantId: TenantId): Promise<WhatsAppServiceResult> {
    return this.getOrCreate(tenantId).initialize();
  }

  async logout(tenantId: TenantId): Promise<WhatsAppServiceResult> {
    const s = this.getOrCreate(tenantId);
    return s.logout();
  }

  getConnectionStatus(tenantId: TenantId): ConnectionStatus {
    return this.getOrCreate(tenantId).getConnectionStatus();
  }

  async isSessionValid(tenantId: TenantId): Promise<boolean> {
    return this.getOrCreate(tenantId).isSessionValid();
  }

  async sendMessage(
    tenantId: TenantId,
    to: string,
    message: string,
  ): Promise<any> {
    return this.getOrCreate(tenantId).sendMessage(to, message);
  }

  async checkNumber(tenantId: TenantId, phoneNumber: string): Promise<any> {
    return this.getOrCreate(tenantId).checkNumber(phoneNumber);
  }

  async refreshBusinessInfo(tenantId: TenantId) {
    return this.getOrCreate(tenantId).refreshBusinessInfo();
  }

  // Discover available tenant sessions by scanning sessions directory
  async listAvailableTenantIds(): Promise<TenantId[]> {
    try {
      const entries = await fs.readdir(this.sessionsBasePath, {
        withFileTypes: true,
      } as any);
      const dirs = entries
        .filter((e: any) => e.isDirectory?.() || e.isDirectory)
        .map((e: any) => e.name);
      const candidates: TenantId[] = [];
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
    tenantId: TenantId,
    event: string,
    data: any,
  ): Promise<void> {
    const webhookUrl = ConfigStore.getWebhookUrl(tenantId);
    if (!webhookUrl) {
      logger.warn({
        msg: "Webhook URL not configured, skipping notification",
        tenantId,
      });
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Baileys-API-Webhook",
          "X-Event-Type": event,
          "X-Tenant-Id": tenantId,
        },
        body: JSON.stringify({
          event,
          tenantId,
          timestamp: new Date().toISOString(),
          data,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Webhook request failed with status ${response.status}: ${response.statusText}`,
        );
      }
    } catch (error: any) {
      errorLogger.error({
        msg: "Error during webhook notification",
        event,
        tenantId,
        error: error.message,
        data: JSON.stringify(data),
      });
    }
  }

  static extractMessageContent(msg: any): any {
    if (!msg.message) return null;
    const messageType = Object.keys(msg.message)[0];
    const messageContent = messageType ? msg.message[messageType] : null;

    switch (messageType) {
      case "conversation":
        return { type: "text", text: messageContent };
      case "extendedTextMessage":
        return {
          type: "text",
          text: messageContent.text,
          contextInfo: messageContent.contextInfo,
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
