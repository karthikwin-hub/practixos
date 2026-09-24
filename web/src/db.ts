import Dexie, { type Table } from "dexie";

export interface OutboxOp {
  seq?: number;
  id: string;
  kind: "walk_in" | "vitals" | "queue_move";
  updatedAt: string;
  body: Record<string, unknown>;
}

export interface LocalCard {
  id: string;
  name: string;
  tokenNo: number;
  stageId: string;
  patientId: string;
  alerts: string[];
}

class ClinicDb extends Dexie {
  outbox!: Table<OutboxOp, string>;
  cards!: Table<LocalCard, string>;

  constructor() {
    super("practixos");
    this.version(1).stores({
      outbox: "++seq",
      cards: "id",
    });
  }
}

export const db = new ClinicDb();
