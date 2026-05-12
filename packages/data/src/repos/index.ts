/** Repository bundle: one factory that wires every table-level repo. */

import type { Db } from "../db.js";

import { AccountSnapshotRepo } from "./account-snapshot-repo.js";
import { AuditEventRepo } from "./audit-event-repo.js";
import { BarRepo } from "./bar-repo.js";
import { ConfigSettingRepo } from "./config-setting-repo.js";
import { OrderLogRepo } from "./order-log-repo.js";
import { SessionRepo } from "./session-repo.js";
import { SignalLogRepo } from "./signal-log-repo.js";
import { TradeRepo } from "./trade-repo.js";
import { ValidationIssueRepo } from "./validation-issue-repo.js";

export {
  AccountSnapshotRepo,
  AuditEventRepo,
  BarRepo,
  ConfigSettingRepo,
  OrderLogRepo,
  SessionRepo,
  SignalLogRepo,
  TradeRepo,
  ValidationIssueRepo,
};

export interface Repos {
  bars: BarRepo;
  sessions: SessionRepo;
  signals: SignalLogRepo;
  trades: TradeRepo;
  orders: OrderLogRepo;
  snapshots: AccountSnapshotRepo;
  validation: ValidationIssueRepo;
  audit: AuditEventRepo;
  config: ConfigSettingRepo;
}

export function buildRepos(db: Db): Repos {
  return {
    bars: new BarRepo(db),
    sessions: new SessionRepo(db),
    signals: new SignalLogRepo(db),
    trades: new TradeRepo(db),
    orders: new OrderLogRepo(db),
    snapshots: new AccountSnapshotRepo(db),
    validation: new ValidationIssueRepo(db),
    audit: new AuditEventRepo(db),
    config: new ConfigSettingRepo(db),
  };
}
