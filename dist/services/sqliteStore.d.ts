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
declare class SQLiteStore {
    private dbFilePath;
    private db;
    private stmtUpsertChat;
    private stmtInsertMessage;
    private stmtListChatsBase;
    constructor(dbFilePath?: string);
    static ensureDir(dir: string): void;
    initSchema(): void;
    prepareStatements(): void;
    stringifyContent(content: any): string | null;
    upsertChats(chats?: Chat[]): void;
    upsertChatPartial(jid: string, fields?: Partial<Chat>): void;
    saveMessage(messageInfo: MessageInfo): void;
    listConversations({ limit, cursor }?: {
        limit?: number;
        cursor?: number | null;
    }): Conversation[];
    listMessages(jid: string, { limit, cursor }?: {
        limit?: number;
        cursor?: number | null;
    }): MessageInfo[];
}
declare const store: SQLiteStore;
export default store;
//# sourceMappingURL=sqliteStore.d.ts.map