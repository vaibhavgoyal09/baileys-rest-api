import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { logger, errorLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

class SQLiteStore {
  private dbFilePath: string;
  private db: Database.Database;
  private stmtUpsertChat!: Database.Statement;
  private stmtInsertMessage!: Database.Statement;
  private stmtListChatsBase: string = '';

  constructor(dbFilePath: string = path.join(__dirname, '..', 'data', 'whatsapp.db')) {
    this.dbFilePath = dbFilePath;
    logger.debug({ msg: 'SQLiteStore constructor called', dbFilePath });
    SQLiteStore.ensureDir(path.dirname(this.dbFilePath));
    this.db = new Database(this.dbFilePath);
    this.initSchema();
    this.prepareStatements();
    logger.info({ msg: 'SQLite store initialized', dbFilePath: this.dbFilePath });
  }

  static ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  initSchema(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        isGroup INTEGER DEFAULT 0,
        unreadCount INTEGER DEFAULT 0,
        lastMessageTimestamp INTEGER,
        lastMessageText TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        fromMe INTEGER DEFAULT 0,
        timestamp INTEGER,
        type TEXT,
        pushName TEXT,
        content TEXT,
        FOREIGN KEY (jid) REFERENCES chats(jid)
      );

      -- Single-row table to store business profile/info
      CREATE TABLE IF NOT EXISTS business_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT,
        working_hours TEXT,
        location_url TEXT,
        shipping_details TEXT,
        instagram_url TEXT,
        website_url TEXT,
        mobile_numbers TEXT, -- JSON array string
        last_updated INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_chats_last_ts ON chats(lastMessageTimestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, timestamp DESC);
    `);

    // Ensure a single row exists for business_info
    try {
      this.db.prepare(`INSERT OR IGNORE INTO business_info (id, last_updated) VALUES (1, strftime('%s','now'))`).run();
    } catch (e) {
      errorLogger.error({ msg: 'SQLite ensure business_info row failed', error: (e as Error).message });
    }
  }

  prepareStatements(): void {
    // Upsert chat (merge-like)
    this.stmtUpsertChat = this.db.prepare(`
      INSERT INTO chats (jid, name, isGroup, unreadCount, lastMessageTimestamp, lastMessageText)
      VALUES (@jid, @name, @isGroup, COALESCE(@unreadCount, 0), @lastMessageTimestamp, @lastMessageText)
      ON CONFLICT(jid) DO UPDATE SET
        name = COALESCE(excluded.name, chats.name),
        isGroup = COALESCE(excluded.isGroup, chats.isGroup),
        unreadCount = COALESCE(excluded.unreadCount, chats.unreadCount),
        lastMessageTimestamp = COALESCE(excluded.lastMessageTimestamp, chats.lastMessageTimestamp),
        lastMessageText = COALESCE(excluded.lastMessageText, chats.lastMessageText)
    `);

    this.stmtInsertMessage = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, jid, fromMe, timestamp, type, pushName, content)
      VALUES (@id, @jid, @fromMe, @timestamp, @type, @pushName, @content)
    `);

    this.stmtListChatsBase = `
      SELECT jid, name, isGroup, unreadCount, lastMessageTimestamp, lastMessageText
      FROM chats
    `;
  }

  // Convert structured content object to a compact string for lastMessageText
  stringifyContent(content: any): string | null {
    if (!content) return null;
    try {
      if (typeof content === 'string') {
        return JSON.stringify({ type: 'text', text: content });
      }
      if (content.type === 'text') {
        return JSON.stringify(content);
      }
      // for other types keep a compact description
      if (content.type) {
        const caption = content.caption ? `: ${content.caption}` : '';
        return JSON.stringify({ type: content.type, description: `[${content.type}]${caption}` });
      }
      return JSON.stringify(content);
    } catch (e) {
      return null;
    }
  }

  // Bulk upsert chats (from chats.set)
  upsertChats(chats: Chat[] = []): void {
    const tx = this.db.transaction((rows: Chat[]) => {
      for (const chat of rows) {
        const jid = chat.id || chat.jid;
        if (!jid) continue;
        const payload = {
          jid,
          name: chat.name || chat.subject || null,
          isGroup: (chat.id?.endsWith('@g.us') || chat.jid?.endsWith('@g.us')) ? 1 : 0,
          unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : null,
          lastMessageTimestamp: null,
          lastMessageText: null,
        };
        this.stmtUpsertChat.run(payload);
      }
    });
    try {
      tx(chats);
    } catch (e) {
      errorLogger.error({ msg: 'SQLite upsertChats failed', error: (e as Error).message });
    }
  }

  // Upsert or update a single chat's partial fields
  upsertChatPartial(jid: string, fields: Partial<Chat> = {}): void {
    if (!jid) return;
    const payload = {
      jid,
      name: fields.name || fields.subject || null,
      isGroup: typeof fields.isGroup === 'number'
        ? fields.isGroup
        : (jid.endsWith('@g.us') ? 1 : 0),
      unreadCount: typeof fields.unreadCount === 'number' ? fields.unreadCount : null,
      lastMessageTimestamp: fields.lastMessageTimestamp || null,
      lastMessageText: fields.lastMessageText || null,
    };
    try {
      this.stmtUpsertChat.run(payload);
    } catch (e) {
      errorLogger.error({ msg: 'SQLite upsertChatPartial failed', error: (e as Error).message, jid });
    }
  }

  // Save a message and update chat's last message
  saveMessage(messageInfo: MessageInfo): void {
    try {
      const lastText = this.stringifyContent(messageInfo.content);

      // Ensure chat exists first and update last message info
      this.stmtUpsertChat.run({
        jid: messageInfo.from,
        name: messageInfo.pushName || null,
        isGroup: messageInfo.isGroup ? 1 : (messageInfo.from?.endsWith('@g.us') ? 1 : 0),
        unreadCount: null,
        lastMessageTimestamp: Number(messageInfo.timestamp) || null,
        lastMessageText: lastText,
      });

      // Then insert the message (avoids FK constraint issues if enabled)
      this.stmtInsertMessage.run({
        id: messageInfo.id,
        jid: messageInfo.from,
        fromMe: messageInfo.fromMe ? 1 : 0,
        timestamp: Number(messageInfo.timestamp) || null,
        type: messageInfo.type || null,
        pushName: messageInfo.pushName || null,
        content: lastText,
      });
    } catch (e) {
      errorLogger.error({ msg: 'SQLite saveMessage failed', error: (e as Error).message });
    }
  }

  // List conversations ordered by lastMessageTimestamp desc (nulls last)
  listConversations({ limit = 50, cursor = null }: { limit?: number; cursor?: number | null } = {}): Conversation[] {
    try {
      let sql = `${this.stmtListChatsBase} WHERE 1=1`;
      const params: any = {};
      if (cursor !== null && cursor !== undefined) {
        sql += ' AND (lastMessageTimestamp IS NULL OR lastMessageTimestamp < @cursor)';
        params.cursor = Number(cursor);
      }
      sql += ' ORDER BY (lastMessageTimestamp IS NULL), lastMessageTimestamp DESC';
      sql += ' LIMIT @limit';
      params.limit = Number(limit);

      logger.debug({
        msg: 'listConversations query',
        sql,
        params
      });

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(params);

      logger.debug({
        msg: 'listConversations raw results',
        rowCount: rows.length,
        rows: rows.slice(0, 3) // Log first 3 rows
      });

      const conversations = rows.map((r: any) => ({
        jid: r.jid,
        name: r.name,
        isGroup: !!r.isGroup,
        unreadCount: r.unreadCount || 0,
        lastMessageTimestamp: r.lastMessageTimestamp || null,
        lastMessageText: r.lastMessageText || null,
      }));

      logger.debug({
        msg: 'listConversations processed results',
        count: conversations.length,
        conversations: conversations.slice(0, 3)
      });

      return conversations;
    } catch (e) {
      errorLogger.error({ msg: 'SQLite listConversations failed', error: (e as Error).message });
      return [];
    }
  }

  // List messages for a specific chat
  listMessages(jid: string, { limit = 50, cursor = null }: { limit?: number; cursor?: number | null } = {}): MessageInfo[] {
    try {
      let sql = `
        SELECT id, jid, fromMe, timestamp, type, pushName, content
        FROM messages
        WHERE jid = @jid
      `;
      const params: any = { jid };
      if (cursor !== null && cursor !== undefined) {
        sql += ' AND timestamp < @cursor';
        params.cursor = Number(cursor);
      }
      sql += ' ORDER BY timestamp DESC LIMIT @limit';
      params.limit = Number(limit);

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(params);
      return rows.map((r: any) => ({
        id: r.id,
        from: r.jid,
        fromMe: !!r.fromMe,
        timestamp: r.timestamp,
        type: r.type,
        pushName: r.pushName,
        content: r.content ? JSON.parse(r.content) : null,
        isGroup: r.jid?.endsWith('@g.us') || false,
      }));
    } catch (e) {
      errorLogger.error({ msg: 'SQLite listMessages failed', error: (e as Error).message });
      return [];
    }
  }

  // Return the oldest message anchor for a chat (used for history backfill)
  // Provides a Baileys-compatible key object and its messageTimestamp
  getOldestMessageAnchor(jid: string): { key: { id: string; remoteJid: string; fromMe: boolean }, messageTimestamp: number } | null {
    try {
      const stmt = this.db.prepare(`
        SELECT id, jid, fromMe, timestamp
        FROM messages
        WHERE jid = @jid
        ORDER BY timestamp ASC
        LIMIT 1
      `);
      const row: any = stmt.get({ jid });
      if (!row) {
        return null;
      }
      const key = {
        id: String(row.id),
        remoteJid: String(row.jid),
        fromMe: !!row.fromMe
      };
      const messageTimestamp = Number(row.timestamp) || Math.floor(Date.now() / 1000);
      return { key, messageTimestamp };
    } catch (e) {
      errorLogger.error({ msg: 'SQLite getOldestMessageAnchor failed', error: (e as Error).message, jid });
      return null;
    }
  }

  // Batch insert messages with idempotency check
  // Uses INSERT OR IGNORE to skip duplicates based on idempotencyKey
  saveMessagesBatch(messages: (MessageInfo & { idempotencyKey: string })[]): void {
    const tx = this.db.transaction((rows: (MessageInfo & { idempotencyKey: string })[]) => {
      for (const message of rows) {
        const { idempotencyKey, ...messageInfo } = message;

        // Upsert chat first to guarantee parent row exists
        const lastText = this.stringifyContent(messageInfo.content);
        this.stmtUpsertChat.run({
          jid: messageInfo.from,
          name: messageInfo.pushName || null,
          isGroup: messageInfo.isGroup ? 1 : (messageInfo.from?.endsWith('@g.us') ? 1 : 0),
          unreadCount: null,
          lastMessageTimestamp: Number(messageInfo.timestamp) || null,
          lastMessageText: lastText,
        });

        // Then insert message with idempotency
        this.db.prepare(`
          INSERT OR IGNORE INTO messages (
            id, jid, fromMe, timestamp, type, pushName, content
          ) VALUES (@id, @jid, @fromMe, @timestamp, @type, @pushName, @content)
        `).run({
          id: messageInfo.id,
          jid: messageInfo.from,
          fromMe: messageInfo.fromMe ? 1 : 0,
          timestamp: Number(messageInfo.timestamp) || null,
          type: messageInfo.type || null,
          pushName: messageInfo.pushName || null,
          content: lastText,
        });
      }
    });

    try {
      tx(messages);
    } catch (e) {
      errorLogger.error({ msg: 'SQLite saveMessagesBatch failed', error: (e as Error).message });
    }
  }

  // Ping database to check connectivity
  ping(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const stmt = this.db.prepare('SELECT 1');
        stmt.run();
        resolve(true);
      } catch (e) {
        errorLogger.error({ msg: 'SQLite ping failed', error: (e as Error).message });
        resolve(false);
      }
    });
  }

  // Business Info: getters and setters

  getBusinessInfo(): {
    name: string | null;
    working_hours: string | null;
    location_url: string | null;
    shipping_details: string | null;
    instagram_url: string | null;
    website_url: string | null;
    mobile_numbers: string[] | null;
    last_updated: number | null;
  } {
    try {
      const row = this.db.prepare(`
        SELECT name, working_hours, location_url, shipping_details, instagram_url, website_url, mobile_numbers, last_updated
        FROM business_info
        WHERE id = 1
      `).get() as any;

      if (!row) {
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
        name: row.name ?? null,
        working_hours: row.working_hours ?? null,
        location_url: row.location_url ?? null,
        shipping_details: row.shipping_details ?? null,
        instagram_url: row.instagram_url ?? null,
        website_url: row.website_url ?? null,
        mobile_numbers: row.mobile_numbers ? JSON.parse(row.mobile_numbers) : null,
        last_updated: row.last_updated ? Number(row.last_updated) : null,
      };
    } catch (e) {
      errorLogger.error({ msg: 'SQLite getBusinessInfo failed', error: (e as Error).message });
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

  setBusinessInfo(info: {
    name?: string | null;
    working_hours?: string | null;
    location_url?: string | null;
    shipping_details?: string | null;
    instagram_url?: string | null;
    website_url?: string | null;
    mobile_numbers?: string[] | null;
  }): void {
    try {
      const current = this.getBusinessInfo();

      const merged = {
        name: info.name !== undefined ? info.name : current.name,
        working_hours: info.working_hours !== undefined ? info.working_hours : current.working_hours,
        location_url: info.location_url !== undefined ? info.location_url : current.location_url,
        shipping_details: info.shipping_details !== undefined ? info.shipping_details : current.shipping_details,
        instagram_url: info.instagram_url !== undefined ? info.instagram_url : current.instagram_url,
        website_url: info.website_url !== undefined ? info.website_url : current.website_url,
        mobile_numbers: info.mobile_numbers !== undefined ? info.mobile_numbers : current.mobile_numbers,
      };

      this.db.prepare(`
        INSERT INTO business_info (id, name, working_hours, location_url, shipping_details, instagram_url, website_url, mobile_numbers, last_updated)
        VALUES (1, @name, @working_hours, @location_url, @shipping_details, @instagram_url, @website_url, @mobile_numbers, strftime('%s','now'))
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          working_hours = excluded.working_hours,
          location_url = excluded.location_url,
          shipping_details = excluded.shipping_details,
          instagram_url = excluded.instagram_url,
          website_url = excluded.website_url,
          mobile_numbers = excluded.mobile_numbers,
          last_updated = excluded.last_updated
      `).run({
        name: merged.name ?? null,
        working_hours: merged.working_hours ?? null,
        location_url: merged.location_url ?? null,
        shipping_details: merged.shipping_details ?? null,
        instagram_url: merged.instagram_url ?? null,
        website_url: merged.website_url ?? null,
        mobile_numbers: merged.mobile_numbers ? JSON.stringify(merged.mobile_numbers) : null,
      });
    } catch (e) {
      errorLogger.error({ msg: 'SQLite setBusinessInfo failed', error: (e as Error).message });
    }
  }
}

const store = new SQLiteStore();
export default store;