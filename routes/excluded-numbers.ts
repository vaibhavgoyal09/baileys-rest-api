import express, { Request, Response } from "express";
import verifyToken from "../middlewares/verifyToken.js";
import validator from "../middlewares/validator.js";
import ConfigStore from "../services/prismaConfigStore.js";
import { addExcludedNumber, removeExcludedNumber } from "../validators/excluded-numbers.js";

const router = express.Router();

/**
 * GET /api/excluded-numbers
 * Returns list of excluded numbers for the authenticated tenant
 */
router.get(
  "/",
  verifyToken,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const username = (req as any).user?.userId as string;
      const excludedNumbers = await ConfigStore.getExcludedNumbers(username);
      (res as any).sendResponse(200, {
        success: true,
        data: excludedNumbers,
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

/**
 * POST /api/excluded-numbers
 * Add a phone number to the exclusion list
 */
router.post(
  "/",
  verifyToken,
  validator(addExcludedNumber),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const username = (req as any).user?.userId as string;
      const { phone_number } = req.body;

      const success = await ConfigStore.addExcludedNumber(username, phone_number);
      
      if (success) {
        (res as any).sendResponse(200, {
          success: true,
          message: "Phone number added to exclusion list",
          phone_number,
        });
      } else {
        (res as any).sendError(400, "Failed to add phone number to exclusion list");
      }
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

/**
 * DELETE /api/excluded-numbers/:phoneNumber
 * Remove a phone number from the exclusion list
 */
router.delete(
  "/:phoneNumber",
  verifyToken,
  validator(removeExcludedNumber),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const username = (req as any).user?.userId as string;
      const { phoneNumber } = req.params;

      if (!phoneNumber) {
        (res as any).sendError(400, "Phone number is required");
        return;
      }

      const success = await ConfigStore.removeExcludedNumber(username, phoneNumber);
      
      if (success) {
        (res as any).sendResponse(200, {
          success: true,
          message: "Phone number removed from exclusion list",
          phone_number: phoneNumber,
        });
      } else {
        (res as any).sendError(400, "Failed to remove phone number from exclusion list");
      }
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

export default router;