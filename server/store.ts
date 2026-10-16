import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Analysis, Principal } from "./contracts.js";
import { AppError } from "./contracts.js";
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,request_id))",
    );
  }
  insert(a: Analysis) {
    this.db
      .prepare("INSERT INTO analyses VALUES(?,?,?,?)")
      .run(a.id, a.owner, a.requestId, JSON.stringify(a));
  }
  save(a: Analysis) {
    a.updatedAt = Date.now();
    this.db
      .prepare("UPDATE analyses SET body=? WHERE id=? AND owner=?")
      .run(JSON.stringify(a), a.id, a.owner);
  }
  get(p: Principal, id: string): Analysis {
    const row = this.db
      .prepare("SELECT body FROM analyses WHERE id=? AND owner=?")
      .get(id, p.id);
    if (!row) throw new AppError(404, "analysis_not_found");
    return JSON.parse(row.body as string);
  }
  byRequest(p: Principal, key: string): Analysis | undefined {
    const row = this.db
      .prepare("SELECT body FROM analyses WHERE owner=? AND request_id=?")
      .get(p.id, key);
    return row ? JSON.parse(row.body as string) : undefined;
  }
  all(): Analysis[] {
    return this.db
      .prepare("SELECT body FROM analyses")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  list(p: Principal) {
    return this.all().filter((a) => a.owner === p.id);
  }
  close() {
    this.db.close();
  }
}
