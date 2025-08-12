import Database from 'better-sqlite3'
import { logger } from '../utils/logger'
import { Asset, AssetChain, ChangeRecord } from '../models/SyncTypes'
import { v4 as uuidv4 } from 'uuid'

export class DatabaseManager {
  private db: Database.Database
  constructor(private dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.ensureMetaTables()
    this.ensureChangeTriggers()
  }

  private ensureMetaTables() {
    // 创建业务基础表（若不存在）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS t_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        label TEXT,
        asset_ip TEXT,
        group_name TEXT,
        uuid TEXT UNIQUE,
        auth_type TEXT,
        port INTEGER,
        username TEXT,
        password TEXT,
        key_chain_id INTEGER,
        favorite INTEGER,
        asset_type TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS t_asset_chains (
        key_chain_id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        chain_name TEXT,
        chain_type TEXT,
        chain_private_key TEXT,
        chain_public_key TEXT,
        passphrase TEXT,
        uuid TEXT UNIQUE,
        version INTEGER NOT NULL DEFAULT 1
      );
    `)

    // 元数据与同步管理表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        last_sync_time TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_log (
        id TEXT PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_uuid TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        change_data TEXT,
        before_data TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        sync_status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        error_message TEXT
      );
    `)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `)
  }

  // 控制是否记录触发器（用于应用远端变更时抑制回声）
  setRemoteApplyGuard(enabled: boolean) {
    const flag = enabled ? '1' : null
    // 创建/更新标记
    if (enabled) {
      this.db.prepare(`INSERT INTO sync_meta(key, value) VALUES('apply_remote_guard', '1') ON CONFLICT(key) DO UPDATE SET value='1'`).run()
    } else {
      this.db.prepare(`DELETE FROM sync_meta WHERE key = 'apply_remote_guard'`).run()
    }
  }

  private ensureChangeTriggers() {
    // 资产表 INSERT/UPDATE/DELETE
    this.db.exec(`
      DROP TRIGGER IF EXISTS tr_assets_insert;
      CREATE TRIGGER IF NOT EXISTS tr_assets_insert AFTER INSERT ON t_assets
      WHEN (SELECT value FROM sync_meta WHERE key = 'apply_remote_guard') IS NULL
      BEGIN
        INSERT INTO change_log (id, table_name, record_uuid, operation_type, change_data)
        VALUES (hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(12)),
                't_assets_sync', NEW.uuid, 'INSERT', json_object(
                  'uuid', NEW.uuid,
                  'label', NEW.label,
                  'asset_ip', NEW.asset_ip,
                  'group_name', NEW.group_name,
                  'auth_type', NEW.auth_type,
                  'port', NEW.port,
                  'username', NEW.username,
                  'password', NEW.password,
                  'key_chain_id', NEW.key_chain_id,
                                  'favorite', NEW.favorite,
                'asset_type', NEW.asset_type,
                'created_at', NEW.created_at,
                'updated_at', NEW.updated_at,
                'version', NEW.version
              ));
      END;
    `)

    this.db.exec(`
      DROP TRIGGER IF EXISTS tr_assets_update;
      CREATE TRIGGER IF NOT EXISTS tr_assets_update AFTER UPDATE ON t_assets
      WHEN (SELECT value FROM sync_meta WHERE key = 'apply_remote_guard') IS NULL
      BEGIN
        INSERT INTO change_log (id, table_name, record_uuid, operation_type, change_data, before_data)
        VALUES (hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(12)),
                't_assets_sync', NEW.uuid, 'UPDATE', json_object(
                  'uuid', NEW.uuid,
                  'label', NEW.label,
                  'asset_ip', NEW.asset_ip,
                  'group_name', NEW.group_name,
                  'auth_type', NEW.auth_type,
                  'port', NEW.port,
                  'username', NEW.username,
                  'password', NEW.password,
                  'key_chain_id', NEW.key_chain_id,
                  'favorite', NEW.favorite,
                  'asset_type', NEW.asset_type,
                  'created_at', NEW.created_at,
                  'updated_at', NEW.updated_at,
                  'version', NEW.version
                ), json_object(
                  'uuid', OLD.uuid,
                  'label', OLD.label,
                  'asset_ip', OLD.asset_ip,
                  'group_name', OLD.group_name,
                  'auth_type', OLD.auth_type,
                  'port', OLD.port,
                  'username', OLD.username,
                  'password', OLD.password,
                  'key_chain_id', OLD.key_chain_id,
                  'favorite', OLD.favorite,
                  'asset_type', OLD.asset_type,
                  'created_at', OLD.created_at,
                  'updated_at', OLD.updated_at,
                  'version', OLD.version
                ));
      END;
    `)

    this.db.exec(`
      DROP TRIGGER IF EXISTS tr_assets_delete;
      CREATE TRIGGER IF NOT EXISTS tr_assets_delete AFTER DELETE ON t_assets
      WHEN (SELECT value FROM sync_meta WHERE key = 'apply_remote_guard') IS NULL
      BEGIN
        INSERT INTO change_log (id, table_name, record_uuid, operation_type, change_data, before_data)
        VALUES (hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(12)),
                't_assets_sync', OLD.uuid, 'DELETE', json_object('uuid', OLD.uuid, 'version', OLD.version), json_object('uuid', OLD.uuid, 'version', OLD.version));
      END;
    `)

    // 资产链表触发器
    this.db.exec(`
      DROP TRIGGER IF EXISTS tr_chains_insert;
      CREATE TRIGGER IF NOT EXISTS tr_chains_insert AFTER INSERT ON t_asset_chains
      WHEN (SELECT value FROM sync_meta WHERE key = 'apply_remote_guard') IS NULL
      BEGIN
        INSERT INTO change_log (id, table_name, record_uuid, operation_type, change_data)
        VALUES (hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(12)),
                't_asset_chains_sync', NEW.uuid, 'INSERT', json_object(
                  'key_chain_id', NEW.key_chain_id,
                  'uuid', NEW.uuid,
                  'chain_name', NEW.chain_name,
                  'chain_type', NEW.chain_type,
                  'chain_private_key', NEW.chain_private_key,
                  'chain_public_key', NEW.chain_public_key,
                  'passphrase', NEW.passphrase,
                  'created_at', NEW.created_at,
                  'updated_at', NEW.updated_at,
                  'version', NEW.version
                ));
      END;
    `)

    this.db.exec(`
      DROP TRIGGER IF EXISTS tr_chains_update;
      CREATE TRIGGER IF NOT EXISTS tr_chains_update AFTER UPDATE ON t_asset_chains
      WHEN (SELECT value FROM sync_meta WHERE key = 'apply_remote_guard') IS NULL
      BEGIN
        INSERT INTO change_log (id, table_name, record_uuid, operation_type, change_data, before_data)
        VALUES (hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(12)),
                't_asset_chains_sync', NEW.uuid, 'UPDATE', json_object(
                  'key_chain_id', NEW.key_chain_id,
                  'uuid', NEW.uuid,
                  'chain_name', NEW.chain_name,
                  'chain_type', NEW.chain_type,
                  'chain_private_key', NEW.chain_private_key,
                  'chain_public_key', NEW.chain_public_key,
                  'passphrase', NEW.passphrase,
                  'created_at', NEW.created_at,
                  'updated_at', NEW.updated_at,
                  'version', NEW.version
                ), json_object(
                  'key_chain_id', OLD.key_chain_id,
                  'uuid', OLD.uuid,
                  'chain_name', OLD.chain_name,
                  'chain_type', OLD.chain_type,
                  'chain_private_key', OLD.chain_private_key,
                  'chain_public_key', OLD.chain_public_key,
                  'passphrase', OLD.passphrase,
                  'created_at', OLD.created_at,
                  'updated_at', OLD.updated_at,
                  'version', OLD.version
                ));
      END;
    `)

    this.db.exec(`
      DROP TRIGGER IF EXISTS tr_chains_delete;
      CREATE TRIGGER IF NOT EXISTS tr_chains_delete AFTER DELETE ON t_asset_chains
      WHEN (SELECT value FROM sync_meta WHERE key = 'apply_remote_guard') IS NULL
      BEGIN
        INSERT INTO change_log (id, table_name, record_uuid, operation_type, change_data, before_data)
        VALUES (hex(randomblob(8)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(4)) || '-' || hex(randomblob(12)),
                't_asset_chains_sync', OLD.uuid, 'DELETE', json_object('uuid', OLD.uuid, 'version', OLD.version), json_object('uuid', OLD.uuid, 'version', OLD.version));
      END;
    `)
  }

  getLastSequenceId(): number {
    const row = this.db.prepare(`SELECT value FROM sync_meta WHERE key = 'last_sequence_id'`).get() as { value?: string } | undefined
    return row?.value ? Number(row.value) : 0
  }

  setLastSequenceId(seq: number) {
    const up = this.db.prepare(`INSERT INTO sync_meta(key, value) VALUES('last_sequence_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    up.run(String(seq))
  }

  getAssets(lastSyncTime?: Date): Asset[] {
    const sql = lastSyncTime ? `SELECT * FROM t_assets WHERE datetime(updated_at) > datetime(?)` : `SELECT * FROM t_assets`
    const stmt = this.db.prepare(sql)
    const rows = lastSyncTime ? stmt.all(lastSyncTime.toISOString()) : stmt.all()
    return rows as Asset[]
  }

  getAssetChains(lastSyncTime?: Date): AssetChain[] {
    const sql = lastSyncTime ? `SELECT * FROM t_asset_chains WHERE datetime(updated_at) > datetime(?)` : `SELECT * FROM t_asset_chains`
    const stmt = this.db.prepare(sql)
    const rows = lastSyncTime ? stmt.all(lastSyncTime.toISOString()) : stmt.all()
    return rows as AssetChain[]
  }

  getPendingChanges(): ChangeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM change_log WHERE sync_status = 'pending' ORDER BY datetime(created_at) ASC
    `)
    const rows = stmt.all()
    return rows.map((r: any) => ({
      ...r,
      change_data: r.change_data ? JSON.parse(r.change_data) : null,
      before_data: r.before_data ? JSON.parse(r.before_data) : null
    })) as ChangeRecord[]
  }

  /**
   * 分页获取待同步变更
   */
  getPendingChangesPage(tableName: string, limit: number, offset: number): ChangeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM change_log 
      WHERE sync_status = 'pending' AND table_name = ?
      ORDER BY datetime(created_at) ASC 
      LIMIT ? OFFSET ?
    `)
    const rows = stmt.all(tableName, limit, offset)
    return rows.map((r: any) => ({
      ...r,
      change_data: r.change_data ? JSON.parse(r.change_data) : null,
      before_data: r.before_data ? JSON.parse(r.before_data) : null
    })) as ChangeRecord[]
  }

  /**
   * 获取待同步变更总数
   */
  getTotalPendingChangesCount(tableName: string): number {
    const result = this.db
      .prepare(
        `
      SELECT COUNT(*) as count 
      FROM change_log 
      WHERE sync_status = 'pending' AND table_name = ?
    `
      )
      .get(tableName) as { count: number } | undefined
    return result?.count || 0
  }

  markChangesSynced(ids: string[]) {
    if (ids.length === 0) return
    const stmt = this.db.prepare(`UPDATE change_log SET sync_status = 'synced' WHERE id = ?`)
    const trx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(id)
    })
    trx(ids)
  }

  markChangesConflict(ids: string[], reason: string) {
    if (ids.length === 0) return
    const stmt = this.db.prepare(`UPDATE change_log SET sync_status = 'failed', error_message = ? WHERE id = ?`)
    const trx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(reason, id)
    })
    trx(ids)
  }

  bumpVersion(tableName: string, uuid: string, currentVersion: number) {
    if (!uuid || !currentVersion) return
    if (tableName === 't_assets_sync') {
      this.db.prepare(`UPDATE t_assets SET version = ?, updated_at = datetime('now') WHERE uuid = ?`).run(currentVersion + 1, uuid)
    } else if (tableName === 't_asset_chains_sync') {
      this.db.prepare(`UPDATE t_asset_chains SET version = ?, updated_at = datetime('now') WHERE uuid = ?`).run(currentVersion + 1, uuid)
    }
  }

  upsertAsset(asset: Asset) {
    const columns = [
      'uuid',
      'label',
      'asset_ip',
      'group_name',
      'auth_type',
      'port',
      'username',
      'password',
      'key_chain_id',
      'favorite',
      'asset_type',
      'created_at',
      'updated_at',
      'version'
    ]
    const placeholders = columns.map(() => '?').join(',')
    const values = columns.map((c) => (asset as any)[c])
    const sql = `INSERT INTO t_assets (${columns.join(',')}) VALUES (${placeholders})
      ON CONFLICT(uuid) DO UPDATE SET 
      label=excluded.label, asset_ip=excluded.asset_ip, group_name=excluded.group_name,
      auth_type=excluded.auth_type, port=excluded.port, username=excluded.username,
      password=excluded.password, key_chain_id=excluded.key_chain_id, favorite=excluded.favorite,
      asset_type=excluded.asset_type, updated_at=excluded.updated_at, version=excluded.version`
    this.db.prepare(sql).run(...values)
  }

  upsertAssetChain(chain: AssetChain) {
    const columns = [
      'key_chain_id',
      'uuid',
      'chain_name',
      'chain_type',
      'chain_private_key',
      'chain_public_key',
      'passphrase',
      'created_at',
      'updated_at',
      'version'
    ]
    const placeholders = columns.map(() => '?').join(',')
    const values = columns.map((c) => (chain as any)[c])
    const sql = `INSERT INTO t_asset_chains (${columns.join(',')}) VALUES (${placeholders})
      ON CONFLICT(uuid) DO UPDATE SET 
      chain_name=excluded.chain_name, chain_type=excluded.chain_type,
      chain_private_key=excluded.chain_private_key, chain_public_key=excluded.chain_public_key,
      passphrase=excluded.passphrase, updated_at=excluded.updated_at, version=excluded.version`
    this.db.prepare(sql).run(...values)
  }

  deleteAssetByUUID(uuid: string) {
    this.db.prepare(`DELETE FROM t_assets WHERE uuid = ?`).run(uuid)
  }

  deleteAssetChainByUUID(uuid: string) {
    this.db.prepare(`DELETE FROM t_asset_chains WHERE uuid = ?`).run(uuid)
  }

  getLastSyncTime(tableName: string): Date | null {
    const row = this.db.prepare(`SELECT last_sync_time FROM sync_status WHERE table_name = ?`).get(tableName) as
      | { last_sync_time?: string }
      | undefined
    return row?.last_sync_time ? new Date(row.last_sync_time) : null
  }

  setLastSyncTime(tableName: string, time: Date) {
    const exists = this.db.prepare(`SELECT 1 FROM sync_status WHERE table_name = ?`).get(tableName)
    if (exists) {
      this.db
        .prepare(`UPDATE sync_status SET last_sync_time = ?, updated_at = datetime('now') WHERE table_name = ?`)
        .run(time.toISOString(), tableName)
    } else {
      this.db.prepare(`INSERT INTO sync_status (table_name, last_sync_time) VALUES (?, ?)`).run(tableName, time.toISOString())
    }
  }

  /**
   * 获取数据库实例
   * 提供给新的同步管理器使用
   */
  async getDatabase(): Promise<DatabaseTransaction> {
    return new DatabaseTransaction(this.db)
  }
}

/**
 * 数据库事务包装器
 * 提供与新同步管理器兼容的接口
 */
class DatabaseTransaction {
  constructor(private db: Database.Database) {}

  async get(sql: string, params?: any[]): Promise<any> {
    return this.db.prepare(sql).get(params)
  }

  async all(sql: string, params?: any[]): Promise<any[]> {
    return this.db.prepare(sql).all(params)
  }

  async run(sql: string, params?: any[]): Promise<void> {
    this.db.prepare(sql).run(params)
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql)
  }

  async transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T> {
    const transaction = this.db.transaction(() => {
      return callback(this)
    })
    return transaction()
  }
}
