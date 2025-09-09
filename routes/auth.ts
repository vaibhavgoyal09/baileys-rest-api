import express, { Request, Response } from "express";
import { signJwt, verifyJwt } from "../utils/jwt.js";
import prisma from "../services/prisma.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import validator from "../middlewares/validator.js";
import { registerSchema, loginSchema } from "../validators/user.js";
import ConfigStore from "../services/prismaConfigStore.js";
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
      const { username, webhook_url } = req.body || {};

      if (webhook_url !== undefined) {
        await ConfigStore.upsertUserConfig(username, {
          webhook_url: webhook_url ?? null,
        });
      } else {
        // ensure user exists
        await ConfigStore.upsertUserConfig(username, { webhook_url: null });
      }

      const token = signJwt({ userId: username });
      (res as any).sendResponse(200, {
        success: true,
        token,
        token_type: "Bearer",
        username,
        webhook_url: await ConfigStore.getWebhookUrl(username),
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  },
);

router.post(
  "/register",
  validator(registerSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, email, password } = req.body;

      // Check if email already exists
      const existingEmail = await prisma.user.findUnique({
        where: { email },
      });

      if (existingEmail) {
        (res as any).sendResponse(400, {
          success: false,
          message: "Email already registered",
        });
        return;
      }

      // Generate unique username
      let username = `${email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '')}${crypto.randomBytes(4).toString('hex')}`;
      let existingUser = await prisma.user.findUnique({
        where: { username },
      });

      // Retry if username exists (unlikely but possible)
      let attempts = 0;
      while (existingUser && attempts < 5) {
        username = `${email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '')}${crypto.randomBytes(4).toString('hex')}`;
        existingUser = await prisma.user.findUnique({
          where: { username },
        });
        attempts++;
      }

      if (existingUser) {
        (res as any).sendError(500, { message: "Failed to generate unique username" });
        return;
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      await prisma.user.create({
        data: {
          username,
          name,
          email,
          hashedPassword,
          webhookUrl: null,
        },
      });

      await prisma.businessInfoTenant.create({
        data: { username },
      });

      const token = signJwt({ userId: username });
      (res as any).sendResponse(201, {
        success: true,
        token,
        token_type: "Bearer",
        username,
        webhook_url: null,
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  }
);

router.post(
  "/login",
  validator(loginSchema),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { username: loginInput, password } = req.body;

      // First try to find by username
      let user = await prisma.user.findUnique({
        where: { username: loginInput },
        select: { username: true, hashedPassword: true } as any,
      });

      // If not found and input looks like email, try finding by email
      if (!user && loginInput.includes('@')) {
        user = await prisma.user.findUnique({
          where: { email: loginInput },
          select: { username: true, hashedPassword: true } as any,
        });
      }

      if (!user) {
        (res as any).sendResponse(401, {
          success: false,
          message: "Invalid credentials",
        });
        return;
      }

      const isPasswordValid = await bcrypt.compare(password, (user as any)?.hashedPassword || '');

      if (!isPasswordValid) {
        (res as any).sendResponse(401, {
          success: false,
          message: "Invalid credentials",
        });
        return;
      }

      const actualUsername = (user as any).username;
      const token = signJwt({ userId: actualUsername });
      (res as any).sendResponse(200, {
        success: true,
        token,
        token_type: "Bearer",
        username: actualUsername,
        webhook_url: await ConfigStore.getWebhookUrl(actualUsername),
      });
    } catch (error) {
      (res as any).sendError(500, error);
    }
  }
);

router.get(
  "/user",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        (res as any).sendResponse(401, { success: false, message: "Unauthorized" });
        return;
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        (res as any).sendResponse(401, { success: false, message: "Invalid token" });
        return;
      }
      const payload = verifyJwt(token);
      const username = payload.userId;

      const user = await prisma.user.findUnique({
        where: { username },
        select: {
          name: true,
          email: true,
          webhookUrl: true,
          createdAt: true,
        },
      });

      if (!user) {
        (res as any).sendResponse(404, { success: false, message: "User not found" });
        return;
      }

      (res as any).sendResponse(200, {
        success: true,
        user: {
          name: user.name || "No name set",
          email: user.email || "No email set",
          webhookUrl: user.webhookUrl || "Not set",
          createdAt: user.createdAt.toLocaleString(),
        },
      });
    } catch (error) {
      console.error("Error fetching user info:", error);
      (res as any).sendError(500, { message: "Internal server error" });
    }
  }
);

export default router;
