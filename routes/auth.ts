import express, { Request, Response } from "express";
import { signJwt } from "../utils/jwt.js";
import ConfigStore from "../services/prismaConfigStore.js";
import validator from "../middlewares/validator.js";
import { issueToken } from "../validators/user.js";

const router = express.Router();

/**
 * POST /api/auth/token
 * Issues a JWT for a tenant/user. Optionally sets webhook_url for this tenant.
 * Body:
 *  - tenantId: string (required) - unique identifier for the user/tenant
 *  - webhook_url?: string | null (optional)
 *
 * This is a simple bootstrap endpoint. In production, replace with a real user-auth system.
 */
router.post(
  "/token",
  validator(issueToken),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { tenantId, webhook_url } = req.body || {};

      if (webhook_url !== undefined) {
        await ConfigStore.upsertUserConfig(tenantId, {
          webhook_url: webhook_url ?? null,
        });
      } else {
        // ensure tenant exists
        await ConfigStore.upsertUserConfig(tenantId, { webhook_url: null });
      }

      const token = signJwt({ userId: tenantId });
      (res as any).sendResponse(200, {
        success: true,
        token,
        token_type: "Bearer",
        tenantId,
        webhook_url: await ConfigStore.getWebhookUrl(tenantId),
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

export default router;
