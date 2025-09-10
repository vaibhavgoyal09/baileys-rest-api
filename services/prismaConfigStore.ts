import { logger, errorLogger } from "../utils/logger.js";
import prisma from "./prisma.js";
import crypto from "crypto";

export type Username = string;

type UpsertUserConfig = {
  webhook_url?: string | null;
};

type WebhookData = {
  id?: string;
  url: string;
  name?: string | null;
  secret?: string;
  isActive?: boolean;
};

type BusinessInfo = {
  name?: string | null;
  working_hours?: string | null;
  location_url?: string | null;
  shipping_details?: string | null;
  instagram_url?: string | null;
  website_url?: string | null;
  mobile_numbers?: string[] | null;
};

class PrismaConfigStore {
  constructor() {
    logger.info("Prisma config store initialized");
  }

  async ensureTenant(username: Username): Promise<void> {
    try {
      await prisma.user.upsert({
        where: { username },
        update: {},
        create: {
          username,
          name: username, // Use username as default name
          email: `${username}@bootstrap.local`, // Placeholder email
          hashedPassword: "", // Bootstrap users without password
        },
      });

      await prisma.businessInfoTenant.upsert({
        where: { username },
        update: {},
        create: { username },
      });
    } catch (e) {
      errorLogger.error({
        msg: "ensureTenant failed",
        username,
        error: (e as Error)?.message || e,
      });
    }
  }

  async getWebhookUrl(username: Username): Promise<string | null> {
    try {
      // First try to get from new webhooks table
      const webhooks = await this.getWebhooks(username);
      const activeWebhook = webhooks.find((w) => w.isActive);
      if (activeWebhook) {
        return activeWebhook.url;
      }

      // Fallback to legacy webhookUrl field for backward compatibility
      const user = await prisma.user.findUnique({
        where: { username },
        select: { webhookUrl: true },
      });
      return user?.webhookUrl || null;
    } catch (e) {
      errorLogger.error({
        msg: "getWebhookUrl failed",
        username,
        error: (e as Error)?.message || e,
      });
      return null;
    }
  }

  async getWebhooks(username: Username): Promise<WebhookData[]> {
    try {
      await this.ensureTenant(username);
      const webhooks = await prisma.webhook.findMany({
        where: { username },
        orderBy: { createdAt: "asc" },
      });
      return webhooks.map((w) => ({
        id: w.id,
        url: w.url,
        name: w.name,
        secret: w.secret,
        isActive: w.isActive,
      }));
    } catch (e) {
      errorLogger.error({
        msg: "getWebhooks failed",
        username,
        error: (e as Error)?.message || e,
      });
      return [];
    }
  }

  async addWebhook(
    username: Username,
    webhookData: Omit<WebhookData, "id">,
  ): Promise<string | null> {
    try {
      await this.ensureTenant(username);
      // Generate a random secret for webhook verification
      const secret = webhookData.secret || crypto.randomBytes(32).toString('hex');

      const webhook = await prisma.webhook.create({
        data: {
          url: webhookData.url,
          username,
          name: webhookData.name || null,
          secret,
          isActive: webhookData.isActive ?? true,
        },
      });
      return webhook.id;
    } catch (e) {
      errorLogger.error({
        msg: "addWebhook failed",
        username,
        error: (e as Error)?.message || e,
      });
      return null;
    }
  }

  async updateWebhook(
    username: Username,
    webhookId: string,
    webhookData: Partial<WebhookData>,
  ): Promise<boolean> {
    try {
      const updateData: any = {};
      if (webhookData.url !== undefined) updateData.url = webhookData.url;
      if (webhookData.name !== undefined) updateData.name = webhookData.name;
      if (webhookData.isActive !== undefined)
        updateData.isActive = webhookData.isActive;

      await prisma.webhook.updateMany({
        where: {
          id: webhookId,
          username,
        },
        data: updateData,
      });
      return true;
    } catch (e) {
      errorLogger.error({
        msg: "updateWebhook failed",
        username,
        webhookId,
        error: (e as Error)?.message || e,
      });
      return false;
    }
  }

  async deleteWebhook(username: Username, webhookId: string): Promise<boolean> {
    try {
      await prisma.webhook.deleteMany({
        where: {
          id: webhookId,
          username,
        },
      });
      return true;
    } catch (e) {
      errorLogger.error({
        msg: "deleteWebhook failed",
        username,
        webhookId,
        error: (e as Error)?.message || e,
      });
      return false;
    }
  }

  async upsertUserConfig(
    username: Username,
    cfg: UpsertUserConfig,
  ): Promise<void> {
    try {
      await this.ensureTenant(username);
      await prisma.user.update({
        where: { username },
        data: {
          webhookUrl: cfg.webhook_url ?? null,
        },
      });
    } catch (e) {
      errorLogger.error({
        msg: "upsertUserConfig failed",
        username,
        error: (e as Error)?.message || e,
      });
    }
  }

  async getBusinessInfo(
    username: Username,
  ): Promise<Required<BusinessInfo> & { last_updated: number | null }> {
    try {
      const businessInfo = await prisma.businessInfoTenant.findUnique({
        where: { username },
      });

      if (!businessInfo) {
        return {
          name: null,
          working_hours: null,
          location_url: null,
          shipping_details: null,
          instagram_url: null,
          website_url: null,
          mobile_numbers: null as any,
          last_updated: null,
        };
      }

      return {
        name: businessInfo.name,
        working_hours: businessInfo.workingHours,
        location_url: businessInfo.locationUrl,
        shipping_details: businessInfo.shippingDetails,
        instagram_url: businessInfo.instagramUrl,
        website_url: businessInfo.websiteUrl,
        mobile_numbers: businessInfo.mobileNumbers
          ? JSON.parse(businessInfo.mobileNumbers)
          : null,
        last_updated: businessInfo.lastUpdated
          ? businessInfo.lastUpdated.getTime()
          : null,
      };
    } catch (e) {
      errorLogger.error({
        msg: "getBusinessInfo failed",
        username,
        error: (e as Error)?.message || e,
      });
      return {
        name: null,
        working_hours: null,
        location_url: null,
        shipping_details: null,
        instagram_url: null,
        website_url: null,
        mobile_numbers: null,
        last_updated: null,
      };
    }
  }

  async setBusinessInfo(username: Username, info: BusinessInfo): Promise<void> {
    try {
      await this.ensureTenant(username);
      const current = await this.getBusinessInfo(username);

      const merged: Required<BusinessInfo> = {
        name: info.name !== undefined ? info.name : current.name,
        working_hours:
          info.working_hours !== undefined
            ? info.working_hours
            : current.working_hours,
        location_url:
          info.location_url !== undefined
            ? info.location_url
            : current.location_url,
        shipping_details:
          info.shipping_details !== undefined
            ? info.shipping_details
            : current.shipping_details,
        instagram_url:
          info.instagram_url !== undefined
            ? info.instagram_url
            : current.instagram_url,
        website_url:
          info.website_url !== undefined
            ? info.website_url
            : current.website_url,
        mobile_numbers:
          info.mobile_numbers !== undefined
            ? info.mobile_numbers
            : (current as any).mobile_numbers,
      };

      await prisma.businessInfoTenant.update({
        where: { username },
        data: {
          name: merged.name ?? null,
          workingHours: merged.working_hours ?? null,
          locationUrl: merged.location_url ?? null,
          shippingDetails: merged.shipping_details ?? null,
          instagramUrl: merged.instagram_url ?? null,
          websiteUrl: merged.website_url ?? null,
          mobileNumbers: merged.mobile_numbers
            ? JSON.stringify(merged.mobile_numbers)
            : null,
        },
      });
    } catch (e) {
      errorLogger.error({
        msg: "setBusinessInfo failed",
        username,
        error: (e as Error)?.message || e,
      });
    }
  }
}

const configStore = new PrismaConfigStore();
export default configStore;
