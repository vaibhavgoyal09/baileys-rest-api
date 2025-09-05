import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { logger, errorLogger } from '../utils/logger.js';
import configStore from './configStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Migration script to handle data migration from single-tenant to multi-tenant architecture
 * This script migrates business info from the old whatsapp.db to the new config.db
 */
class MigrationService {
  private oldDbPath: string;

  constructor() {
    this.oldDbPath = path.join(__dirname, '..', 'data', 'whatsapp.db');
  }

  /**
   * Check if old database exists and has business info data
   */
  async shouldMigrate(): Promise<boolean> {
    try {
      if (!require('fs').existsSync(this.oldDbPath)) {
        logger.debug({ msg: 'Old database does not exist, skipping migration' });
        return false;
      }

      const oldDb = new Database(this.oldDbPath);
      const row = oldDb.prepare('SELECT COUNT(*) as count FROM business_info WHERE id = 1').get() as any;
      oldDb.close();

      return row.count > 0;
    } catch (error) {
      errorLogger.error({ msg: 'Error checking migration need', error: (error as Error).message });
      return false;
    }
  }

  /**
   * Migrate business info from old single-tenant to new multi-tenant storage
   * Uses 'default' as the tenant ID for migrated data
   */
  async migrateBusinessInfo(): Promise<void> {
    const tenantId = 'default';
    let oldDb: Database.Database | null = null;

    try {
      if (!require('fs').existsSync(this.oldDbPath)) {
        logger.info({ msg: 'Old database not found, skipping business info migration' });
        return;
      }

      oldDb = new Database(this.oldDbPath);
      const row = oldDb.prepare(`
        SELECT name, working_hours, location_url, shipping_details, 
               instagram_url, website_url, mobile_numbers, last_updated
        FROM business_info WHERE id = 1
      `).get() as any;

      if (!row) {
        logger.info({ msg: 'No business info found in old database, skipping migration' });
        return;
      }

      const businessInfo = {
        name: row.name ?? null,
        working_hours: row.working_hours ?? null,
        location_url: row.location_url ?? null,
        shipping_details: row.shipping_details ?? null,
        instagram_url: row.instagram_url ?? null,
        website_url: row.website_url ?? null,
        mobile_numbers: row.mobile_numbers ? JSON.parse(row.mobile_numbers) : null,
      };

      configStore.setBusinessInfo(tenantId, businessInfo);

      logger.info({
        msg: 'Business info migrated successfully',
        tenantId,
        migratedData: businessInfo
      });

    } catch (error) {
      errorLogger.error({ msg: 'Business info migration failed', error: (error as Error).message });
      throw error;
    } finally {
      if (oldDb) {
        oldDb.close();
      }
    }
  }

  /**
   * Initialize default tenant configuration if needed
   */
  async initializeDefaultTenant(): Promise<void> {
    const tenantId = 'default';
    
    try {
      // Ensure default tenant exists with empty config
      configStore.ensureTenant(tenantId);
      
      // If WEBHOOK_URL environment variable is set, use it for default tenant
      const webhookUrl = process.env.WEBHOOK_URL;
      if (webhookUrl) {
        configStore.upsertUserConfig(tenantId, { webhook_url: webhookUrl });
        logger.info({
          msg: 'Default tenant webhook URL set from environment variable',
          tenantId,
          webhookUrl
        });
      }
      
      logger.debug({ msg: 'Default tenant initialized', tenantId });
    } catch (error) {
      errorLogger.error({ msg: 'Default tenant initialization failed', error: (error as Error).message });
    }
  }

  /**
   * Run all migration steps
   */
  async runMigrations(): Promise<void> {
    try {
      logger.info({ msg: 'Starting data migration process' });

      // Initialize default tenant first
      await this.initializeDefaultTenant();

      // Check if migration is needed and perform it
      const shouldMigrate = await this.shouldMigrate();
      if (shouldMigrate) {
        logger.info({ msg: 'Migration needed, proceeding with data migration' });
        await this.migrateBusinessInfo();
      } else {
        logger.info({ msg: 'No migration needed, skipping data migration' });
      }

      logger.info({ msg: 'Data migration process completed successfully' });
    } catch (error) {
      errorLogger.error({ msg: 'Data migration process failed', error: (error as Error).message });
      throw error;
    }
  }
}

// Export singleton instance
const migrationService = new MigrationService();
export default migrationService;