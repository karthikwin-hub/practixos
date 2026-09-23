/**
 * Onboarding copies one of these documents into rows. Runtime reads the rows.
 * Callers copy one document into rows at onboarding. Later requests read those rows.
 */
export interface StageSeed {
  labelKey: string;
  role: "pre_arrival" | "waiting" | "in_service" | "post_service" | "settlement";
  dwell: number | null;
}

export interface WorkOrderSeed {
  typeKey: string;
  required: string[];
}

export interface RecallSeed {
  trigger: "procedure_completed" | "plan_dormant" | "age_months" | "last_visit";
  offsetDays: number;
  templateKey: string;
}

export interface VerticalSeed {
  modules: string[];
  prepayRequired: boolean;
  stages: StageSeed[];
  workOrders: WorkOrderSeed[];
  recalls: RecallSeed[];
}

const dentalStages: StageSeed[] = [
  { labelKey: "stageExpected", role: "pre_arrival", dwell: null },
  { labelKey: "stageWaiting", role: "waiting", dwell: null },
  { labelKey: "stageConsult", role: "in_service", dwell: null },
  { labelKey: "stageBilling", role: "post_service", dwell: null },
];

export const verticalSeeds: Record<string, VerticalSeed> = {
  dental: {
    modules: ["portal", "queue", "triage", "charting", "billing"],
    prepayRequired: false,
    stages: dentalStages,
    workOrders: [{ typeKey: "restoration", required: ["tooth", "restoration", "shade"] }],
    recalls: [{ trigger: "last_visit", offsetDays: 180, templateKey: "checkup" }],
  },
  ophthalmology: {
    modules: ["portal", "queue", "triage", "billing"],
    prepayRequired: false,
    stages: [
      { labelKey: "stageExpected", role: "pre_arrival", dwell: null },
      { labelKey: "stageWaiting", role: "waiting", dwell: null },
      { labelKey: "stageDilation", role: "waiting", dwell: 20 },
      { labelKey: "stageConsult", role: "in_service", dwell: null },
      { labelKey: "stageBilling", role: "post_service", dwell: null },
    ],
    workOrders: [{ typeKey: "optical", required: ["prescription", "due"] }],
    recalls: [{ trigger: "last_visit", offsetDays: 365, templateKey: "refraction" }],
  },
  dermatology: {
    modules: ["portal", "queue", "triage", "billing"],
    prepayRequired: false,
    stages: dentalStages,
    workOrders: [],
    recalls: [],
  },
  paediatrics: {
    modules: ["portal", "queue", "triage", "billing"],
    prepayRequired: false,
    stages: dentalStages,
    workOrders: [],
    recalls: [],
  },
  mental_health: {
    modules: ["portal", "queue", "vault", "billing"],
    prepayRequired: true,
    stages: [
      { labelKey: "stageExpected", role: "pre_arrival", dwell: null },
      { labelKey: "stageConsult", role: "in_service", dwell: null },
      { labelKey: "stageBilling", role: "post_service", dwell: null },
    ],
    workOrders: [],
    recalls: [],
  },
  polyclinic: {
    modules: ["portal", "queue", "triage", "charting", "vault", "billing"],
    prepayRequired: false,
    stages: dentalStages,
    workOrders: [{ typeKey: "restoration", required: ["tooth", "restoration", "shade"] }],
    recalls: [{ trigger: "last_visit", offsetDays: 180, templateKey: "checkup" }],
  },
};

export function seedFor(vertical: string): VerticalSeed {
  const seed = verticalSeeds[vertical];
  if (!seed) {
    throw Object.assign(new Error("unknown vertical"), { statusCode: 400 });
  }
  return seed;
}
