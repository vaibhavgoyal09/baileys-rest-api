import express, { Request, Response } from "express";

const router = express.Router();
import verifyToken from "../middlewares/verifyToken.js";
import validator from "../middlewares/validator.js";
import WAManager from "../services/waManager.js";
import Store from "../services/sqliteStore.js";
import {
  sendText,
  checkNumber,
  listConversations,
} from "../validators/message.js";

router.post(
  "/check-number",
  verifyToken,
  validator(checkNumber),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = (req as any).user?.userId as string;
      const { to } = req.body;
      const result = await WAManager.checkNumber(tenantId, to);
      (res as any).sendResponse(200, result);
    } catch (error) {
      (res as any).sendError(500, error);
    }
  }
);

router.post(
  "/send-text",
  verifyToken,
  validator(sendText),
  async (req: Request, res: Response): Promise<void> => {
    try {
      // Require tenant id from query instead of decoding from auth token
      const tenantId = (req.query.tenantId ||
        req.query.tenant_id ||
        req.query.tid) as string | undefined;
      if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
        (res as any).sendError(
          400,
          "tenantId is required as a query parameter"
        );
        return;
      }

      const { to, message } = req.body;
      const result = await WAManager.sendMessage(tenantId.trim(), to, message);
      (res as any).sendResponse(200, result);
    } catch (error) {
      (res as any).sendError(500, error);
    }
  }
);

// Conversations are stored locally in SQLite (shared), not scoped by tenant in current schema.
// Returning as-is; consider namespacing in DB if needed.
router.get(
  "/conversations",
  verifyToken,
  validator(listConversations),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const options = req.query;
      const conversations = Store.listConversations({
        limit: options.limit ? Number(options.limit) : 50,
        cursor: options.cursor !== undefined ? Number(options.cursor) : null,
      });
      (res as any).sendResponse(200, conversations);
    } catch (error) {
      (res as any).sendError(500, error);
    }
  }
);

router.get("/messages", async (req: Request, res: Response): Promise<void> => {
  try {
    const { jid } = req.query;
    if (!jid) {
      (res as any).sendError(400, "JID is required");
      return;
    }
    const options = req.query;
    const messages = Store.listMessages(jid as string, {
      limit: options.limit ? Number(options.limit) : 50,
      cursor: options.cursor !== undefined ? Number(options.cursor) : null,
    });
    (res as any).sendResponse(200, messages);
  } catch (error) {
    console.log("Messages Not Found", error);
    (res as any).sendError(500, error);
  }
});

export default router;
