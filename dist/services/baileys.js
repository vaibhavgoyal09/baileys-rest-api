import { default as makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers, } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import { fileURLToPath } from "url";
import { pino } from "pino";
import fs from "fs/promises";
import { logger, errorLogger } from "../utils/logger.js";
import Store from "./sqliteStore.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
class WhatsAppService {
    constructor() {
        this.sock = null;
        this.isConnected = false;
        this.qr = null;
        this.connectionUpdateHandler = null;
        this.reconnectAttempts = 0;
        this.MAX_RECONNECT_ATTEMPTS = 5;
        this.sessionPath = path.join(__dirname, "../sessions");
    }
    async isSessionValid() {
        try {
            await fs.access(this.sessionPath);
            const credsPath = path.join(this.sessionPath, "creds.json");
            await fs.access(credsPath);
            const credsData = await fs.readFile(credsPath, "utf-8");
            const creds = JSON.parse(credsData);
            if (creds && creds.me && creds.platform) {
                logger.debug("Session appears valid");
                return true;
            }
            logger.warn("Session creds.json exists but appears invalid");
            return false;
        }
        catch (error) {
            logger.debug("Session validation failed:", error);
            return false;
        }
    }
    resetReconnectAttempts() {
        this.reconnectAttempts = 0;
    }
    async waitForQR(timeout = 300000) {
        return new Promise((resolve) => {
            let timeoutId = null;
            const cleanup = () => {
                if (timeoutId)
                    clearTimeout(timeoutId);
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
                this.connectionUpdateHandler = (update) => {
                    const { connection, qr } = update;
                    if (qr) {
                        cleanup();
                        this.qr = qr;
                        resolve(qr);
                    }
                    else if (connection === "open") {
                        cleanup();
                        resolve(null);
                    }
                };
                this.sock.ev.on("connection.update", this.connectionUpdateHandler);
            }
            else {
                cleanup();
                resolve(null);
            }
        });
    }
    async initialize(isReconnecting = false) {
        try {
            try {
                await fs.access(this.sessionPath);
            }
            catch (error) {
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
                    logger.warn(`Maximum reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) exceeded`);
                    await this.handleLogout("max_attempts_exceeded");
                    return await this.initialize(false);
                }
                logger.info(`Attempting to reconnect... (Attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
            }
            else {
                this.resetReconnectAttempts();
            }
            const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);
            this.sock = makeWASocket({
                auth: state,
                browser: Browsers.macOS("Desktop"),
                syncFullHistory: true,
                logger: pino({ level: "silent" }),
            });
            this.sock.ev.on("connection.update", async (update) => {
                logger.debug({ msg: "Connection update received", update });
                if (update.qr) {
                    console.log("QR Code received:", update.qr);
                }
                const { connection, lastDisconnect } = update;
                if (connection === "close") {
                    if (this.isConnected && isReconnecting) {
                        logger.info({
                            msg: "Connection already active, reconnection cancelled",
                        });
                        return;
                    }
                    const statusCode = lastDisconnect?.error instanceof Boom
                        ? lastDisconnect.error.output?.statusCode
                        : undefined;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect && !this.isConnected) {
                        await this.initialize(true);
                    }
                    else if (!shouldReconnect) {
                        logger.info({
                            msg: "Session terminated",
                        });
                        await this.handleLogout("connection_closed");
                        await this.initialize(false);
                    }
                }
                else if (connection === "open") {
                    this.isConnected = true;
                    this.qr = null;
                    this.resetReconnectAttempts();
                    logger.info({
                        msg: "WhatsApp connection successful!",
                    });
                    await WhatsAppService.notifyWebhook("connection", {
                        status: "connected",
                    });
                }
            });
            this.sock.ev.on("creds.update", saveCreds);
            this.sock.ev.on("messaging-history.set", (messageHistory) => {
                console.log("On Message History", messageHistory);
            });
            this.sock.ev.on("chats.set", ({ chats }) => {
                try {
                    const list = chats || [];
                    logger.debug({
                        msg: "chats.set event fired",
                        count: list.length,
                        chats: list.slice(0, 3),
                    });
                    Store.upsertChats(list);
                    logger.debug({
                        msg: "Chats set synced successfully",
                        count: list.length,
                    });
                }
                catch (e) {
                    errorLogger.error({
                        msg: "Error syncing chats.set",
                        error: e?.message || e,
                    });
                }
            });
            this.sock.ev.on("chats.upsert", (payload) => {
                try {
                    const list = Array.isArray(payload) ? payload : payload?.chats || [];
                    const arr = list || [];
                    logger.debug({
                        msg: "chats.upsert event fired",
                        count: arr.length,
                        chats: arr.slice(0, 3),
                    });
                    if (arr.length) {
                        Store.upsertChats(arr);
                        logger.debug({ msg: "Chats upsert processed", count: arr.length });
                    }
                }
                catch (e) {
                    errorLogger.error({
                        msg: "Error processing chats.upsert",
                        error: e?.message || e,
                    });
                }
            });
            const processHistory = async (history) => {
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
                        Store.upsertChats(chats);
                    }
                    if (contacts.length) {
                        for (const c of contacts) {
                            const jid = c.id || c.jid;
                            if (!jid)
                                continue;
                            const name = c.name || c.notify || c.pushName || null;
                            Store.upsertChatPartial(jid, { name });
                        }
                    }
                    if (messages.length) {
                        for (const msg of messages) {
                            const messageType = Object.keys(msg.message || {})[0] || "";
                            if (messageType === "protocolMessage")
                                continue;
                            const info = {
                                id: msg.key?.id,
                                from: msg.key?.remoteJid,
                                fromMe: !!msg.key?.fromMe,
                                timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
                                type: messageType,
                                pushName: msg.pushName || null,
                                content: WhatsAppService.extractMessageContent(msg),
                                isGroup: (msg.key?.remoteJid || "").endsWith("@g.us"),
                            };
                            if (info.id && info.from) {
                                try {
                                    Store.saveMessage(info);
                                }
                                catch (e) {
                                    errorLogger.error({
                                        msg: "Failed to persist history message",
                                        error: e?.message || e,
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
                }
                catch (e) {
                    errorLogger.error({
                        msg: "Error processing messaging-history",
                        error: e?.message || e,
                    });
                }
            };
            this.sock.ev.on("messaging-history.set", processHistory);
            this.sock.ev.on("messaging.history-set", processHistory);
            this.sock.ev.on("contacts.set", (contacts) => {
                try {
                    const list = Array.isArray(contacts)
                        ? contacts
                        : contacts?.contacts || [];
                    for (const c of list || []) {
                        const jid = c.id || c.jid;
                        if (!jid)
                            continue;
                        const name = c.name || c.notify || c.pushName || null;
                        Store.upsertChatPartial(jid, { name });
                    }
                    logger.debug({
                        msg: "contacts.set processed",
                        count: (list || []).length,
                    });
                }
                catch (e) {
                    errorLogger.error({
                        msg: "Error processing contacts.set",
                        error: e?.message || e,
                    });
                }
            });
            this.sock.ev.on("contacts.upsert", (contacts) => {
                try {
                    (contacts || []).forEach((c) => {
                        const jid = c.id || c.jid;
                        if (!jid)
                            return;
                        const name = c.name || c.notify || c.pushName || null;
                        Store.upsertChatPartial(jid, { name });
                    });
                    logger.debug({
                        msg: "Contacts upsert processed",
                        count: (contacts || []).length,
                    });
                }
                catch (e) {
                    errorLogger.error({
                        msg: "Error processing contacts.upsert",
                        error: e?.message || e,
                    });
                }
            });
            this.sock.ev.on("messages.upsert", async (m) => {
                if (m.type === "notify") {
                    try {
                        await Promise.all(m.messages.map(async (msg) => {
                            const messageType = Object.keys(msg.message || {})[0] || "";
                            if (messageType === "protocolMessage") {
                                return;
                            }
                            logger.debug({
                                msg: "Raw message received",
                                data: msg,
                            });
                            const messageInfo = {
                                id: msg.key.id,
                                from: msg.key.remoteJid,
                                fromMe: msg.key.fromMe,
                                timestamp: msg.messageTimestamp,
                                type: messageType,
                                pushName: msg.pushName,
                                content: WhatsAppService.extractMessageContent(msg),
                                isGroup: msg.key.remoteJid?.endsWith("@g.us") || false,
                            };
                            logger.debug({
                                msg: "Processed message info",
                                data: messageInfo,
                            });
                            try {
                                Store.saveMessage(messageInfo);
                            }
                            catch (e) {
                                errorLogger.error({
                                    msg: "Failed to persist incoming message",
                                    error: e?.message || e,
                                });
                            }
                            await WhatsAppService.notifyWebhook("message.received", messageInfo);
                            logger.info({
                                msg: "New message processed",
                                messageId: messageInfo.id,
                                from: messageInfo.from,
                                type: messageInfo.type,
                                content: messageInfo.content,
                                isGroup: messageInfo.isGroup,
                                timestamp: new Date(messageInfo.timestamp * 1000).toISOString(),
                            });
                        }));
                    }
                    catch (error) {
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
            const qr = await this.waitForQR();
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
        }
        catch (error) {
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
    async handleLogout(reason = "normal_logout") {
        try {
            await fs.rm(this.sessionPath, { recursive: true, force: true });
            this.sock = null;
            this.isConnected = false;
            this.qr = null;
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
        }
        catch (error) {
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
    async logout() {
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
        }
        catch (error) {
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
    static async notifyWebhook(event, data) {
        const webhookUrl = process.env.WEBHOOK_URL;
        if (!webhookUrl) {
            logger.warn({
                msg: "Webhook URL not configured, skipping notification",
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
                msg: "Webhook notification sent successfully",
                event,
                status: response.status,
            });
        }
        catch (error) {
            errorLogger.error({
                msg: "Error during webhook notification",
                event,
                error: error.message,
                data: JSON.stringify(data),
            });
        }
    }
    getConnectionStatus() {
        return {
            isConnected: this.isConnected,
            qr: this.qr,
        };
    }
    async getConversations(options = {}) {
        const { isConnected } = this;
        try {
            const limit = Number(options.limit) || 50;
            const cursor = options.cursor !== undefined && options.cursor !== null
                ? Number(options.cursor)
                : null;
            logger.debug({
                msg: "getConversations called",
                options,
                limit,
                cursor,
                isConnected: this.isConnected,
            });
            const existingConversations = Store.listConversations({
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
            }
            const conversations = Store.listConversations({ limit, cursor });
            logger.debug({
                msg: "getConversations result",
                count: conversations.length,
                conversations: conversations.slice(0, 3),
            });
            return conversations;
        }
        catch (error) {
            errorLogger.error({
                msg: "Failed to get conversations",
                error: error?.message || error,
            });
            return [];
        }
    }
    async getMessages(jid, options = {}) {
        try {
            const limit = Number(options.limit) || 50;
            const cursor = options.cursor !== undefined && options.cursor !== null
                ? Number(options.cursor)
                : null;
            return Store.listMessages(jid, { limit, cursor });
        }
        catch (error) {
            errorLogger.error({
                msg: "Failed to get messages",
                error: error?.message || error,
            });
            return [];
        }
    }
    async sendMessage(to, message) {
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
            logger.info({
                msg: "Message sent",
                to: jid,
                messageId: result.key.id,
            });
            try {
                const timestamp = result.messageTimestamp || Math.floor(Date.now() / 1000);
                const messageInfo = {
                    id: result.key.id,
                    from: result.key.remoteJid || jid,
                    fromMe: true,
                    timestamp,
                    type: "conversation",
                    pushName: null,
                    content: { type: "text", text: message },
                    isGroup: (jid || "").endsWith("@g.us"),
                };
                Store.saveMessage(messageInfo);
            }
            catch (e) {
                errorLogger.error({
                    msg: "Failed to persist outgoing message",
                    error: e?.message || e,
                });
            }
            return result;
        }
        catch (error) {
            errorLogger.error({
                msg: "Failed to send message",
                error: error.message,
            });
            throw error;
        }
    }
    async checkNumber(phoneNumber) {
        if (!this.isConnected) {
            throw new Error("WhatsApp connection is not active");
        }
        try {
            const [result] = await this.sock.onWhatsApp(phoneNumber.replace(/[^\d]/g, ""));
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
        }
        catch (error) {
            errorLogger.error({
                msg: "Failed to check phone number",
                phoneNumber,
                error: error.message,
            });
            throw error;
        }
    }
    static extractMessageContent(msg) {
        if (!msg.message)
            return null;
        const messageType = Object.keys(msg.message)[0];
        const messageContent = msg.message && messageType ? msg.message[messageType] : null;
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
const whatsAppService = new WhatsAppService();
export default whatsAppService;
//# sourceMappingURL=baileys.js.map