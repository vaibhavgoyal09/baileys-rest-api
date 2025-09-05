import express, { Request, Response } from "express";
import verifyToken from "../middlewares/verifyToken.js";
import validator from "../middlewares/validator.js";
import ConfigStore from "../services/configStore.js";
import WAManager from "../services/waManager.js";
import { updateBusinessInfo } from "../validators/business.js";
import { setWebhook } from "../validators/user.js";

const router = express.Router();

/**
 * GET /api/business
 * Returns stored business info for the authenticated tenant
 */
router.get(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = (req as any).user?.userId as string;
      const info = ConfigStore.getBusinessInfo(tenantId);
      (res as any).sendResponse(200, { success: true, data: info });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

/**
 * PUT /api/business
 * Update business info (partial fields allowed) for the authenticated tenant
 */
router.put(
  "/",
  verifyToken,
  validator(updateBusinessInfo),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = (req as any).user?.userId as string;
      const {
        name = undefined,
        working_hours = undefined,
        location_url = undefined,
        shipping_details = undefined,
        instagram_url = undefined,
        website_url = undefined,
        mobile_numbers = undefined,
      } = req.body || {};

      ConfigStore.setBusinessInfo(tenantId, {
        name,
        working_hours,
        location_url,
        shipping_details,
        instagram_url,
        website_url,
        mobile_numbers,
      });

      const updated = ConfigStore.getBusinessInfo(tenantId);
      (res as any).sendResponse(200, {
        success: true,
        message: "Business info updated",
        data: updated,
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

/**
 * POST /api/business/refresh
 * Attempt to fetch business info from WhatsApp (Baileys) and persist
 */
router.post(
  "/refresh",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = (req as any).user?.userId as string;
      const result = await WAManager.refreshBusinessInfo(tenantId);
      (res as any).sendResponse(200, { success: true, ...result });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

/**
 * PUT /api/business/webhook
 * Set or update webhook URL for the authenticated tenant
 * body: { webhook_url: string | null }
 */
router.put(
  "/webhook",
  verifyToken,
  validator(setWebhook),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = (req as any).user?.userId as string;
      const { webhook_url } = req.body || {};
      ConfigStore.upsertUserConfig(tenantId, {
        webhook_url: webhook_url ?? null,
      });
      (res as any).sendResponse(200, {
        success: true,
        message: "Webhook updated",
        webhook_url: ConfigStore.getWebhookUrl(tenantId),
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

export default router;
