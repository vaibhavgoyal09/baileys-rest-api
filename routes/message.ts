import express, { Request, Response } from 'express';

const router = express.Router();
import verifyToken from '../middlewares/verifyToken.js';
import validator from '../middlewares/validator.js';
import WhatsAppService from '../services/baileys.js';
import { sendText, checkNumber } from '../validators/message.js';

router.post('/check-number', verifyToken, validator(checkNumber), async (req: Request, res: Response): Promise<void> => {
  try {
    const { to } = req.body;
    const result = await WhatsAppService.checkNumber(to);
    (res as any).sendResponse(200, result);
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

router.post('/send-text', verifyToken, validator(sendText), async (req: Request, res: Response): Promise<void> => {
  try {
    const { to, message } = req.body;
    const result = await WhatsAppService.sendMessage(to, message);
    if (result.status === 1) {
      (res as any).sendResponse(200, result);
    } else {
      (res as any).sendError(400, result);
    }
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

export default router;