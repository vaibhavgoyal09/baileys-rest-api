import { logger, errorLogger } from "../utils/logger.js";
import prisma from "./prisma.js";

export interface Chat {
  id?: string;
  jid?: string;
  name?: string;
  subject?: string;
  isGroup?: boolean;
  unreadCount?: number;
  lastMessageTimestamp?: number;
  lastMessageText?: string;
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

interface Conversation {
  jid: string;
  name: string | null;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTimestamp: number | null;
  lastMessageText: string | null;
}

class PrismaStore {
  constructor() {
    logger.info("Prisma store initialized");
  }

  // Convert structured content object to a compact string for lastMessageText
  stringifyContent(content: any): string | null {
    if (!content) return null;
    try {
      if (typeof content === "string") {
        return JSON.stringify({ type: "text", text: content });
      }
      if (content.type === "text") {
        return JSON.stringify(content);
      }
      // for other types keep a compact description
      if (content.type) {
        const caption = content.caption ? `: ${content.caption}` : "";
        return JSON.stringify({
          type: content.type,
          description: `[${content.type}]${caption}`,
        });
      }
      return JSON.stringify(content);
    } catch (e) {
      return null;
    }
  }

  // Bulk upsert chats (from chats.set)
  async upsertChats(chats: Chat[] = []): Promise<void> {
    try {
      const operations = chats
        .map(chat => {
          const jid = chat.id || chat.jid;
          if (!jid) return null;

          const updateData: any = {};
          if (chat.name || chat.subject) updateData.name = chat.name || chat.subject;
          updateData.isGroup = chat.id?.endsWith("@g.us") || chat.jid?.endsWith("@g.us") || false;
          if (typeof chat.unreadCount === "number") updateData.unreadCount = chat.unreadCount;

          return prisma.chat.upsert({
            where: { jid },
            update: updateData,
            create: {
              jid,
              name: chat.name || chat.subject || null,
              isGroup: chat.id?.endsWith("@g.us") || chat.jid?.endsWith("@g.us") || false,
              unreadCount: typeof chat.unreadCount === "number" ? chat.unreadCount : 0,
            },
          });
        })
        .filter((op): op is NonNullable<typeof op> => op !== null);

      if (operations.length > 0) {
        await prisma.$transaction(operations);
      }
    } catch (e) {
      errorLogger.error({
        msg: "Prisma upsertChats failed",
        error: (e as Error).message,
      });
    }
  }

  // Upsert or update a single chat's partial fields
  async upsertChatPartial(jid: string, fields: Partial<Chat> = {}): Promise<void> {
    if (!jid) return;
    try {
      const updateData: any = {};
      if (fields.name || fields.subject) updateData.name = fields.name || fields.subject;
      if (typeof fields.isGroup === "boolean") updateData.isGroup = fields.isGroup;
      else if (jid.endsWith("@g.us")) updateData.isGroup = true;
      if (typeof fields.unreadCount === "number") updateData.unreadCount = fields.unreadCount;
      if (fields.lastMessageTimestamp) updateData.lastMessageTimestamp = new Date(fields.lastMessageTimestamp);
      if (fields.lastMessageText) updateData.lastMessageText = fields.lastMessageText;

      await prisma.chat.upsert({
        where: { jid },
        update: updateData,
        create: {
          jid,
          name: fields.name || fields.subject || null,
          isGroup: typeof fields.isGroup === "boolean" ? fields.isGroup : jid.endsWith("@g.us"),
          unreadCount: typeof fields.unreadCount === "number" ? fields.unreadCount : 0,
          lastMessageTimestamp: fields.lastMessageTimestamp ? new Date(fields.lastMessageTimestamp) : null,
          lastMessageText: fields.lastMessageText || null,
        },
      });
    } catch (e) {
      errorLogger.error({
        msg: "Prisma upsertChatPartial failed",
        error: (e as Error).message,
        jid,
      });
    }
  }

  // Save a message and update chat's last message
  async saveMessage(messageInfo: MessageInfo): Promise<void> {
    try {
      const lastText = this.stringifyContent(messageInfo.content);
      const timestamp = messageInfo.timestamp ? new Date(messageInfo.timestamp) : new Date();

      // Ensure chat exists first and update last message info
      const chatUpdate: Partial<Chat> = {
        isGroup: messageInfo.isGroup || messageInfo.from?.endsWith("@g.us"),
        lastMessageTimestamp: messageInfo.timestamp,
      };
      if (messageInfo.pushName) chatUpdate.name = messageInfo.pushName;
      if (lastText) chatUpdate.lastMessageText = lastText;

      await this.upsertChatPartial(messageInfo.from, chatUpdate);

      // Then insert the message
      await prisma.message.create({
        data: {
          id: messageInfo.id,
          jid: messageInfo.from,
          fromMe: messageInfo.fromMe,
          timestamp,
          type: messageInfo.type || null,
          pushName: messageInfo.pushName || null,
          content: lastText,
        },
      });
    } catch (e) {
      errorLogger.error({
        msg: "Prisma saveMessage failed",
        error: (e as Error).message,
      });
    }
  }

  // List conversations ordered by lastMessageTimestamp desc (nulls last)
  async listConversations({
    limit = 50,
    cursor = null,
  }: { limit?: number; cursor?: number | null } = {}): Promise<Conversation[]> {
    try {
      const where: any = {};
      if (cursor !== null && cursor !== undefined) {
        where.lastMessageTimestamp = {
          lt: new Date(cursor),
        };
      }

      const chats = await prisma.chat.findMany({
        where,
        orderBy: [
          { lastMessageTimestamp: 'desc' },
          { jid: 'asc' },
        ],
        take: limit,
      });

      return chats.map((chat: any) => ({
        jid: chat.jid,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount || 0,
        lastMessageTimestamp: chat.lastMessageTimestamp ? chat.lastMessageTimestamp.getTime() : null,
        lastMessageText: chat.lastMessageText || null,
      }));
    } catch (e) {
      errorLogger.error({
        msg: "Prisma listConversations failed",
        error: (e as Error).message,
      });
      return [];
    }
  }

  // List messages for a specific chat
  async listMessages(
    jid: string,
    {
      limit = 50,
      cursor = null,
    }: { limit?: number; cursor?: number | null } = {},
  ): Promise<MessageInfo[]> {
    try {
      const where: any = { jid };
      if (cursor !== null && cursor !== undefined) {
        where.timestamp = {
          lt: new Date(cursor),
        };
      }

      const messages = await prisma.message.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
      });

      return messages.map((msg: any) => ({
        id: msg.id,
        from: msg.jid,
        fromMe: !!msg.fromMe,
        timestamp: msg.timestamp.getTime(),
        type: msg.type,
        pushName: msg.pushName,
        content: msg.content ? JSON.parse(msg.content) : null,
        isGroup: msg.jid?.endsWith("@g.us") || false,
      }));
    } catch (e) {
      errorLogger.error({
        msg: "Prisma listMessages failed",
        error: (e as Error).message,
      });
      return [];
    }
  }

  // Return the oldest message anchor for a chat
  async getOldestMessageAnchor(
    jid: string,
  ): Promise<{
    key: { id: string; remoteJid: string; fromMe: boolean };
    messageTimestamp: number;
  } | null> {
    try {
      const message = await prisma.message.findFirst({
        where: { jid },
        orderBy: { timestamp: 'asc' },
      });

      if (!message) {
        return null;
      }

      const key = {
        id: String(message.id),
        remoteJid: String(message.jid),
        fromMe: !!message.fromMe,
      };
      const messageTimestamp = message.timestamp ? message.timestamp.getTime() : Date.now();

      return { key, messageTimestamp };
    } catch (e) {
      errorLogger.error({
        msg: "Prisma getOldestMessageAnchor failed",
        error: (e as Error).message,
        jid,
      });
      return null;
    }
  }

  // Batch insert messages with idempotency check
  async saveMessagesBatch(
    messages: (MessageInfo & { idempotencyKey: string })[],
  ): Promise<void> {
    try {
      const operations = messages.map(async (message) => {
        const { idempotencyKey, ...messageInfo } = message;
        const lastText = this.stringifyContent(messageInfo.content);
        const timestamp = messageInfo.timestamp ? new Date(messageInfo.timestamp) : new Date();

        // Ensure chat exists
        const chatUpdate: Partial<Chat> = {
          isGroup: messageInfo.isGroup || messageInfo.from?.endsWith("@g.us"),
          lastMessageTimestamp: messageInfo.timestamp,
        };
        if (messageInfo.pushName) chatUpdate.name = messageInfo.pushName;
        if (lastText) chatUpdate.lastMessageText = lastText;

        await this.upsertChatPartial(messageInfo.from, chatUpdate);

        // Insert message (Prisma handles uniqueness)
        return prisma.message.upsert({
          where: { id: messageInfo.id },
          update: {},
          create: {
            id: messageInfo.id,
            jid: messageInfo.from,
            fromMe: messageInfo.fromMe,
            timestamp,
            type: messageInfo.type || null,
            pushName: messageInfo.pushName || null,
            content: lastText,
          },
        });
      });

      await Promise.all(operations);
    } catch (e) {
      errorLogger.error({
        msg: "Prisma saveMessagesBatch failed",
        error: (e as Error).message,
      });
    }
  }

  // Ping database to check connectivity
  async ping(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (e) {
      errorLogger.error({
        msg: "Prisma ping failed",
        error: (e as Error).message,
      });
      return false;
    }
  }

  // Business Info: getters and setters
  async getBusinessInfo(): Promise<{
    name: string | null;
    working_hours: string | null;
    location_url: string | null;
    shipping_details: string | null;
    instagram_url: string | null;
    website_url: string | null;
    mobile_numbers: string[] | null;
    last_updated: number | null;
  }> {
    try {
      const businessInfo = await prisma.businessInfo.findUnique({
        where: { id: 1 },
      });

      if (!businessInfo) {
        return {
          name: null,
          working_hours: null,
          location_url: null,
          shipping_details: null,
          instagram_url: null,
          website_url: null,
          mobile_numbers: null,
          last_updated: null,
        };
      }

      return {
        name: businessInfo.name,
        working_hours: businessInfo.workingHours,
        location_url: businessInfo.locationUrl,
        shipping_details: businessInfo.shippingDetails,
        instagram_url: businessInfo.instagramUrl,
        website_url: businessInfo.websiteUrl,
        mobile_numbers: businessInfo.mobileNumbers
          ? JSON.parse(businessInfo.mobileNumbers)
          : null,
        last_updated: businessInfo.lastUpdated ? businessInfo.lastUpdated.getTime() : null,
      };
    } catch (e) {
      errorLogger.error({
        msg: "Prisma getBusinessInfo failed",
        error: (e as Error).message,
      });
      return {
        name: null,
        working_hours: null,
        location_url: null,
        shipping_details: null,
        instagram_url: null,
        website_url: null,
        mobile_numbers: null,
        last_updated: null,
      };
    }
  }

  async setBusinessInfo(info: {
    name?: string | null;
    working_hours?: string | null;
    location_url?: string | null;
    shipping_details?: string | null;
    instagram_url?: string | null;
    website_url?: string | null;
    mobile_numbers?: string[] | null;
  }): Promise<void> {
    try {
      const current = await this.getBusinessInfo();

      const merged = {
        name: info.name !== undefined ? info.name : current.name,
        workingHours: info.working_hours !== undefined ? info.working_hours : current.working_hours,
        locationUrl: info.location_url !== undefined ? info.location_url : current.location_url,
        shippingDetails: info.shipping_details !== undefined ? info.shipping_details : current.shipping_details,
        instagramUrl: info.instagram_url !== undefined ? info.instagram_url : current.instagram_url,
        websiteUrl: info.website_url !== undefined ? info.website_url : current.website_url,
        mobileNumbers: info.mobile_numbers !== undefined
          ? (info.mobile_numbers ? JSON.stringify(info.mobile_numbers) : null)
          : (current.mobile_numbers ? JSON.stringify(current.mobile_numbers) : null),
      };

      await prisma.businessInfo.upsert({
        where: { id: 1 },
        update: merged,
        create: { id: 1, ...merged },
      });
    } catch (e) {
      errorLogger.error({
        msg: "Prisma setBusinessInfo failed",
        error: (e as Error).message,
      });
    }
  }
}

const store = new PrismaStore();
export default store;