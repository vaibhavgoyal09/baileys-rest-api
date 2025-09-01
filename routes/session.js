require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');

const router = express.Router();
const verifyToken = require('../middlewares/verifyToken');
const WhatsAppService = require('../services/baileys');

async function generateQRBase64(text) {
  try {
    return await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 256,
      margin: 1,
    });
  } catch (error) {
    throw new Error(`QR Code Generation Error: ${error.message}`);
  }
}

router.post('/start', verifyToken, async (req, res) => {
  try {
    const result = await WhatsAppService.initialize();

    if (!result.success) {
      res.sendError(500, result);
      return;
    }

    if (result.status === 'waiting_qr') {
      const qrBase64 = await generateQRBase64(result.qr);
      res.sendResponse(200, {
        ...result,
        qrBase64,
      });
      return;
    }

    res.sendResponse(200, result);
  } catch (error) {
    res.sendError(500, error);
  }
});

router.get('/status', verifyToken, async (req, res) => {
  try {
    const status = WhatsAppService.getConnectionStatus();

    if (status.qr) {
      status.qrBase64 = await generateQRBase64(status.qr);
    }

    res.sendResponse(200, {
      success: true,
      ...status,
    });
  } catch (error) {
    res.sendError(500, error);
  }
});

router.post('/logout', verifyToken, async (req, res) => {
  try {
    const result = await WhatsAppService.logout();
    if (result.success) {
      res.sendResponse(200, result);
    } else {
      res.sendError(400, result);
    }
  } catch (error) {
    res.sendError(500, error);
  }
});

module.exports = router;
