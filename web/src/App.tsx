import { useEffect, useRef, useState } from "react";
import { db, type LocalCard } from "./db";

type Stage = { id: string; label_key: string; role: string; dwell_alert_mins?: number | null };
type Card = LocalCard & { dwell?: boolean; practitioner?: string };
type Quadrant = { id: string; label: string; teeth: number[] };
type ToothState = { label: string; colour: string; pattern: string | null };
type Practice = {
  rules: { id: string; trigger: string; offset_days: number; template_key: string }[];
  recalls: { id: string; due_on: string; state: string; template_key: string; full_name: string }[];
  packages: { id: string; name: string; sessions: number; price_paise: number }[];
  held: { id: string; sessions_used: number; name: string; sessions: number; full_name: string }[];
  batches: { id: string; name: string; batch_no: string; expires_on: string; qty_remaining: number }[];
  relationships: { id: string; relationship: string; may_book: boolean; may_consent: boolean; may_view_clinical: boolean; guardian: string; dependant: string }[];
};

const labels: Record<string, string> = {
  stageExpected: "Expected Today",
  stageWaiting: "Waiting Room",
  stageConsult: "In Consultation",
  stageBilling: "Billing / Exit",
  stageDilation: "Waiting for dilation",
};

const nav = [
  { hash: "#/desk", tab: "Board" },
  { hash: "#/nurse", tab: "Slate" },
  { hash: "#/chart", tab: "Chairside" },
  { hash: "#/quiet", tab: "Quiet" },
  { hash: "#/recalls", tab: "Recalls" },
  { hash: "#/practice", tab: "Practice" },
  { hash: "#/settle", tab: "Route" },
  { hash: "#/ledger", tab: "Ledger" },
  { hash: "#/book", tab: "Doorway" },
];

function modeFor(hash: string): string {
  if (hash.startsWith("#/book")) return "doorway";
  if (hash.startsWith("#/nurse")) return "slate";
  if (hash.startsWith("#/chart")) return "chairside";
  if (hash.startsWith("#/quiet")) return "quiet";
  if (hash.startsWith("#/settle")) return "route";
  if (hash.startsWith("#/ledger")) return "board";
  if (hash.startsWith("#/radar")) return "doorway";
  if (hash.startsWith("#/desk")) return "board";
  return "";
}

type UndoOffer = { id: number; label: string; run: () => void };
let undoSink: ((undo: UndoOffer | null) => void) | null = null;

function offerUndo(label: string, run: () => void): void {
  undoSink?.({ id: Date.now(), label, run });
}

const verticals = [
  ["dental", "Dentistry"],
  ["ophthalmology", "Ophthalmology"],
  ["dermatology", "Dermatology"],
  ["paediatrics", "Paediatrics"],
  ["mental_health", "Mental health"],
  ["polyclinic", "Polyclinic"],
] as const;

const languages = [
  ["en", "English"],
  ["mr", "मराठी"],
  ["te", "తెలుగు"],
  ["bn", "বাংলা"],
  ["kok", "कोंकणी"],
] as const;

function token(): string {
  return localStorage.getItem("practix.token") ?? "";
}

async function api(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

let flushing: Promise<void> | null = null;

async function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    const ops = await db.transaction("rw", db.outbox, async () => {
      const rows = await db.outbox.orderBy("seq").toArray();
      await db.outbox.clear();
      return rows;
    });
    if (ops.length === 0) return;
    try {
      await api("/api/sync", "POST", { ops });
    } catch (err) {
      await db.outbox.bulkAdd(ops.map((op) => ({
        id: op.id,
        kind: op.kind,
        updatedAt: op.updatedAt,
        body: op.body,
      })));
      throw err;
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

function stageName(stage: Stage): string {
  return labels[stage.label_key] ?? stage.label_key;
}

function inr(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN")}`;
}

export function App() {
  const [route, setRoute] = useState(location.hash || "#/setup");
  const [undo, setUndo] = useState<{ id: number; label: string; run: () => void } | null>(null);
  useEffect(() => {
    undoSink = setUndo;
    return () => { undoSink = null; };
  }, []);
  useEffect(() => {
    if (!undo) return undefined;
    const timer = window.setTimeout(() => setUndo(null), 8000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    const onHash = () => setRoute(location.hash || "#/setup");
    const apply = () => {
      const width = window.innerWidth;
      const hash = location.hash || "#/setup";
      document.documentElement.dataset.lay = width >= 1024 ? "desk" : width >= 600 ? "tab" : "phone";
      document.documentElement.dataset.mode = modeFor(hash);
    };
    apply();
    window.addEventListener("hashchange", onHash);
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("resize", apply);
    };
  }, []);

  if (route.startsWith("#/book") && !token()) {
    return (
      <main className="canvas doorway">
        <Doorway />
        {undo ? <UndoToast undo={undo} onDone={() => setUndo(null)} /> : null}
      </main>
    );
  }

  if (route.startsWith("#/radar") && !token()) {
    return (
      <main className="canvas doorway">
        <Radar />
      </main>
    );
  }

  if (route.startsWith("#/setup") || !token()) {
    return <Gate />;
  }

  const printing = route.startsWith("#/print");
  const radar = route.startsWith("#/radar");
  const current = printing || radar ? "" : (nav.find((item) => route.startsWith(item.hash))?.hash ?? "#/desk");
  const clinic = localStorage.getItem("practix.clinicName") ?? "Clinic";
  const mark = localStorage.getItem("practix.mark") ?? "Px";
  return (
    <>
      <div className="app">
        <nav className="rail" aria-label="Modules">
          <div className="rail-mark" title={clinic}>{mark}</div>
          {nav.map((item) => (
            <a key={item.hash} className="rail-btn" href={item.hash} aria-current={current === item.hash ? "true" : undefined}>{item.tab}</a>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <header className="topbar">
            <div className="tb-mark">{mark}</div>
            <div className="tb-id">
              <div className="tb-clinic">{clinic}</div>
              <div className="tb-sub">{nav.find((item) => item.hash === current)?.tab}</div>
            </div>
            <button className="tb-chip" type="button" onClick={() => { localStorage.removeItem("practix.token"); location.hash = "#/setup"; }}>Sign out</button>
          </header>
          <main className="canvas">
            {current === "#/desk" ? <Desk /> : null}
            {current === "#/nurse" ? <Nurse /> : null}
            {current === "#/chart" ? <Chart /> : null}
            {current === "#/quiet" ? <QuietRoom /> : null}
            {current === "#/recalls" ? <Recalls /> : null}
            {current === "#/practice" ? <Practice /> : null}
            {current === "#/settle" ? <Settlement /> : null}
            {current === "#/ledger" ? <Ledger /> : null}
            {radar ? <Radar /> : null}
            {current === "#/book" ? <Doorway /> : null}
            {route.startsWith("#/print") ? <PrintSheet /> : null}
          </main>
        </div>
      </div>
      <nav className="tabbar" aria-label="Modules">
        {nav.map((item) => (
          <a key={item.hash} className="tab-btn" href={item.hash} aria-current={current === item.hash ? "true" : undefined}><span>{item.tab}</span></a>
        ))}
      </nav>
      {undo ? <UndoToast undo={undo} onDone={() => setUndo(null)} /> : null}
    </>
  );
}

function UndoToast({ undo, onDone }: { undo: { label: string; run: () => void }; onDone: () => void }) {
  return (
    <div id="toasts">
      <div className="toast" role="status">
        <span className="t-x">{undo.label}</span>
        <button className="t-undo" type="button" onClick={() => { undo.run(); onDone(); }}>Undo</button>
      </div>
    </div>
  );
}

function Gate() {
  const [slug, setSlug] = useState("clinic");
  const [vertical, setVertical] = useState("dental");
  const [message, setMessage] = useState("");
  const [ready, setReady] = useState(false);
  return (
    <div className="gate">
      <div className="gate-in">
        <div className="gate-brand">
          <div className="m">Px</div>
          <div>
            <div style={{ fontWeight: 800 }}>PractixOS</div>
            <div className="muted" style={{ fontSize: ".74rem" }}>Practice Operating System</div>
          </div>
        </div>
        <div className="card">
          <div className="card-b">
            <div className="eyebrow mb">Open a workspace</div>
            <p className="muted" style={{ marginBottom: 12 }}>Set up a new practice. The host is the tenant. Nothing here reads another clinic.</p>
            <label className="field">
              <span className="lbl">Clinic slug</span>
              <input className="inp" value={slug} onChange={(event) => setSlug(event.target.value)} />
            </label>
            <div className="seg mb">
              {verticals.map(([id, name]) => (
                <button key={id} className={vertical === id ? "on" : ""} type="button" onClick={() => setVertical(id)}>{name}</button>
              ))}
            </div>
            <button
              className="btn btn-p btn-xl btn-full"
              type="button"
              onClick={() => {
                void (async () => {
                  const res = await fetch("/api/onboarding", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      legalName: slug,
                      slug,
                      vertical,
                      email: `owner@${slug}.test`,
                      password: "correct horse battery",
                      ownerName: "Owner",
                    }),
                  });
                  const body = await res.json() as { token?: string; error?: string };
                  if (!res.ok || !body.token) {
                    setMessage(body.error ?? "setup failed");
                    return;
                  }
                  localStorage.setItem("practix.token", body.token);
                  localStorage.setItem("practix.host", `${slug}.localhost`);
                  localStorage.setItem("practix.clinicName", slug);
                  localStorage.setItem("practix.mark", slug.slice(0, 2).toUpperCase());
                  setReady(true);
                  setMessage("Clinic is ready");
                })();
              }}
            >
              Create clinic
            </button>
            {message ? <p className="mt">{message}</p> : null}
          </div>
        </div>
        {ready ? <Wizard /> : null}
        <div className="mt">
          <a className="btn btn-g" href="#/book">Patient doorway</a>
        </div>
      </div>
    </div>
  );
}

function Wizard() {
  const [note, setNote] = useState("");
  async function step(name: string, body: unknown): Promise<void> {
    await api(`/api/onboarding/${name}`, "PATCH", body);
    setNote(`${name} saved`);
  }
  return (
    <div className="card mt">
      <div className="card-h"><div><h2>Finish the workspace</h2><p className="muted">Every step can be revisited.</p></div></div>
      <div className="card-b col">
        <button className="btn btn-g" type="button" onClick={() => void step("practitioners", { practitioners: [{ fullName: "Dr Rao" }] }).then(async () => {
          const state = await api("/api/onboarding") as { practitioners: { id: string }[] };
          localStorage.setItem("practix.practitionerId", state.practitioners[0]?.id ?? "");
        })}>Add Dr Rao</button>
        <button className="btn btn-g" type="button" onClick={() => void step("chairs", { chairs: [{ label: "Chair 1" }] })}>Add Chair 1</button>
        <button className="btn btn-g" type="button" onClick={() => void step("hours", {
          hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opens: "09:00", closes: "17:00" })),
          breaks: [],
        })}>Open 09:00–17:00</button>
        <button className="btn btn-g" type="button" onClick={() => void step("fees", { standardFeePaise: 50000, followupDays: 7 })}>Fee ₹500, follow-up 7 days</button>
        <button className="btn btn-g" type="button" onClick={() => void step("languages", { languages: ["en", "mr", "te", "bn", "kok"] })}>Five languages</button>
        <button className="btn btn-g" type="button" onClick={() => void step("profile", { displayName: localStorage.getItem("practix.clinicName"), registrationNo: "A-1", address: "Pune" })}>Letterhead</button>
        {note ? <p className="muted">{note}</p> : null}
        <a className="btn btn-p" href="#/desk">Open the board</a>
      </div>
    </div>
  );
}

function Doorway() {
  const [lang, setLang] = useState("en");
  const [text, setText] = useState("");
  const host = localStorage.getItem("practix.host") ?? "";
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    void fetch(`/api/portal/profile?lang=${lang}`, { headers: { host } })
      .then((res) => res.json())
      .then((body: { noApp?: string }) => setText(body.noApp ?? ""))
      .catch(() => setText(""));
  }, [lang, host]);
  return (
    <section className="grid">
      <div className="between mb">
        <div>
          <div className="eyebrow">Patient doorway</div>
          <h1>No app to download</h1>
        </div>
      </div>
      <div className="card">
        <div className="card-b">
          <div className="eyebrow mb">Choose your language</div>
          <div className="row">
            {languages.map(([code, name]) => (
              <button key={code} className={lang === code ? "btn btn-p" : "btn btn-g"} type="button" onClick={() => setLang(code)}>
                {name}{code === "kok" ? " (beta)" : ""}
              </button>
            ))}
          </div>
          <p className="reg-patient mt">{text}</p>
        </div>
      </div>
    </section>
  );
}

function Ledger() {
  const [body, setBody] = useState<{
    recoveredPaise: number; subscriptionPaise: number; breakEvenCount: number; valueSource: string;
    events: { id: string; eventType: string; amountPaise: number; evidenceRef: string }[];
    chairs: { availableMinutes: number; utilisedMinutes: number; perAvailableMinutePaise: number; perUtilisedMinutePaise: number };
    dhis: { accruedPaise: number; eligibleCount: number; floor: number; category2Paise: number };
  } | null>(null);
  useEffect(() => { void api("/api/owner").then((value) => setBody(value as NonNullable<typeof body>)).catch(() => setBody(null)); }, []);
  if (!body) return <p className="muted">The ledger is loading.</p>;
  return (
    <section className="grid">
      <div className="eyebrow">Practice ledger</div>
      <h1>Recovered revenue</h1>
      <div className="grid g2">
        <div className="card"><div className="card-b tight">
          <div className="eyebrow">Recovered this month</div>
          <div className="kpi">{inr(body.recoveredPaise)}</div>
          <p className="muted">Paid for by the {body.breakEvenCount}rd recovered event. Source: {body.valueSource}.</p>
        </div></div>
        <div className="card"><div className="card-b tight">
          <div className="eyebrow">Subscription</div>
          <div className="kpi">{inr(body.subscriptionPaise)}</div>
        </div></div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Evidence</h2></div>
        <div className="card-b dl">
          {body.events.map((event) => (
            <div key={event.id} className="dl-item">
              <div className="dl-t">{event.eventType}</div>
              <div className="dl-r"><span className="dl-k">{event.evidenceRef}</span><span className="dl-v">{inr(event.amountPaise)}</span></div>
            </div>
          ))}
          {body.events.length === 0 ? <p className="muted">Nothing recovered yet. Every row has to point at a receipt, a payment or a work order.</p> : null}
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>ABDM compliance and incentive</h2></div>
        <div className="card-b">
          <p>Category 2 is {inr(body.dhis.category2Paise)} per KYC-linked record. The first {body.dhis.floor} earn nothing.</p>
          <p><b>{inr(body.dhis.accruedPaise)}</b> accrued from {body.dhis.eligibleCount} eligible records.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Chair utilisation</h2></div>
        <div className="card-b">
          <p>{body.chairs.utilisedMinutes} of {body.chairs.availableMinutes} minutes used.</p>
          <p>{inr(body.chairs.perUtilisedMinutePaise)} per used minute, {inr(body.chairs.perAvailableMinutePaise)} per available minute.</p>
        </div>
      </div>
    </section>
  );
}

function Radar() {
  return (
    <section>
      <div className="eyebrow">Your place</div>
      <h1>Estimated entry</h1>
      <p className="reg-patient">The time is this doctor's recent visits, not a guess from the appointment book.</p>
    </section>
  );
}

function Desk() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [moving, setMoving] = useState<Card | null>(null);
  const [vitalsFor, setVitalsFor] = useState<Card | null>(null);
  const [list, setList] = useState(false);
  const practitionerId = localStorage.getItem("practix.practitionerId") ?? "";
  const reloadGen = useRef(0);

  async function reload(): Promise<void> {
    const gen = ++reloadGen.current;
    try {
      await flush();
      if (gen !== reloadGen.current) return;
      const board = await api("/api/queue") as { stages: Stage[]; cards: Card[] };
      if (gen !== reloadGen.current) return;
      setStages(board.stages);
      const remote = board.cards.map((card) => ({
        id: card.id,
        name: (card as Card & { full_name?: string }).full_name ?? card.name,
        tokenNo: Number((card as Card & { token_no?: number }).token_no ?? card.tokenNo),
        stageId: (card as Card & { stage_id?: string }).stage_id ?? card.stageId,
        patientId: (card as Card & { patient_id?: string }).patient_id ?? card.patientId,
        alerts: card.alerts ?? [],
        dwell: card.dwell,
        practitioner: (card as Card & { practitioner?: string }).practitioner,
      }));
      const pending = new Set((await db.outbox.toArray()).map((op) => {
        const body = op.body as { appointmentId?: string };
        return body.appointmentId ?? "";
      }));
      const local = await db.cards.toArray();
      const extras = local.filter((card) => pending.has(card.id) && !remote.some((item) => item.id === card.id));
      const next = [...remote, ...extras];
      setCards(next);
      await db.cards.clear();
      if (next.length > 0) await db.cards.bulkPut(next);
    } catch {
      if (gen !== reloadGen.current) return;
      setCards(await db.cards.toArray());
    }
  }

  useEffect(() => {
    void reload();
    const onOnline = () => { void reload(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  async function addWalkIn(): Promise<void> {
    const patientId = crypto.randomUUID();
    const appointmentId = crypto.randomUUID();
    const waiting = stages.find((stage) => stage.role === "waiting");
    const body = { phone, name, practitionerId, patientId, appointmentId };
    await db.outbox.add({ id: crypto.randomUUID(), kind: "walk_in", updatedAt: new Date().toISOString(), body });
    await db.cards.put({
      id: appointmentId,
      name,
      tokenNo: cards.length + 1,
      stageId: waiting?.id ?? "",
      patientId,
      alerts: [],
    });
    setCards(await db.cards.toArray());
    setPhone("");
    setName("");
    await reload();
  }

  async function move(card: Card, stageId: string, reversible = true): Promise<void> {
    const previous = card.stageId;
    await db.outbox.add({
      id: crypto.randomUUID(),
      kind: "queue_move",
      updatedAt: new Date().toISOString(),
      body: { appointmentId: card.id, stageId },
    });
    await db.cards.update(card.id, { stageId });
    setCards(await db.cards.toArray());
    setMoving(null);
    if (reversible && previous && previous !== stageId) {
      offerUndo("Moved", () => { void move({ ...card, stageId }, previous, false); });
    }
    await reload();
  }

  async function saveVitals(card: Card, reading: string): Promise<void> {
    const [bpSystolic, bpDiastolic, pulse, sugar, weightG] = reading.split("/").map(Number);
    await db.outbox.add({
      id: crypto.randomUUID(),
      kind: "vitals",
      updatedAt: new Date().toISOString(),
      body: { patientId: card.patientId, appointmentId: card.id, bpSystolic, bpDiastolic, pulse, sugar, weightG },
    });
    setVitalsFor(null);
    await reload();
  }

  const waiting = stages.find((stage) => stage.role === "waiting");
  return (
    <section>
      <div className="between mb">
        <div>
          <div className="eyebrow">Front desk</div>
          <h1>Today at the front desk</h1>
          <p className="muted">{cards.length} on the board</p>
        </div>
        <button className="btn btn-g" type="button" onClick={() => setList((value) => !value)}>{list ? "Cards" : "Compact"}</button>
      </div>
      <form className="card mb" onSubmit={(event) => { event.preventDefault(); void addWalkIn(); }}>
        <div className="card-b">
          <div className="eyebrow mb">Walk-in</div>
          <div className="g2">
            <label className="field">
              <span className="lbl">Mobile</span>
              <input aria-label="Mobile" inputMode="tel" className="inp" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </label>
            <label className="field">
              <span className="lbl">Name</span>
              <input aria-label="Name" className="inp" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
          </div>
          <button className="btn btn-p" type="submit">Add walk-in</button>
        </div>
      </form>
      {list ? (
        <div className="card"><div className="card-b dl">
          {cards.map((card) => <CardView key={card.id} card={card} stage={stages.find((item) => item.id === card.stageId)} onMove={setMoving} onVitals={setVitalsFor} />)}
        </div></div>
      ) : (
        <div className="board">
          {stages.map((stage) => (
            <section key={stage.id} className="lane" data-stage={stage.id}>
              <div className="lane-h">
                <h2 className="lane-t">{stageName(stage)}</h2>
                <span className="lane-n">{cards.filter((card) => card.stageId === stage.id).length}</span>
              </div>
              {cards.filter((card) => card.stageId === stage.id).map((card) => (
                <CardView key={card.id} card={card} stage={stage} onMove={setMoving} onVitals={setVitalsFor} />
              ))}
              {waiting && stage.id === waiting.id && cards.every((card) => card.stageId !== stage.id) ? <p className="faint">Empty</p> : null}
            </section>
          ))}
        </div>
      )}
      {moving ? (
        <div className="scrim on" role="dialog" aria-label="Move to">
          <div className="modal">
            <div className="modal-h"><h3>Move to…</h3><button className="x-btn" type="button" onClick={() => setMoving(null)}>×</button></div>
            <div className="modal-b sheet-list">
              {stages.map((stage) => (
                <button key={stage.id} className="sheet-row" type="button" onClick={() => void move(moving, stage.id)}>{stageName(stage)}</button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      {vitalsFor ? <Keypad onSave={(reading) => void saveVitals(vitalsFor, reading)} /> : null}
    </section>
  );
}

function CardView({ card, stage, onMove, onVitals }: {
  card: Card;
  stage?: Stage;
  onMove: (card: Card) => void;
  onVitals: (card: Card) => void;
}) {
  return (
    <article className="qcard">
      <div className="qc-top">
        <div>
          <div className="qc-name">{card.name}</div>
          <div className="row tight" style={{ marginTop: 4 }}>
            <span className="token">T{card.tokenNo}</span>
            {card.alerts?.length ? <span className="stamp s-risk">{card.alerts[0]}</span> : null}
          </div>
        </div>
      </div>
      <div className="qc-meta">
        <span>{stage ? stageName(stage) : "Queue"}{card.practitioner ? ` · ${card.practitioner}` : ""}</span>
        {card.dwell ? <span style={{ color: "var(--marigold)", fontWeight: 700 }}>Over the dwell mark</span> : null}
      </div>
      <div className="qc-act">
        <button className="btn btn-g btn-s" type="button" onClick={() => onMove(card)}>Move to…</button>
        <button className="btn btn-p btn-s" type="button" onClick={() => onVitals(card)}>Vitals</button>
      </div>
    </article>
  );
}

function Keypad({ onSave, label = "Vitals", save = "Save vitals", keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "/", "0", "⌫"] }: {
  onSave: (reading: string) => void;
  label?: string;
  save?: string;
  keys?: string[];
}) {
  const [value, setValue] = useState("");
  return (
    <div className="scrim on" role="dialog" aria-label={label}>
      <div className="modal">
        <div className="modal-h"><h3>{label}</h3></div>
        <div className="modal-b">
          <p className="kp-display" aria-label="Reading">{value || label}</p>
          <div className="keypad">
            {keys.map((key) => (
              <button key={key} type="button" onClick={() => setValue((current) => key === "⌫" ? current.slice(0, -1) : `${current}${key}`)}>{key}</button>
            ))}
          </div>
        </div>
        <div className="modal-f">
          <button className="btn btn-p btn-full" type="button" onClick={() => onSave(value)}>{save}</button>
        </div>
      </div>
    </div>
  );
}

function Nurse() {
  const [reading, setReading] = useState("");
  const [asking, setAsking] = useState(true);
  return (
    <section className="grid slate">
      <div className="eyebrow">One question</div>
      <h1>Blood pressure</h1>
      {asking ? (
        <Keypad label="Blood pressure" save="Save reading" onSave={(value) => { setReading(value); setAsking(false); }} />
      ) : (
        <div className="card">
          <div className="card-b">
            <p className="kp-display">{reading}</p>
            <button className="btn btn-g" type="button" onClick={() => setAsking(true)}>Enter again</button>
          </div>
        </div>
      )}
    </section>
  );
}

const DSM5 = [
  ["F41.1", "Generalised Anxiety Disorder"],
  ["F32.1", "Major Depressive Disorder, moderate"],
  ["F43.1", "Post-Traumatic Stress Disorder"],
  ["F40.1", "Social Anxiety Disorder"],
  ["F42.2", "Obsessive-Compulsive Disorder"],
];

function QuietRoom() {
  const pinRef = useRef("");
  const notesRef = useRef<{ s: string; o: string; a: string; p: string; dsm: string; gad7: number; phq9: number }[]>([]);
  const idleRef = useRef(0);
  const [patientId, setPatientId] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [digits, setDigits] = useState(["", "", "", ""]);
  const [sealed, setSealed] = useState(true);
  const [bad, setBad] = useState(false);
  const [draft, setDraft] = useState({ s: "", o: "", a: "", p: "", dsm: "F41.1", gad7: 0, phq9: 0 });
  const [, redraw] = useState(0);

  function seal(): void {
    notesRef.current = [];
    pinRef.current = "";
    setSealed(true);
    setDigits(["", "", "", ""]);
  }

  useEffect(() => {
    void api("/api/queue").then((body) => {
      const board = body as { cards?: { patientId?: string; patient_id?: string; name?: string; full_name?: string }[] };
      const card = board.cards?.[0];
      const id = card?.patientId ?? card?.patient_id ?? "";
      if (!id) {
        setEnabled(false);
        return;
      }
      setPatientId(id);
      setName(card?.name ?? card?.full_name ?? "");
      void api(`/api/vault/notes?patientId=${id}`).then((view) => {
        const desk = view as { enabled: boolean; fullName: string | null };
        setEnabled(desk.enabled);
        if (desk.fullName) setName(desk.fullName);
      }).catch(() => setEnabled(false));
    }).catch(() => setEnabled(false));
  }, []);

  useEffect(() => {
    idleRef.current = window.setTimeout(seal, 600000);
    return () => window.clearTimeout(idleRef.current);
  }, [sealed, draft]);

  async function unlock(): Promise<void> {
    const pin = digits.join("");
    pinRef.current = pin;
    try {
      const body = await api("/api/vault/unlock", "POST", { patientId, pin }) as {
        notes: { s: string; o: string; a: string; p: string; dsm: string; gad7: number; phq9: number }[];
      };
      notesRef.current = body.notes;
      const latest = body.notes[body.notes.length - 1];
      if (latest) setDraft(latest);
      setSealed(false);
      setBad(false);
      redraw((n) => n + 1);
    } catch {
      pinRef.current = "";
      setBad(true);
    }
  }

  async function save(): Promise<void> {
    await api("/api/vault/notes", "POST", { patientId, pin: pinRef.current, ...draft });
    notesRef.current = [...notesRef.current, draft];
    redraw((n) => n + 1);
  }

  if (enabled === false) {
    return (
      <section className="quiet">
        <h1>Quiet room</h1>
        <div className="callout">This workspace does not run a counselling service.</div>
      </section>
    );
  }

  const history = notesRef.current;
  return (
    <section className="quiet">
      <h1>Quiet room</h1>
      {sealed ? (
        <div className="vault-seal">
          <h2>Session notes are sealed</h2>
          <p className="lede">{name ? `${name}’s notes are encrypted with a key derived from your PIN.` : "Notes stay sealed until the PIN is entered."} They are unreadable to the front desk and to anyone holding a copy of the database.</p>
          <div className="pin-row">
            {digits.map((digit, index) => (
              <input
                key={index}
                className={bad ? "pin-box bad" : "pin-box"}
                inputMode="numeric"
                maxLength={1}
                aria-label={`PIN digit ${index + 1}`}
                value={digit}
                onChange={(event) => {
                  const next = digits.slice();
                  next[index] = event.target.value.replace(/\D/g, "").slice(-1);
                  setDigits(next);
                }}
              />
            ))}
          </div>
          <button className="btn btn-p" type="button" onClick={() => void unlock()}>Open the vault</button>
          <p className="hint">Auto-seals after 10 minutes without input.</p>
        </div>
      ) : (
        <>
          <div className="between mb">
            <div>
              <h2>{name}</h2>
              <p className="muted">Weekly · {history.length} sealed sessions</p>
            </div>
            <button className="btn btn-g btn-s" type="button" onClick={seal}>Seal notes</button>
          </div>
          <div className="grid g2 mb">
            <div className="card"><div className="card-b">
              <div className="eyebrow mb">Symptom trajectory</div>
              <svg viewBox="0 0 100 92" style={{ width: "100%", height: 120 }} role="img" aria-label="GAD-7 and PHQ-9 over sessions">
                <path d={history.map((item, i) => `${i ? "L" : "M"}${6 + i * 20},${6 + (100 - (item.gad7 / 21) * 100) * 0.78}`).join(" ")} fill="none" stroke="var(--indigo)" strokeWidth="2" />
                <path d={history.map((item, i) => `${i ? "L" : "M"}${6 + i * 20},${6 + (100 - (item.phq9 / 27) * 100) * 0.78}`).join(" ")} fill="none" stroke="var(--marigold)" strokeWidth="2" strokeDasharray="3 2.5" />
              </svg>
              <div className="row tight">
                <span>GAD-7 now {draft.gad7}</span>
                <span>PHQ-9 now {draft.phq9}</span>
              </div>
            </div></div>
            <div className="card"><div className="card-b">
              <div className="eyebrow mb">Working formulation</div>
              <select className="inp" value={draft.dsm} onChange={(event) => setDraft({ ...draft, dsm: event.target.value })}>
                {DSM5.map(([code, label]) => <option key={code} value={code}>{code} — {label}</option>)}
              </select>
            </div></div>
          </div>
          <div className="card"><div className="card-b">
            {([
              ["s", "Subjective — what the client reports"],
              ["o", "Objective — what you observed"],
              ["a", "Assessment — your formulation"],
              ["p", "Plan — what happens next"],
            ] as const).map(([key, label]) => (
              <div className="note-field" key={key}>
                <div className="note-label">{label}</div>
                <textarea className="note-area" value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
              </div>
            ))}
            <label className="field">GAD-7
              <input className="inp" inputMode="numeric" value={draft.gad7} onChange={(event) => setDraft({ ...draft, gad7: Number(event.target.value) })} />
            </label>
            <label className="field">PHQ-9
              <input className="inp" inputMode="numeric" value={draft.phq9} onChange={(event) => setDraft({ ...draft, phq9: Number(event.target.value) })} />
            </label>
            <button className="btn btn-m btn-xl btn-full" type="button" onClick={() => void save()}>Encrypt and save this session</button>
          </div></div>
        </>
      )}
    </section>
  );
}

function Chart() {
  const [patientId, setPatientId] = useState("");
  const [wide, setWide] = useState(window.innerWidth >= 600);
  const [quadrant, setQuadrant] = useState("UR");
  const [diagnosis, setDiagnosis] = useState("rct");
  const [teeth, setTeeth] = useState<number[]>([]);
  const [quadrants, setQuadrants] = useState<Quadrant[]>([]);
  const [states, setStates] = useState<Record<string, ToothState>>({});
  const [marked, setMarked] = useState<Record<number, string>>({});
  const [sittings, setSittings] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);
  const [toothPad, setToothPad] = useState(false);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 600);
    window.addEventListener("resize", onResize);
    void api("/api/odontogram").then((body) => {
      const model = body as { teeth: number[]; quadrants: Quadrant[]; states: Record<string, ToothState> };
      setTeeth(model.teeth);
      setQuadrants(model.quadrants);
      setStates(model.states);
      setMissing(false);
    }).catch(() => setMissing(true));
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const shown = wide ? teeth : (quadrants.find((item) => item.id === quadrant)?.teeth ?? []);
  if (missing) {
    return <div className="callout">This workspace does not include charting. The board, recalls and stock are the same ones every clinic uses.</div>;
  }
  return (
    <section className="grid">
      <div className="between mb">
        <div><div className="eyebrow">Operatory</div><h1>Chairside</h1></div>
      </div>
      <label className="field">
        <span className="lbl">Patient</span>
        <input aria-label="Patient" className="inp" value={patientId} onChange={(event) => setPatientId(event.target.value)} />
      </label>
      <button className="btn btn-g" type="button" onClick={() => setToothPad(true)}>Tooth number</button>
      {toothPad ? (
        <Keypad
          label="Tooth number"
          save="Chart tooth"
          keys={["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "⌫"]}
          onSave={(value) => {
            setToothPad(false);
            const tooth = Number(value);
            if (!tooth) return;
            void api(`/api/chart/${patientId}/teeth`, "POST", { tooth, state: diagnosis }).then(() =>
              api(`/api/chart/${patientId}/plans`, "POST", { tooth }),
            ).then(() => api(`/api/chart/${patientId}`)).then((body) => {
              const chart = body as { steps: { name: string }[] };
              setMarked((current) => ({ ...current, [tooth]: diagnosis }));
              setSittings(chart.steps.map((step) => step.name));
            });
          }}
        />
      ) : null}
      <div className="console">
        <div className="odo">
          <div className="pal mb">
            {Object.entries(states).map(([id, state]) => (
              <button key={id} className={diagnosis === id ? "on" : ""} type="button" onClick={() => setDiagnosis(id)}>
                <i style={{ background: state.colour }} />{state.label}
              </button>
            ))}
          </div>
          {wide ? null : (
            <div className="seg mb">
              {quadrants.map((item) => (
                <button key={item.id} className={quadrant === item.id ? "on" : ""} type="button" onClick={() => setQuadrant(item.id)}>{item.id}</button>
              ))}
            </div>
          )}
          <div className="arch-label">{wide ? "Both arches" : quadrants.find((item) => item.id === quadrant)?.label}</div>
          <div className="arch">
            {shown.map((tooth) => (
              <button
                key={tooth}
                className="tooth"
                type="button"
                aria-label={`Tooth ${tooth}`}
                onClick={() => {
                  void api(`/api/chart/${patientId}/teeth`, "POST", { tooth, state: diagnosis }).then(() =>
                    api(`/api/chart/${patientId}/plans`, "POST", { tooth }),
                  ).then(() => api(`/api/chart/${patientId}`)).then((body) => {
                    const chart = body as { steps: { name: string }[] };
                    setMarked((current) => ({ ...current, [tooth]: diagnosis }));
                    setSittings(chart.steps.map((step) => step.name));
                  });
                }}
              >
                <span className="tn">{tooth}</span>
                <span className="ts" style={{ color: states[marked[tooth] ?? ""]?.colour }}>{states[marked[tooth] ?? ""]?.label ?? ""}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="card mt">
        <div className="card-h"><h2>Sittings</h2></div>
        <div className="card-b">
          {sittings.length === 0 ? <p className="muted">Chart a tooth to generate the plan.</p> : (
            <ol>{sittings.map((name) => <li key={name}>{name}</li>)}</ol>
          )}
        </div>
      </div>
    </section>
  );
}

function Recalls() {
  const [rows, setRows] = useState<Practice["recalls"]>([]);
  const [rules, setRules] = useState<Practice["rules"]>([]);
  useEffect(() => {
    void api("/api/practice").then((body) => {
      const snap = body as Practice;
      setRows(snap.recalls);
      setRules(snap.rules);
    }).catch(() => undefined);
  }, []);
  return (
    <section className="grid">
      <div className="eyebrow">Who is due</div>
      <h1>Recall engine</h1>
      <div className="card">
        <div className="card-h"><h2>Rules</h2><span className="stamp s-mute flat">{rules.length}</span></div>
        <div className="card-b dl">
          {rules.map((rule) => (
            <div key={rule.id} className="dl-item">
              <div className="dl-t">{rule.template_key}</div>
              <div className="dl-r"><span className="dl-k">{rule.trigger}</span><span className="dl-v">{rule.offset_days} days</span></div>
            </div>
          ))}
          {rules.length === 0 ? <p className="muted">No recall rules in this workspace yet.</p> : null}
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Due</h2></div>
        <div className="card-b dl">
          {rows.map((row) => (
            <div key={row.id} className="dl-item">
              <div className="dl-t">{row.full_name}</div>
              <div className="dl-r"><span className="dl-k">{row.template_key}</span><span className="dl-v">{row.state} · {String(row.due_on).slice(0, 10)}</span></div>
            </div>
          ))}
          {rows.length === 0 ? <p className="muted">Nothing due. A second run of the job does not send again.</p> : null}
        </div>
      </div>
    </section>
  );
}

function Practice() {
  const [snap, setSnap] = useState<Practice | null>(null);
  const [note, setNote] = useState("");
  async function load(): Promise<void> {
    setSnap(await api("/api/practice") as Practice);
  }
  useEffect(() => { void load().catch(() => setSnap(null)); }, []);
  return (
    <section className="grid">
      <div className="eyebrow">Stock, packages, family</div>
      <h1>Practice</h1>
      {note ? <div className="callout ok">{note}</div> : null}
      <div className="g2">
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void api("/api/packages", "POST", {
            name: String(data.get("name")),
            sessions: Number(data.get("sessions")),
            pricePaise: Number(data.get("price")),
          }).then(() => { setNote("Package saved"); return load(); });
        }}>
          <div className="card-h"><h2>Packages</h2></div>
          <div className="card-b">
            {(snap?.packages ?? []).map((item) => <p key={item.id}>{item.name} · {item.sessions} · {inr(Number(item.price_paise))}</p>)}
            <label className="field"><span className="lbl">Name</span><input className="inp" name="name" /></label>
            <label className="field"><span className="lbl">Sessions</span><input className="inp" name="sessions" defaultValue="1" /></label>
            <label className="field"><span className="lbl">Price in paise</span><input className="inp" name="price" defaultValue="500000" /></label>
            <button className="btn btn-p" type="submit">Save package</button>
          </div>
        </form>
        <form className="card" onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void api("/api/inventory/items", "POST", { name: String(data.get("item")) }).then((body) => {
            const item = body as { id: string };
            return api("/api/inventory/batches", "POST", {
              itemId: item.id,
              batchNo: String(data.get("batch")),
              expiresOn: String(data.get("expires")),
              qty: Number(data.get("qty")),
            });
          }).then(() => { setNote("Batch stored. Issues take the earliest unexpired batch."); return load(); });
        }}>
          <div className="card-h"><h2>Stock</h2></div>
          <div className="card-b">
            {(snap?.batches ?? []).map((batch) => (
              <p key={batch.id}>{batch.name} · {batch.batch_no} · {String(batch.expires_on).slice(0, 10)} · {batch.qty_remaining} left</p>
            ))}
            <label className="field"><span className="lbl">Item</span><input className="inp" name="item" /></label>
            <label className="field"><span className="lbl">Batch</span><input className="inp" name="batch" /></label>
            <label className="field"><span className="lbl">Expires</span><input className="inp" name="expires" type="date" /></label>
            <label className="field"><span className="lbl">Quantity</span><input className="inp" name="qty" defaultValue="1" /></label>
            <button className="btn btn-p" type="submit">Add batch</button>
          </div>
        </form>
      </div>
      <div className="card">
        <div className="card-h"><h2>Family consent</h2></div>
        <div className="card-b dl">
          {(snap?.relationships ?? []).map((row) => (
            <div key={row.id} className="dl-item">
              <div className="dl-t">{row.guardian} · {row.dependant}</div>
              <div className="dl-r"><span className="dl-k">{row.relationship}</span><span className="dl-v">{row.may_book ? "book" : ""} {row.may_consent ? "consent" : ""} {row.may_view_clinical ? "notes" : ""}</span></div>
            </div>
          ))}
          {(snap?.relationships.length ?? 0) === 0 ? <p className="muted">Booking, consent and clinical viewing are separate. Consent and viewing start off.</p> : null}
        </div>
      </div>
    </section>
  );
}

function Settlement() {
  const [lines, setLines] = useState<{ id: string; net_paise: number; status: string; settlement_id?: string }[]>([]);
  const practitionerId = localStorage.getItem("practix.practitionerId") ?? "";
  const [fee, setFee] = useState<number | null>(null);
  const [feePad, setFeePad] = useState(false);
  async function load(): Promise<void> {
    const rows = await api(`/api/fee-lines?practitionerId=${practitionerId}`) as { id: string; net_paise: number; status: string; settlement_id?: string }[];
    setLines(rows);
  }
  useEffect(() => { void load().catch(() => undefined); }, []);
  return (
    <section className="grid">
      <div className="eyebrow">Visiting consultant</div>
      <h1>Route card</h1>
      <p className="muted">One identity, one clinic at a time. The split is on the membership. Paying a line does not call a gateway.</p>
      <div className="timeline">
        <button className="btn btn-p" type="button" onClick={() => setFeePad(true)}>Fee</button>
        {fee !== null ? <p className="kpi sm">{inr(fee)}</p> : null}
      </div>
      {feePad ? (
        <Keypad
          label="Fee"
          save="Apply fee"
          keys={["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "⌫"]}
          onSave={(value) => {
            const next = Number(value);
            const previous = fee;
            setFee(next);
            setFeePad(false);
            offerUndo("Fee applied", () => setFee(previous));
          }}
        />
      ) : null}
      {lines.map((line) => (
        <article key={line.id} className="card">
          <div className="card-b between">
            <div>
              <div className="kpi sm">{inr(Number(line.net_paise))}</div>
              <span className={`stamp ${line.status === "disputed" ? "s-risk" : line.status === "paid" || line.status === "approved" ? "s-ok" : "s-warn"}`}>{line.status}</span>
            </div>
            <div className="row">
              <button className="btn btn-p btn-s" type="button" onClick={() => void api(`/api/settlements/${line.settlement_id}/respond`, "POST", { lineId: line.id, action: "approve" }).then(load)}>Approve</button>
              <button className="btn btn-g btn-s" type="button" onClick={() => void api(`/api/settlements/${line.settlement_id}/respond`, "POST", { lineId: line.id, action: "dispute", reason: "query" }).then(load)}>Dispute</button>
            </div>
          </div>
        </article>
      ))}
      {lines.length === 0 ? <p className="muted">No fee lines for this practitioner yet.</p> : null}
      <a className="btn btn-g" href="#/print">Print a prescription</a>
    </section>
  );
}

function PrintSheet() {
  const [text, setText] = useState("");
  const [heading, setHeading] = useState("");
  const [size, setSize] = useState("a5");
  const patientId = new URLSearchParams(location.hash.split("?")[1] ?? "").get("patient") ?? "";
  useEffect(() => {
    if (!patientId) return;
    void api(`/api/patients/${patientId}/documents`, "POST", { kind: "prescription" }).then((body) => {
      const doc = body as { body: string; displayName: string; registrationNo: string | null; address: string | null };
      setHeading([doc.displayName, doc.registrationNo, doc.address].filter(Boolean).join(" · "));
      setText(doc.body);
    }).catch(() => undefined);
  }, [patientId]);
  return (
    <section>
      <div className="between mb">
        <h1>Prescription</h1>
        <div className="seg">
          <button className={size === "a5" ? "on" : ""} type="button" onClick={() => setSize("a5")}>A5</button>
          <button className={size === "a4" ? "on" : ""} type="button" onClick={() => setSize("a4")}>A4</button>
        </div>
      </div>
      <div className="sheet-wrap">
        <article className="sheet print-sheet" data-size={size}>
          <h2>{heading || "Letterhead"}</h2>
          <p>{text || "Open this view with a patient to print the same words the message port recorded."}</p>
        </article>
      </div>
    </section>
  );
}
