import { logger, errorLogger } from "../utils/logger.js";
import prisma from "./prisma.js";

export type Username = string;

type UpsertUserConfig = {
  webhook_url?: string | null;
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
          hashedPassword: '' // Bootstrap users without password
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

  async upsertUserConfig(username: Username, cfg: UpsertUserConfig): Promise<void> {
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
        last_updated: businessInfo.lastUpdated ? businessInfo.lastUpdated.getTime() : null,
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