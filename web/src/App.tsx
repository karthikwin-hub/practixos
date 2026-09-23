import { useEffect, useRef, useState } from "react";
import { db, type LocalCard } from "./db";

type Stage = { id: string; label_key: string; role: string };
type Card = LocalCard & { dwell?: boolean };

const labels: Record<string, string> = {
  stageExpected: "Expected Today",
  stageWaiting: "Waiting Room",
  stageConsult: "In Consultation",
  stageBilling: "Billing / Exit",
  stageDilation: "Waiting for dilation",
};

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

export function App() {
  const [route, setRoute] = useState(location.hash || "#/desk");
  useEffect(() => {
    const onHash = () => setRoute(location.hash || "#/desk");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return (
    <main className="mx-auto min-h-dvh max-w-lg p-4">
      <nav className="mb-4 flex gap-3 text-sm">
        <a href="#/setup">Setup</a>
        <a href="#/book">Book</a>
        <a href="#/desk">Desk</a>
        <a href="#/chart">Chart</a>
        <a href="#/print">Print</a>
        <a href="#/settle">Settlement</a>
      </nav>
      {route.startsWith("#/setup") ? <Setup /> : null}
      {route.startsWith("#/book") ? <Book /> : null}
      {route.startsWith("#/desk") ? <Desk /> : null}
      {route.startsWith("#/chart") ? <Chart /> : null}
      {route.startsWith("#/print") ? <PrintSheet /> : null}
      {route.startsWith("#/settle") ? <Settlement /> : null}
    </main>
  );
}

function Setup() {
  const [slug, setSlug] = useState("clinic");
  const [message, setMessage] = useState("");
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          const res = await fetch("/api/onboarding", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              legalName: slug,
              slug,
              vertical: "dental",
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
          setMessage("Clinic is ready");
        })();
      }}
    >
      <label className="grid gap-1">
        Clinic slug
        <input className="min-h-12 rounded border px-3 text-base" value={slug} onChange={(event) => setSlug(event.target.value)} />
      </label>
      <button className="min-h-12 rounded bg-stone-900 text-white" type="submit">Create clinic</button>
      <p>{message}</p>
    </form>
  );
}

function Book() {
  const [lang, setLang] = useState("en");
  const [text, setText] = useState("");
  const host = localStorage.getItem("practix.host") ?? "";
  useEffect(() => {
    void fetch(`/api/portal/profile?lang=${lang}`, { headers: { host } })
      .then((res) => res.json())
      .then((body: { noApp?: string; policy?: string }) => setText(body.noApp ?? ""))
      .catch(() => setText(""));
  }, [lang, host]);
  const names: Record<string, string> = { en: "English", mr: "मराठी", te: "తెలుగు", bn: "বাংলা", kok: "कोंकणी" };
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(names).map(([code, name]) => (
          <button key={code} className="min-h-12 rounded border px-3" type="button" onClick={() => setLang(code)}>
            {name}{code === "kok" ? " (beta)" : ""}
          </button>
        ))}
      </div>
      <p>{text}</p>
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

  async function move(card: Card, stageId: string): Promise<void> {
    await db.outbox.add({
      id: crypto.randomUUID(),
      kind: "queue_move",
      updatedAt: new Date().toISOString(),
      body: { appointmentId: card.id, stageId },
    });
    await db.cards.update(card.id, { stageId });
    setCards(await db.cards.toArray());
    setMoving(null);
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

  return (
    <section className="grid gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl">Queue</h1>
        <button className="min-h-12 rounded border px-3" type="button" onClick={() => setList((value) => !value)}>
          {list ? "Board" : "List"}
        </button>
      </div>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addWalkIn();
        }}
      >
        <input aria-label="Mobile" inputMode="tel" className="min-h-12 rounded border px-3 text-base" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <input aria-label="Name" className="min-h-12 rounded border px-3 text-base" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="min-h-12 rounded bg-stone-900 text-white" type="submit">Add walk-in</button>
      </form>
      {list ? (
        <ul className="grid gap-2">
          {cards.map((card) => (
            <li key={card.id}><CardView card={card} onMove={setMoving} onVitals={setVitalsFor} /></li>
          ))}
        </ul>
      ) : (
        <div className="grid gap-3">
          {stages.map((stage) => (
            <section
              key={stage.id}
              data-stage={stage.id}
              className="rounded border bg-white p-2"
              onPointerUp={() => {
                if (moving) void move(moving, stage.id);
              }}
            >
              <h2 className="mb-2 text-sm">{labels[stage.label_key] ?? stage.label_key}</h2>
              {cards.filter((card) => card.stageId === stage.id).map((card) => (
                <CardView key={card.id} card={card} onMove={setMoving} onVitals={setVitalsFor} />
              ))}
            </section>
          ))}
        </div>
      )}
      {moving ? (
        <div role="dialog" aria-label="Move to" className="fixed inset-x-0 bottom-0 grid gap-2 bg-white p-4 shadow-xl">
          {stages.map((stage) => (
            <button key={stage.id} className="min-h-12 rounded border" type="button" onClick={() => void move(moving, stage.id)}>
              {labels[stage.label_key] ?? stage.label_key}
            </button>
          ))}
        </div>
      ) : null}
      {vitalsFor ? <Keypad onSave={(reading) => void saveVitals(vitalsFor, reading)} /> : null}
    </section>
  );
}

function CardView({ card, onMove, onVitals }: {
  card: Card;
  onMove: (card: Card) => void;
  onVitals: (card: Card) => void;
}) {
  return (
    <article
      className="mb-2 rounded border p-3"
      onPointerDown={(event) => {
        (event.currentTarget as HTMLElement).dataset.dragging = "true";
      }}
    >
      <p className="font-medium">{card.name} · {card.tokenNo}</p>
      {card.alerts?.length ? <p className="mt-1 rounded bg-amber-200 px-2 py-1">{card.alerts.join(", ")}</p> : null}
      {card.dwell ? <p>Dwell alert</p> : null}
      <div className="mt-2 flex gap-2">
        <button className="min-h-12 rounded border px-3" type="button" onClick={() => onMove(card)}>Move to…</button>
        <button className="min-h-12 rounded border px-3" type="button" onClick={() => onVitals(card)}>Vitals</button>
      </div>
    </article>
  );
}

function Keypad({ onSave }: { onSave: (reading: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div role="dialog" aria-label="Vitals" className="fixed inset-x-0 bottom-0 bg-white p-4">
      <p className="mb-2 min-h-8 text-2xl" aria-label="Reading">{value}</p>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "/", "0", "⌫"].map((key) => (
          <button
            key={key}
            className="min-h-16 rounded bg-stone-200 text-xl"
            type="button"
            onClick={() => setValue((current) => key === "⌫" ? current.slice(0, -1) : `${current}${key}`)}
          >
            {key}
          </button>
        ))}
      </div>
      <button className="mt-2 min-h-12 w-full rounded bg-stone-900 text-white" type="button" onClick={() => onSave(value)}>
        Save vitals
      </button>
    </div>
  );
}

function Chart() {
  const [patientId, setPatientId] = useState("");
  const [wide, setWide] = useState(window.innerWidth >= 600);
  const [quadrant, setQuadrant] = useState("UR");
  const [teeth, setTeeth] = useState<number[]>([]);
  const [quadrants, setQuadrants] = useState<{ id: string; label: string; teeth: number[] }[]>([]);
  const [sittings, setSittings] = useState<string[]>([]);
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= 600);
    window.addEventListener("resize", onResize);
    void api("/api/odontogram").then((body) => {
      const model = body as { teeth: number[]; quadrants: { id: string; label: string; teeth: number[] }[] };
      setTeeth(model.teeth);
      setQuadrants(model.quadrants);
    }).catch(() => undefined);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const shown = wide ? teeth : (quadrants.find((item) => item.id === quadrant)?.teeth ?? []);
  return (
    <section className="grid gap-3">
      <h1 className="text-xl">Odontogram</h1>
      <input aria-label="Patient" className="min-h-12 rounded border px-3" value={patientId} onChange={(event) => setPatientId(event.target.value)} />
      {wide ? null : (
        <div className="flex gap-2">
          {quadrants.map((item) => (
            <button key={item.id} className="min-h-12 rounded border px-3" type="button" onClick={() => setQuadrant(item.id)}>{item.id}</button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-4 gap-2">
        {shown.map((tooth) => (
          <button
            key={tooth}
            className="min-h-12 rounded border"
            type="button"
            aria-label={`Tooth ${tooth}`}
            onClick={() => {
              void api(`/api/chart/${patientId}/teeth`, "POST", { tooth, state: "rct" }).then(() =>
                api(`/api/chart/${patientId}/plans`, "POST", { tooth }),
              ).then(() => api(`/api/chart/${patientId}`)).then((body) => {
                const chart = body as { steps: { name: string }[] };
                setSittings(chart.steps.map((step) => step.name));
              });
            }}
          >
            {tooth} RCT
          </button>
        ))}
      </div>
      <ul>{sittings.map((name) => <li key={name}>{name}</li>)}</ul>
    </section>
  );
}

function PrintSheet() {
  const [text, setText] = useState("");
  const [heading, setHeading] = useState("");
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
    <article className="print-sheet grid gap-3">
      <h1 className="text-xl">Prescription</h1>
      <p>{heading}</p>
      <p>{text}</p>
    </article>
  );
}

function Settlement() {
  const [lines, setLines] = useState<{ id: string; net_paise: number; status: string; settlement_id?: string }[]>([]);
  const practitionerId = localStorage.getItem("practix.practitionerId") ?? "";
  async function load(): Promise<void> {
    const rows = await api(`/api/fee-lines?practitionerId=${practitionerId}`) as { id: string; net_paise: number; status: string }[];
    setLines(rows);
  }
  useEffect(() => { void load().catch(() => undefined); }, []);
  return (
    <section className="grid gap-3">
      <h1 className="text-xl">Settlement</h1>
      {lines.map((line) => (
        <article key={line.id} className="rounded border p-3">
          <p>{line.status} · {line.net_paise}</p>
          <div className="mt-2 flex gap-2">
            <button className="min-h-12 rounded border px-3" type="button" onClick={() => void api(`/api/settlements/${line.settlement_id}/respond`, "POST", { lineId: line.id, action: "approve" }).then(load)}>Approve</button>
            <button className="min-h-12 rounded border px-3" type="button" onClick={() => void api(`/api/settlements/${line.settlement_id}/respond`, "POST", { lineId: line.id, action: "dispute", reason: "query" }).then(load)}>Dispute</button>
          </div>
        </article>
      ))}
    </section>
  );
}
