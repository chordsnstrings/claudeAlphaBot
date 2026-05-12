import { eq } from "drizzle-orm";

import type { Db } from "../db.js";
import {
  configSetting,
  type ConfigSettingRow,
  type NewConfigSettingRow,
} from "../schema/config-setting.js";

export class ConfigSettingRepo {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<ConfigSettingRow | null> {
    const rows = await this.db
      .select()
      .from(configSetting)
      .where(eq(configSetting.key, key))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Upsert with audit: stores the prior value into previous_value. */
  async set(
    key: string,
    value: NewConfigSettingRow["value"],
    updatedBy: string,
  ): Promise<ConfigSettingRow> {
    const prev = await this.get(key);
    const now = new Date();
    const prevValue = prev?.value ?? null;
    const out = await this.db
      .insert(configSetting)
      .values({ key, value, updatedAt: now, updatedBy, previousValue: prevValue })
      .onConflictDoUpdate({
        target: configSetting.key,
        set: {
          value,
          updatedAt: now,
          updatedBy,
          previousValue: prevValue,
        },
      })
      .returning();
    const first = out[0];
    if (first === undefined) {
      throw new Error("config_setting upsert returned no rows");
    }
    return first;
  }
}
