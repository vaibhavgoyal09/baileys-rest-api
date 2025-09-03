import express, { Request, Response } from 'express';
import QRCode from 'qrcode';

const router = express.Router();
import verifyToken from '../middlewares/verifyToken.js';
import WhatsAppService from '../services/baileys.js';

async function generateQRBase64(text: string): Promise<string> {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 256,
      margin: 1,
    });
  } catch (error: any) {
    throw new Error(`QR Code Generation Error: ${error.message}`);
  }
}

router.post('/start', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await WhatsAppService.initialize();

    if (!result.success) {
      (res as any).sendError(500, result);
      return;
    }

    if (result.status === 'waiting_qr' && result.qr) {
      const qrBase64 = await generateQRBase64(result.qr);
      (res as any).sendResponse(200, {
        ...result,
        qrBase64,
      });
      return;
    }

    (res as any).sendResponse(200, result);
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

router.get('/status', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const status = WhatsAppService.getConnectionStatus();

    if (status.qr) {
      status.qrBase64 = await generateQRBase64(status.qr);
    }

    (res as any).sendResponse(200, {
      success: true,
      ...status,
    });
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

router.post('/logout', verifyToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await WhatsAppService.logout();
    if (result.success) {
      (res as any).sendResponse(200, result);
    } else {
      (res as any).sendError(400, result);
    }
  } catch (error) {
    (res as any).sendError(500, error);
  }
});

export default router;