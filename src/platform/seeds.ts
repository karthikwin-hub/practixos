/**
 * Onboarding copies one of these documents into rows. Runtime reads the rows.
 * Callers copy one document into rows at onboarding. Later requests read those rows.
 */
export interface StageSeed {
  labelKey: string;
  role: "pre_arrival" | "waiting" | "in_service" | "post_service" | "settlement";
  dwell: number | null;
}

export interface VerticalSeed {
  modules: string[];
  prepayRequired: boolean;
  stages: StageSeed[];
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
  },
  dermatology: {
    modules: ["portal", "queue", "triage", "billing"],
    prepayRequired: false,
    stages: dentalStages,
  },
  paediatrics: {
    modules: ["portal", "queue", "triage", "billing"],
    prepayRequired: false,
    stages: dentalStages,
  },
  mental_health: {
    modules: ["portal", "queue", "vault", "billing"],
    prepayRequired: true,
    stages: [
      { labelKey: "stageExpected", role: "pre_arrival", dwell: null },
      { labelKey: "stageConsult", role: "in_service", dwell: null },
      { labelKey: "stageBilling", role: "post_service", dwell: null },
    ],
  },
  polyclinic: {
    modules: ["portal", "queue", "triage", "charting", "vault", "billing"],
    prepayRequired: false,
    stages: dentalStages,
  },
};

export function seedFor(vertical: string): VerticalSeed {
  const seed = verticalSeeds[vertical];
  if (!seed) {
    throw Object.assign(new Error("unknown vertical"), { statusCode: 400 });
  }
  return seed;
}
