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
declare class WhatsAppService {
    private sock;
    private isConnected;
    private qr;
    private sessionPath;
    private connectionUpdateHandler;
    private reconnectAttempts;
    private readonly MAX_RECONNECT_ATTEMPTS;
    constructor();
    resetReconnectAttempts(): void;
    waitForQR(timeout?: number): Promise<string | null>;
    initialize(isReconnecting?: boolean): Promise<WhatsAppServiceResult>;
    handleLogout(reason?: string): Promise<WhatsAppServiceResult>;
    logout(): Promise<WhatsAppServiceResult>;
    static notifyWebhook(event: string, data: any): Promise<void>;
    getConnectionStatus(): ConnectionStatus;
    getConversations(options?: any): Promise<any[]>;
    sendMessage(to: string, message: string): Promise<any>;
    checkNumber(phoneNumber: string): Promise<any>;
    static extractMessageContent(msg: any): any;
}
declare const whatsAppService: WhatsAppService;
export default whatsAppService;
//# sourceMappingURL=baileys.d.ts.map