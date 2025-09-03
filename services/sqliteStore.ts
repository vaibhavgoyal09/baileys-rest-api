import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { logger, errorLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Chat {
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

      CREATE INDEX IF NOT EXISTS idx_chats_last_ts ON chats(lastMessageTimestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(jid, timestamp DESC);
    `);
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
      if (typeof content === 'string') return content;
      if (content.type === 'text') return content.text || null;
      // for other types keep a compact description
      if (content.type) {
        const caption = content.caption ? `: ${content.caption}` : '';
        return `[${content.type}]${caption}`;
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

      this.stmtInsertMessage.run({
        id: messageInfo.id,
        jid: messageInfo.from,
        fromMe: messageInfo.fromMe ? 1 : 0,
        timestamp: Number(messageInfo.timestamp) || null,
        type: messageInfo.type || null,
        pushName: messageInfo.pushName || null,
        content: lastText,
      });

      // Ensure chat exists and update last message info
      this.stmtUpsertChat.run({
        jid: messageInfo.from,
        name: messageInfo.pushName || null,
        isGroup: messageInfo.isGroup ? 1 : (messageInfo.from?.endsWith('@g.us') ? 1 : 0),
        unreadCount: null,
        lastMessageTimestamp: Number(messageInfo.timestamp) || null,
        lastMessageText: lastText,
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

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(params);
      return rows.map((r: any) => ({
        jid: r.jid,
        name: r.name,
        isGroup: !!r.isGroup,
        unreadCount: r.unreadCount || 0,
        lastMessageTimestamp: r.lastMessageTimestamp || null,
        lastMessageText: r.lastMessageText || null,
      }));
    } catch (e) {
      errorLogger.error({ msg: 'SQLite listConversations failed', error: (e as Error).message });
      return [];
    }
  }
}

const store = new SQLiteStore();
export default store;