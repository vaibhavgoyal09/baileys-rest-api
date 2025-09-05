import express, { Request, Response } from 'express';
import verifyToken from '../middlewares/verifyToken.js';
import validator from '../middlewares/validator.js';
import Store from '../services/sqliteStore.js';
import WhatsAppService from '../services/baileys.js';
import { updateBusinessInfo } from '../validators/business.js';

const router = express.Router();

/**
 * GET /api/business
 * Returns stored business info
 */
router.get('/', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const info = Store.getBusinessInfo();
    (res as any).sendResponse(200, { success: true, data: info });
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

/**
 * PUT /api/business
 * Update business info (partial fields allowed)
 */
router.put('/', verifyToken, validator(updateBusinessInfo), async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      name = undefined,
      working_hours = undefined,
      location_url = undefined,
      shipping_details = undefined,
      instagram_url = undefined,
      website_url = undefined,
      mobile_numbers = undefined,
    } = req.body || {};

    Store.setBusinessInfo({
      name,
      working_hours,
      location_url,
      shipping_details,
      instagram_url,
      website_url,
      mobile_numbers,
    });

    const updated = Store.getBusinessInfo();
    (res as any).sendResponse(200, { success: true, message: 'Business info updated', data: updated });
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

/**
 * POST /api/business/refresh
 * Attempt to fetch business info from WhatsApp (Baileys) and persist
 */
router.post('/refresh', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await WhatsAppService.refreshBusinessInfo();
    (res as any).sendResponse(200, { success: true, ...result });
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

export default router;