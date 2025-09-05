import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { logger, errorLogger } from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TenantId = string;

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

class ConfigStore {
  private dbFilePath: string;
  private db: Database.Database;

  constructor(
    dbFilePath: string = path.join(__dirname, "..", "data", "config.db"),
  ) {
    this.dbFilePath = dbFilePath;
    ConfigStore.ensureDir(path.dirname(this.dbFilePath));
    this.db = new Database(this.dbFilePath);
    this.initSchema();
    logger.info({
      msg: "Config store initialized",
      dbFilePath: this.dbFilePath,
    });
  }

  static ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  private initSchema(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        tenant_id TEXT PRIMARY KEY,
        webhook_url TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );

      CREATE TABLE IF NOT EXISTS business_info (
        tenant_id TEXT PRIMARY KEY,
        name TEXT,
        working_hours TEXT,
        location_url TEXT,
        shipping_details TEXT,
        instagram_url TEXT,
        website_url TEXT,
        mobile_numbers TEXT,
        last_updated INTEGER DEFAULT (strftime('%s','now'))
      );

      CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bizinfo_updated_at ON business_info(last_updated DESC);
    `);
  }

  ensureTenant(tenantId: TenantId): void {
    try {
      this.db
        .prepare(`INSERT OR IGNORE INTO users (tenant_id) VALUES (@tenant_id)`)
        .run({ tenant_id: tenantId });
      this.db
        .prepare(
          `INSERT OR IGNORE INTO business_info (tenant_id) VALUES (@tenant_id)`,
        )
        .run({ tenant_id: tenantId });
    } catch (e) {
      errorLogger.error({
        msg: "ensureTenant failed",
        tenantId,
        error: (e as Error)?.message || e,
      });
    }
  }

  getWebhookUrl(tenantId: TenantId): string | null {
    try {
      const row = this.db
        .prepare(`SELECT webhook_url FROM users WHERE tenant_id = @tenant_id`)
        .get({ tenant_id: tenantId }) as any;
      return row?.webhook_url || null;
    } catch (e) {
      errorLogger.error({
        msg: "getWebhookUrl failed",
        tenantId,
        error: (e as Error)?.message || e,
      });
      return null;
    }
  }

  upsertUserConfig(tenantId: TenantId, cfg: UpsertUserConfig): void {
    try {
      this.ensureTenant(tenantId);
      this.db
        .prepare(
          `
          INSERT INTO users (tenant_id, webhook_url, updated_at)
          VALUES (@tenant_id, @webhook_url, strftime('%s','now'))
          ON CONFLICT(tenant_id) DO UPDATE SET
            webhook_url = COALESCE(excluded.webhook_url, users.webhook_url),
            updated_at = excluded.updated_at
        `,
        )
        .run({
          tenant_id: tenantId,
          webhook_url: cfg.webhook_url ?? null,
        });
    } catch (e) {
      errorLogger.error({
        msg: "upsertUserConfig failed",
        tenantId,
        error: (e as Error)?.message || e,
      });
    }
  }

  getBusinessInfo(
    tenantId: TenantId,
  ): Required<BusinessInfo> & { last_updated: number | null } {
    try {
      const row = this.db
        .prepare(
          `SELECT name, working_hours, location_url, shipping_details, instagram_url, website_url, mobile_numbers, last_updated
           FROM business_info WHERE tenant_id = @tenant_id`,
        )
        .get({ tenant_id: tenantId }) as any;

      if (!row) {
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
        name: row.name ?? null,
        working_hours: row.working_hours ?? null,
        location_url: row.location_url ?? null,
        shipping_details: row.shipping_details ?? null,
        instagram_url: row.instagram_url ?? null,
        website_url: row.website_url ?? null,
        mobile_numbers: row.mobile_numbers
          ? JSON.parse(row.mobile_numbers)
          : null,
        last_updated: row.last_updated ? Number(row.last_updated) : null,
      };
    } catch (e) {
      errorLogger.error({
        msg: "getBusinessInfo failed",
        tenantId,
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

  setBusinessInfo(tenantId: TenantId, info: BusinessInfo): void {
    try {
      this.ensureTenant(tenantId);
      const current = this.getBusinessInfo(tenantId);

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

      this.db
        .prepare(
          `
          INSERT INTO business_info (
            tenant_id, name, working_hours, location_url, shipping_details, instagram_url, website_url, mobile_numbers, last_updated
          ) VALUES (
            @tenant_id, @name, @working_hours, @location_url, @shipping_details, @instagram_url, @website_url, @mobile_numbers, strftime('%s','now')
          )
          ON CONFLICT(tenant_id) DO UPDATE SET
            name = excluded.name,
            working_hours = excluded.working_hours,
            location_url = excluded.location_url,
            shipping_details = excluded.shipping_details,
            instagram_url = excluded.instagram_url,
            website_url = excluded.website_url,
            mobile_numbers = excluded.mobile_numbers,
            last_updated = excluded.last_updated
        `,
        )
        .run({
          tenant_id: tenantId,
          name: merged.name ?? null,
          working_hours: merged.working_hours ?? null,
          location_url: merged.location_url ?? null,
          shipping_details: merged.shipping_details ?? null,
          instagram_url: merged.instagram_url ?? null,
          website_url: merged.website_url ?? null,
          mobile_numbers: merged.mobile_numbers
            ? JSON.stringify(merged.mobile_numbers)
            : null,
        });
    } catch (e) {
      errorLogger.error({
        msg: "setBusinessInfo failed",
        tenantId,
        error: (e as Error)?.message || e,
      });
    }
  }
}

const configStore = new ConfigStore();
export default configStore;
