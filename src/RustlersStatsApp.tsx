import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Miller Rustlers Live Stats + Season Tracker (Offline-first)
 * Tablet-first (landscape) live scoring layout:
 *
 * ✅ Home + Opponent rosters SIDE-BY-SIDE (Opp LEFT, Home RIGHT)
 * ✅ Stat buttons ALWAYS visible (no overlap)
 * ✅ Only the roster tables scroll
 * ✅ Opponent roster editable PER GAME (toggle)
 * ✅ Rosters tab supports bulk paste + copy for BOTH Rustlers + Opponent template
 * ✅ Quick Select bar for instant re-select (last tapped players)
 * ✅ Collapsible Setup Panel (left panel)
 *
 * Per your latest request:
 * ✅ Removed tracking for REB / AST / STL / BLK
 * ✅ History logs ANY event (shots, misses, TO, PF, etc.)
 * ✅ History shows opponent name (uses game "Opponent" field)
 * ✅ History shows ONLY period + score (NO device time)
 */

const STAT_KEYS = ["pts", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "to", "pf"] as const;

type StatKey = (typeof STAT_KEYS)[number];

type Player = {
  id: string;
  no: string;
  name: string;
  ht: string;
  cls: string;
  pos: string;
};

type Line = Record<StatKey, number>;

type TeamKey = "girls" | "boys";
type SideKey = "home" | "opp";

type HistoryEvent = {
  id: string;
  at: number; // kept internally for ordering; not displayed
  period: string;
  side: SideKey;
  playerId: string;
  label: string; // "+2", "PF", "TO", "2 Miss", etc.
  delta: Partial<Record<StatKey, number>>;
  homeScore: number;
  oppScore: number;
};

type Game = {
  id: string;
  team: TeamKey;
  dateISO: string;
  opponent: string;
  location: string;
  notes: string;

  homeRosterIds: string[];
  oppRoster: Player[];

  linesHome: Record<string, Line>;
  linesOpp: Record<string, Line>;
  undo: UndoAction[];

  period: string;
  scoreHome: number;
  scoreOpp: number;

  history: HistoryEvent[];
};

type UndoAction = {
  at: number;
  label: string;
  side: SideKey;
  playerId: string;
  delta: Partial<Record<StatKey, number>>;
  historyId?: string;
};

type Roster = {
  girls: Player[];
  boys: Player[];
};

type OppRoster = {
  girls: Player[];
  boys: Player[];
};

type Store = {
  roster: Roster;
  oppRoster: OppRoster; // template opponent roster used for new games
  games: Game[];
};

// -----------------------------
// Utils
// -----------------------------
function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function emptyLine(): Line {
  return {
    pts: 0,
    fgm: 0,
    fga: 0,
    tpm: 0,
    tpa: 0,
    ftm: 0,
    fta: 0,
    to: 0,
    pf: 0,
  };
}

function clamp0(n: number) {
  return n < 0 ? 0 : n;
}

function pct(made: number, att: number) {
  if (!att) return "";
  return `${Math.round((made / att) * 1000) / 10}%`;
}

function sumLines(lines: Record<string, Line>, ids: string[]) {
  const tot = emptyLine();
  for (const id of ids) {
    const l = lines[id] || emptyLine();
    for (const k of STAT_KEYS) tot[k] += l[k] || 0;
  }
  return tot;
}

function csvEscape(v: any) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function avgPerGame(total: number, games: number) {
  if (!games) return 0;
  return Math.round((total / games) * 10) / 10;
}

function rosterToTSV(players: Player[]) {
  const header = ["No", "Name", "Ht", "Class", "Pos"].join("\t");
  const body = players.map((p) => [p.no, p.name, p.ht, p.cls, p.pos].join("\t")).join("\n");
  return `${header}\n${body}`;
}

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

function cloneRosterWithNewIds(list: Player[], idPrefix: string) {
  return list.map((p) => ({
    id: uid(idPrefix),
    no: p.no || "",
    name: p.name || "",
    ht: p.ht || "",
    cls: p.cls || "",
    pos: p.pos || "",
  }));
}

function formatScore(home: number, opp: number) {
  return `${home}-${opp}`;
}

// -----------------------------
// Roster bulk paste helpers
// -----------------------------
function looksLikeHeaderRow(parts: string[]) {
  const joined = parts.join(" ").toLowerCase();
  return (
    joined.includes("no") ||
    joined.includes("#") ||
    joined.includes("number") ||
    joined.includes("name") ||
    joined.includes("pos") ||
    joined.includes("position") ||
    joined.includes("class") ||
    joined.includes("grade") ||
    joined.includes("height") ||
    joined.includes("ht")
  );
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.includes("\t")) return trimmed.split("\t").map((s) => s.trim());
  if (trimmed.includes(",")) return trimmed.split(",").map((s) => s.trim());
  return trimmed.split(/\s{2,}/).map((s) => s.trim());
}

function parseRosterSmart(text: string): Array<Partial<Player>> {
  const lines = text
    .replace(/\u00a0/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: Array<Partial<Player>> = [];

  for (const line of lines) {
    const partsRaw = splitRow(line).filter(Boolean);
    if (!partsRaw.length) continue;
    if (looksLikeHeaderRow(partsRaw)) continue;

    const parts = partsRaw.map((p) => p.replace(/[“”]/g, '"').trim());

    // No | Name | Class | Pos | Height
    if (parts.length >= 5 && /^\#?\d{1,2}$/.test(parts[0])) {
      const no = parts[0].replace("#", "");
      const name = parts[1];
      const cls = (parts[2] ?? "").toUpperCase();
      const pos = (parts[3] ?? "").toUpperCase();
      const ht = (parts[4] ?? "").replace(/"$/, "").replace("’", "'");
      out.push({ no, name, cls, pos, ht });
      continue;
    }

    // Fallback best-effort
    let no = "";
    let name = "";
    let ht = "";
    let cls = "";
    let pos = "";

    if (parts.length === 1) {
      const one = parts[0].replace(/^#/, "");
      const m = one.match(/^(\d{1,2})\s+(.+?)\s+([A-Za-z]{1,3})$/);
      if (m) {
        no = m[1];
        name = m[2].trim();
        pos = m[3].toUpperCase();
      } else {
        name = one;
      }
    } else {
      const numIdx = parts.findIndex((p) => /^\#?\d{1,2}$/.test(p));
      if (numIdx >= 0) {
        no = parts[numIdx].replace("#", "");
        const rest = parts.filter((_, i) => i !== numIdx);

        name = rest[0] ?? "";

        const htIdx = rest.findIndex((p) => /(\d)\s*[’']\s*(\d{1,2})|^\d-\d{1,2}$|^\d{2}$/.test(p));
        if (htIdx >= 0) {
          ht = rest[htIdx]
            .replace("’", "'")
            .replace(/"$/, "")
            .replace(/^(\d)-(\d{1,2})$/, "$1'$2");
        }

        const clsIdx = rest.findIndex((p) =>
          /^(fr|frosh|so|soph|jr|jun|sr|sen|freshman|sophomore|junior|senior|\d{1,2})$/i.test(p)
        );
        if (clsIdx >= 0) cls = rest[clsIdx].toUpperCase();

        const posIdx = rest.findIndex((p) => /^(PG|SG|SF|PF|C|G|F)$|^(G-F|F-G|F-C|C-F)$/i.test(p));
        if (posIdx >= 0) pos = rest[posIdx].toUpperCase();

        if (!name.includes(" ") && rest.length >= 2) {
          const candidate = `${rest[0]} ${rest[1]}`.trim();
          const badSecond =
            /(\d)\s*[’']\s*(\d{1,2})|^\d-\d{1,2}$|^\d{2}$/.test(rest[1]) ||
            /^(FR|SO|JR|SR|\d{1,2})$/i.test(rest[1]) ||
            /^(PG|SG|SF|PF|C|G|F)$/i.test(rest[1]);
          if (!badSecond) name = candidate;
        }
      } else {
        name = parts[0] ?? "";
        pos = (parts[1] ?? "").toUpperCase();
        ht = (parts[2] ?? "").replace(/"$/, "");
        cls = (parts[3] ?? "").toUpperCase();
      }
    }

    const row = { no, name, ht, cls, pos };
    if (row.no || row.name || row.ht || row.cls || row.pos) out.push(row);
  }

  return out;
}

// -----------------------------
// Persistence
// -----------------------------
const LS_KEY = "miller_rustlers_stats_v6";

function makeBlankRoster(prefix: string) {
  return Array.from({ length: 12 }).map(() => ({
    id: uid(prefix),
    no: "",
    name: "",
    ht: "",
    cls: "",
    pos: "",
  }));
}

function toLineAny(obj: any): Line {
  const base = emptyLine();
  if (!obj) return base;
  for (const k of STAT_KEYS) base[k] = typeof obj[k] === "number" ? obj[k] : 0;
  return base;
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw);

    if (!parsed.oppRoster) parsed.oppRoster = { girls: makeBlankRoster("opT"), boys: makeBlankRoster("opT") };

    if (Array.isArray(parsed.games)) {
      parsed.games = parsed.games.map((g: any) => {
        const homeIds = Array.isArray(g.homeRosterIds) ? g.homeRosterIds : [];
        const oppIds = Array.isArray(g.oppRoster) ? g.oppRoster.map((p: any) => p.id) : [];

        const linesHome: Record<string, Line> = {};
        for (const id of homeIds) linesHome[id] = toLineAny(g.linesHome?.[id]);

        const linesOpp: Record<string, Line> = {};
        for (const id of oppIds) linesOpp[id] = toLineAny(g.linesOpp?.[id]);

        const homePts = sumLines(linesHome, homeIds).pts;
        const oppPts = sumLines(linesOpp, oppIds).pts;

        return {
          ...g,
          linesHome,
          linesOpp,
          period: g.period || "Q1",
          scoreHome: typeof g.scoreHome === "number" ? g.scoreHome : homePts,
          scoreOpp: typeof g.scoreOpp === "number" ? g.scoreOpp : oppPts,
          history: Array.isArray(g.history) ? g.history : [],
          undo: Array.isArray(g.undo) ? g.undo : [],
        } as Game;
      });
    }

    return parsed;
  } catch {
    return {
      roster: { girls: makeBlankRoster("p"), boys: makeBlankRoster("p") },
      oppRoster: { girls: makeBlankRoster("opT"), boys: makeBlankRoster("opT") },
      games: [],
    };
  }
}

function saveStore(store: Store) {
  localStorage.setItem(LS_KEY, JSON.stringify(store));
}

// -----------------------------
// App
// -----------------------------
export default function RustlersStatsApp() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const [tab, setTab] = useState<"live" | "roster" | "season">("live");
  const [team, setTeam] = useState<TeamKey>("girls");
  const [activeGameId, setActiveGameId] = useState<string | null>(null);

  const [selected, setSelected] = useState<{ side: SideKey; playerId: string } | null>(null);
  const [quick, setQuick] = useState<Array<{ side: SideKey; playerId: string }>>([]);

  const [toast, setToast] = useState<string>("");

  const [compactMode, setCompactMode] = useState<boolean>(true);
  const [editOppRoster, setEditOppRoster] = useState<boolean>(false);
  const [hideLeftPanel, setHideLeftPanel] = useState<boolean>(false);
  const [rosterMode, setRosterMode] = useState<"rustlers" | "opponent">("rustlers");
  const [bottomPanel, setBottomPanel] = useState<"quick" | "history">("quick");

  const PERIODS = useMemo(() => ["Q1", "Q2", "Q3", "Q4", "OT"], []);

  useEffect(() => saveStore(store), [store]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 1200);
    return () => clearTimeout(t);
  }, [toast]);

  const rustlersRoster = store.roster[team];
  const opponentTemplateRoster = store.oppRoster[team];

  const activeGame = useMemo(() => {
    if (!activeGameId) return null;
    return store.games.find((g) => g.id === activeGameId) || null;
  }, [store.games, activeGameId]);

  useEffect(() => {
    const candidates = store.games.filter((g) => g.team === team).sort((a, b) => (a.dateISO < b.dateISO ? 1 : -1));
    if (!activeGameId && candidates[0]) setActiveGameId(candidates[0].id);
  }, [team, store.games, activeGameId]);

  useEffect(() => {
    setQuick([]);
    if (!activeGame) return;

    const firstHome = activeGame.homeRosterIds?.[0];
    if (firstHome) {
      setSelected({ side: "home", playerId: firstHome });
      setQuick([{ side: "home", playerId: firstHome }]);
    }
    setBottomPanel("quick");
  }, [activeGameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const gameHomeIds = useMemo(() => rustlersRoster.map((p) => p.id), [rustlersRoster]);

  const ensureGame = () => {
    const oppRoster = cloneRosterWithNewIds(opponentTemplateRoster, "op");

    const g: Game = {
      id: uid("g"),
      team,
      dateISO: todayISO(),
      opponent: "",
      location: "",
      notes: "",
      homeRosterIds: gameHomeIds,
      oppRoster,
      linesHome: Object.fromEntries(gameHomeIds.map((id) => [id, emptyLine()])),
      linesOpp: Object.fromEntries(oppRoster.map((p) => [p.id, emptyLine()])),
      undo: [],
      period: "Q1",
      scoreHome: 0,
      scoreOpp: 0,
      history: [],
    };

    setStore((s) => ({ ...s, games: [g, ...s.games] }));
    setActiveGameId(g.id);
    setEditOppRoster(false);
    setHideLeftPanel(true);

    const firstHome = g.homeRosterIds[0];
    if (firstHome) {
      setSelected({ side: "home", playerId: firstHome });
      setQuick([{ side: "home", playerId: firstHome }]);
    }

    setToast("New game created");
  };

  const updateGame = (patch: Partial<Game>) => {
    if (!activeGame) return;
    setStore((s) => ({
      ...s,
      games: s.games.map((g) => (g.id === activeGame.id ? { ...g, ...patch } : g)),
    }));
  };

  const selectPlayer = (side: SideKey, playerId: string) => {
    setSelected({ side, playerId });
    setQuick((prev) => {
      const next = [{ side, playerId }, ...prev.filter((x) => !(x.side === side && x.playerId === playerId))];
      return next.slice(0, 10);
    });
  };

  const getPlayer = (side: SideKey, playerId: string) => {
    if (!activeGame) return null;
    const list = side === "home" ? rustlersRoster : activeGame.oppRoster;
    return list.find((x) => x.id === playerId) || null;
  };

  const resolveSideName = (side: SideKey) => {
    if (!activeGame) return side === "home" ? "Rustlers" : "Opponent";
    if (side === "home") return "Rustlers";
    return activeGame.opponent?.trim() ? activeGame.opponent.trim() : "Opponent";
  };

  const resolvePlayerLabel = (side: SideKey, playerId: string) => {
    const p = getPlayer(side, playerId);
    if (!p) return "—";
    const base = `${p.no || ""} ${p.name || ""}`.trim();
    return base || "—";
  };

  const setPeriod = (p: string) => {
    if (!activeGame) return;
    updateGame({ period: p });
    setToast(`Period: ${p}`);
  };

  const nextPeriod = () => {
    if (!activeGame) return;
    const idx = PERIODS.indexOf(activeGame.period || "Q1");
    const next = PERIODS[Math.min(PERIODS.length - 1, idx + 1)];
    updateGame({ period: next });
    setToast(`Period: ${next}`);
  };

  // apply delta + ALWAYS log to history (period + score only in UI)
  const applyDelta = (sideKey: SideKey, playerId: string, delta: Partial<Record<StatKey, number>>, label: string) => {
    if (!activeGame) return;

    const linesKey = sideKey === "home" ? "linesHome" : "linesOpp";
    const curLines = activeGame[linesKey];
    const cur = curLines[playerId] || emptyLine();
    const next: Line = { ...cur };

    for (const k of STAT_KEYS) {
      if (delta[k] != null) next[k] = clamp0((next[k] || 0) + (delta[k] as number));
    }

    // Scoreboard update from pts delta only
    const ptsDelta = typeof delta.pts === "number" ? (delta.pts as number) : 0;
    let scoreHome = typeof activeGame.scoreHome === "number" ? activeGame.scoreHome : 0;
    let scoreOpp = typeof activeGame.scoreOpp === "number" ? activeGame.scoreOpp : 0;
    if (ptsDelta !== 0) {
      if (sideKey === "home") scoreHome = clamp0(scoreHome + ptsDelta);
      else scoreOpp = clamp0(scoreOpp + ptsDelta);
    }

    const historyId = uid("h");
    const ev: HistoryEvent = {
      id: historyId,
      at: Date.now(),
      period: activeGame.period || "Q1",
      side: sideKey,
      playerId,
      label,
      delta,
      homeScore: scoreHome,
      oppScore: scoreOpp,
    };

    const undoAction: UndoAction = {
      at: Date.now(),
      label,
      side: sideKey,
      playerId,
      delta,
      historyId,
    };

    updateGame({
      [linesKey]: { ...curLines, [playerId]: next },
      undo: [undoAction, ...(activeGame.undo || [])].slice(0, 300),
      scoreHome,
      scoreOpp,
      history: [ev, ...(activeGame.history || [])].slice(0, 500),
    } as any);

    setToast(label);
  };

  const undoLast = () => {
    if (!activeGame || !activeGame.undo?.length) {
      setToast("Nothing to undo");
      return;
    }
    const [last, ...rest] = activeGame.undo;

    const neg: Partial<Record<StatKey, number>> = {};
    for (const k of STAT_KEYS) if (last.delta[k] != null) neg[k] = -(last.delta[k] as number);

    const linesKey = last.side === "home" ? "linesHome" : "linesOpp";
    const curLines = activeGame[linesKey];
    const cur = curLines[last.playerId] || emptyLine();
    const next: Line = { ...cur };

    for (const k of STAT_KEYS) if (neg[k] != null) next[k] = clamp0((next[k] || 0) + (neg[k] as number));

    let scoreHome = typeof activeGame.scoreHome === "number" ? activeGame.scoreHome : 0;
    let scoreOpp = typeof activeGame.scoreOpp === "number" ? activeGame.scoreOpp : 0;
    const ptsNeg = typeof neg.pts === "number" ? (neg.pts as number) : 0;
    if (ptsNeg !== 0) {
      if (last.side === "home") scoreHome = clamp0(scoreHome + ptsNeg);
      else scoreOpp = clamp0(scoreOpp + ptsNeg);
    }

    let history = activeGame.history || [];
    if (last.historyId && history.length && history[0].id === last.historyId) history = history.slice(1);
    else if (last.historyId) history = history.filter((h) => h.id !== last.historyId);

    updateGame({
      [linesKey]: { ...curLines, [last.playerId]: next },
      undo: rest,
      scoreHome,
      scoreOpp,
      history,
    } as any);

    setToast(`Undo: ${last.label}`);
  };

  const clearSelectedPlayer = () => {
    if (!activeGame || !selected) return;
    const linesKey = selected.side === "home" ? "linesHome" : "linesOpp";
    const curLines = activeGame[linesKey];
    updateGame({ [linesKey]: { ...curLines, [selected.playerId]: emptyLine() } } as any);
    setToast("Cleared player");
  };

  const clearGameStats = () => {
    if (!activeGame) return;

    const linesHome: Record<string, Line> = {};
    for (const id of activeGame.homeRosterIds) linesHome[id] = emptyLine();

    const linesOpp: Record<string, Line> = {};
    for (const p of activeGame.oppRoster) linesOpp[p.id] = emptyLine();

    updateGame({
      linesHome,
      linesOpp,
      undo: [],
      scoreHome: 0,
      scoreOpp: 0,
      history: [],
      period: "Q1",
    });
    setToast("Cleared game stats");
  };

  const statButtons = useMemo(
    () => [
      { label: "+2", delta: { pts: 2, fgm: 1, fga: 1 }, hot: true },
      { label: "+3", delta: { pts: 3, tpm: 1, tpa: 1, fgm: 1, fga: 1 }, hot: true },
      { label: "FT +1", delta: { pts: 1, ftm: 1, fta: 1 }, hot: true },
      { label: "2 Miss", delta: { fga: 1 } },
      { label: "3 Miss", delta: { tpa: 1, fga: 1 } },
      { label: "FT Miss", delta: { fta: 1 } },
      { label: "TO", delta: { to: 1 } },
      { label: "PF", delta: { pf: 1 } },
    ],
    []
  );

  const negButtons = useMemo(
    () => [
      { label: "-2", delta: { pts: -2, fgm: -1, fga: -1 } },
      { label: "-3", delta: { pts: -3, tpm: -1, tpa: -1, fgm: -1, fga: -1 } },
      { label: "FT -1", delta: { pts: -1, ftm: -1, fta: -1 } },
      { label: "2 -Miss", delta: { fga: -1 } },
      { label: "3 -Miss", delta: { tpa: -1, fga: -1 } },
      { label: "FT -Miss", delta: { fta: -1 } },
      { label: "-TO", delta: { to: -1 } },
      { label: "-PF", delta: { pf: -1 } },
    ],
    []
  );

  const gamesForTeam = useMemo(
    () => store.games.filter((g) => g.team === team).sort((a, b) => (a.dateISO < b.dateISO ? 1 : -1)),
    [store.games, team]
  );

  const season = useMemo(() => {
    const games = store.games.filter((g) => g.team === team);
    const homeTotals = emptyLine();
    const oppTotals = emptyLine();

    for (const g of games) {
      const home = sumLines(g.linesHome, g.homeRosterIds);
      const opp = sumLines(g.linesOpp, g.oppRoster.map((p) => p.id));
      for (const k of STAT_KEYS) {
        homeTotals[k] += home[k];
        oppTotals[k] += opp[k];
      }
    }

    const gp = games.length;
    return {
      gp,
      homeTotals,
      oppTotals,
      homeAvgs: Object.fromEntries(STAT_KEYS.map((k) => [k, avgPerGame(homeTotals[k], gp)])) as any,
      oppAvgs: Object.fromEntries(STAT_KEYS.map((k) => [k, avgPerGame(oppTotals[k], gp)])) as any,
    };
  }, [store.games, team]);

  const exportGameCSV = () => {
    if (!activeGame) return;
    const rows: string[] = [];
    rows.push(
      ["team", "date", "opponent", "location", "period", "side", "no", "name", "ht", "class", "pos", ...STAT_KEYS, "fg%", "3p%", "ft%"].join(
        ","
      )
    );

    const addSide = (sideKey: SideKey) => {
      const isHome = sideKey === "home";
      const list = isHome ? rustlersRoster : activeGame.oppRoster;
      const lines = isHome ? activeGame.linesHome : activeGame.linesOpp;
      const ids = isHome ? activeGame.homeRosterIds : activeGame.oppRoster.map((p) => p.id);

      for (const id of ids) {
        const p = list.find((x) => x.id === id);
        if (!p) continue;
        const l = lines[id] || emptyLine();
        rows.push(
          [
            activeGame.team,
            activeGame.dateISO,
            activeGame.opponent,
            activeGame.location,
            activeGame.period || "Q1",
            sideKey,
            p.no,
            p.name,
            p.ht,
            p.cls,
            p.pos,
            ...STAT_KEYS.map((k) => l[k]),
            pct(l.fgm, l.fga),
            pct(l.tpm, l.tpa),
            pct(l.ftm, l.fta),
          ]
            .map(csvEscape)
            .join(",")
        );
      }
    };

    addSide("home");
    addSide("opp");

    downloadText(`miller_${activeGame.team}_${activeGame.dateISO}_game.csv`, rows.join("\n"));
  };

  const exportSeasonCSV = () => {
    const rows: string[] = [];
    rows.push(["team", "gp", "side", ...STAT_KEYS].join(","));
    rows.push([team, season.gp, "home_totals", ...STAT_KEYS.map((k) => season.homeTotals[k])].map(csvEscape).join(","));
    rows.push([team, season.gp, "opp_totals", ...STAT_KEYS.map((k) => season.oppTotals[k])].map(csvEscape).join(","));
    rows.push([team, season.gp, "home_avgs", ...STAT_KEYS.map((k) => season.homeAvgs[k])].map(csvEscape).join(","));
    rows.push([team, season.gp, "opp_avgs", ...STAT_KEYS.map((k) => season.oppAvgs[k])].map(csvEscape).join(","));
    downloadText(`miller_${team}_season.csv`, rows.join("\n"));
  };

  const onTapStat = (btn: any) => {
    if (!activeGame) return;
    if (!selected) {
      setToast("Select a player");
      return;
    }
    applyDelta(selected.side, selected.playerId, btn.delta, btn.label);
  };

  // -----------------------------
  // Header
  // -----------------------------
  const header = (
    <div className="sticky top-0 z-30 bg-gradient-to-b from-white to-gray-50 border-b">
      <div className="w-full px-3 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-lg font-semibold tracking-tight">Miller Rustlers Stats</div>
          <span className="text-xs px-2 py-1 rounded-full bg-gray-100 border">Offline</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTeam("girls")}
            className={`px-3 py-2 rounded-xl border text-sm ${team === "girls" ? "bg-black text-white" : "bg-white"}`}
          >
            Girls
          </button>
          <button
            onClick={() => setTeam("boys")}
            className={`px-3 py-2 rounded-xl border text-sm ${team === "boys" ? "bg-black text-white" : "bg-white"}`}
          >
            Boys
          </button>
        </div>
      </div>

      <div className="w-full px-3 pb-3 flex items-center gap-2">
        <button
          onClick={() => setTab("live")}
          className={`px-3 py-2 rounded-xl border text-sm ${tab === "live" ? "bg-black text-white" : "bg-white"}`}
        >
          Live Game
        </button>
        <button
          onClick={() => setTab("season")}
          className={`px-3 py-2 rounded-xl border text-sm ${tab === "season" ? "bg-black text-white" : "bg-white"}`}
        >
          Season
        </button>
        <button
          onClick={() => setTab("roster")}
          className={`px-3 py-2 rounded-xl border text-sm ${tab === "roster" ? "bg-black text-white" : "bg-white"}`}
        >
          Rosters
        </button>

        <div className="flex-1" />

        {tab === "live" && (
          <button onClick={() => setCompactMode((v) => !v)} className="px-3 py-2 rounded-xl border text-sm bg-white">
            {compactMode ? "Compact: On" : "Compact: Off"}
          </button>
        )}
      </div>
    </div>
  );

  // -----------------------------
  // Live
  // -----------------------------
  const Live = () => {
    const homeRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
    const oppRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

    useEffect(() => {
      if (!selected) return;
      const map = selected.side === "home" ? homeRowRefs.current : oppRowRefs.current;
      const el = map[selected.playerId];
      if (!el) return;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [selected?.side, selected?.playerId]);

    if (!activeGame) {
      return (
        <div className="p-4">
          <div className="max-w-3xl mx-auto bg-white rounded-2xl border p-4 shadow-sm">
            <div className="text-lg font-semibold">No games yet</div>
            <div className="text-sm text-gray-600 mt-1">Create a new game to start live tracking.</div>
            <button onClick={ensureGame} className="mt-4 px-4 py-3 rounded-2xl bg-black text-white text-sm">
              + New Game
            </button>
          </div>
        </div>
      );
    }

    const homeIds = activeGame.homeRosterIds;
    const oppIds = activeGame.oppRoster.map((p) => p.id);

    const homeTotals = sumLines(activeGame.linesHome, homeIds);
    const oppTotals = sumLines(activeGame.linesOpp, oppIds);

    const scoreHome = typeof activeGame.scoreHome === "number" ? activeGame.scoreHome : homeTotals.pts;
    const scoreOpp = typeof activeGame.scoreOpp === "number" ? activeGame.scoreOpp : oppTotals.pts;

    const setOppPlayer = (id: string, patch: Partial<Player>) => {
      const next = activeGame.oppRoster.map((p) => (p.id === id ? { ...p, ...patch } : p));
      updateGame({ oppRoster: next });
    };

    const history = activeGame.history || [];

    const playerNameForHistory = (ev: HistoryEvent) => {
      const p = getPlayer(ev.side, ev.playerId);
      const nm = p ? `${p.no ? p.no + " " : ""}${p.name}`.trim() : "Unknown";
      return nm || "Unknown";
    };

    const oppName = resolveSideName("opp");
    const homeName = resolveSideName("home");

    return (
      <div className="w-full px-2 sm:px-3 py-3">
        <div className={`grid gap-3 ${hideLeftPanel ? "grid-cols-1" : "grid-cols-[300px_minmax(0,1fr)]"}`}>
          {/* LEFT: controls (collapsible) */}
          {!hideLeftPanel && (
            <div className="bg-white rounded-2xl border shadow-sm p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-lg font-semibold">Live Game</div>
                <div className="flex items-center gap-2">
                  <button onClick={exportGameCSV} className="px-3 py-2 rounded-xl border text-sm">
                    Export
                  </button>
                  <button onClick={undoLast} className="px-3 py-2 rounded-xl border text-sm">
                    Undo
                  </button>
                </div>
              </div>

              {/* Scoreboard + period */}
              <div className="mt-3 rounded-2xl border p-3 bg-gray-50">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Scoreboard</div>
                  <div className="text-xs px-2 py-1 rounded-full bg-white border">{activeGame.period || "Q1"}</div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div className="rounded-2xl border bg-white p-3">
                    <div className="text-xs text-gray-500">{homeName}</div>
                    <div className="text-3xl font-semibold">{scoreHome}</div>
                  </div>
                  <div className="rounded-2xl border bg-white p-3">
                    <div className="text-xs text-gray-500">{oppName}</div>
                    <div className="text-3xl font-semibold">{scoreOpp}</div>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="text-xs text-gray-500">Period</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {PERIODS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setPeriod(p)}
                        className={`px-3 py-2 rounded-xl border text-sm ${activeGame.period === p ? "bg-black text-white" : "bg-white"}`}
                      >
                        {p}
                      </button>
                    ))}
                    <button onClick={nextPeriod} className="px-3 py-2 rounded-xl border text-sm bg-white">
                      Next →
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-gray-500">Date</div>
                  <input
                    value={activeGame.dateISO}
                    onChange={(e) => updateGame({ dateISO: e.target.value })}
                    type="date"
                    className="w-full mt-1 px-3 py-2 rounded-xl border"
                  />
                </div>
                <div>
                  <div className="text-xs text-gray-500">Opponent</div>
                  <input
                    value={activeGame.opponent}
                    onChange={(e) => updateGame({ opponent: e.target.value })}
                    placeholder="Opponent"
                    className="w-full mt-1 px-3 py-2 rounded-xl border"
                  />
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-gray-500">Location</div>
                  <input
                    value={activeGame.location}
                    onChange={(e) => updateGame({ location: e.target.value })}
                    placeholder="Gym / City"
                    className="w-full mt-1 px-3 py-2 rounded-xl border"
                  />
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-gray-500">Notes</div>
                  <input
                    value={activeGame.notes}
                    onChange={(e) => updateGame({ notes: e.target.value })}
                    placeholder="Quick notes"
                    className="w-full mt-1 px-3 py-2 rounded-xl border"
                  />
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button onClick={clearSelectedPlayer} className="px-3 py-2 rounded-xl border text-sm">
                  Clear Player
                </button>
                <button onClick={clearGameStats} className="px-3 py-2 rounded-xl border text-sm">
                  Clear Game
                </button>
              </div>

              <div className="mt-3">
                <button
                  onClick={() => setEditOppRoster((v) => !v)}
                  className={`w-full px-3 py-2 rounded-xl border text-sm ${editOppRoster ? "bg-black text-white" : "bg-white"}`}
                >
                  {editOppRoster ? "Editing Opponent Roster (On)" : "Edit Opponent Roster"}
                </button>
                <div className="text-xs text-gray-500 mt-1">Toggle on to fix opponent name/number/pos mid-game.</div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3">
                <TotalsCard title={`TEAM TOTALS (LIVE) — ${homeName}`} line={homeTotals} />
                <TotalsCard title={`TEAM TOTALS (LIVE) — ${oppName}`} line={oppTotals} />
              </div>

              {/* History (left panel) */}
              <div className="mt-4 rounded-2xl border p-3 bg-gray-50">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">History (latest)</div>
                  <div className="text-xs text-gray-500">{history.length ? `${history.length}` : "0"}</div>
                </div>
                <div className="mt-2 max-h-[220px] overflow-auto pr-1">
                  {history.length ? (
                    <div className="grid gap-2">
                      {history.slice(0, 20).map((ev) => {
                        const who = playerNameForHistory(ev);
                        const sideName = resolveSideName(ev.side);
                        const scoreTxt = formatScore(ev.homeScore, ev.oppScore);
                        return (
                          <div key={ev.id} className="rounded-2xl border bg-white px-3 py-2">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs text-gray-500">{ev.period}</div>
                              <div className="text-xs font-semibold">{scoreTxt}</div>
                            </div>
                            <div className="text-sm font-semibold">
                              {who} <span className="text-xs text-gray-500">({sideName})</span>{" "}
                              <span className="text-xs px-2 py-1 rounded-full border bg-gray-50">{ev.label}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-sm text-gray-600 py-2">No events yet.</div>
                  )}
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-2">
                <button onClick={() => setActiveGameId(null)} className="px-3 py-2 rounded-xl border text-sm">
                  Change Game
                </button>
                <button onClick={ensureGame} className="px-3 py-2 rounded-xl bg-black text-white text-sm">
                  + New Game
                </button>
              </div>

              {activeGameId === null && (
                <div className="mt-3 rounded-2xl border p-3 bg-gray-50">
                  <div className="text-sm font-semibold">Select a game</div>
                  <div className="mt-2 grid gap-2">
                    {gamesForTeam.length ? (
                      gamesForTeam.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => setActiveGameId(g.id)}
                          className="text-left px-3 py-3 rounded-2xl border bg-white"
                        >
                          <div className="text-sm font-semibold">
                            {g.dateISO} vs {g.opponent || "(opponent)"}
                          </div>
                          <div className="text-xs text-gray-500">{g.location || ""}</div>
                        </button>
                      ))
                    ) : (
                      <div className="text-sm text-gray-600">No games yet.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* RIGHT: rosters + bottom scoring panel */}
          <div className="bg-white rounded-2xl border shadow-sm overflow-hidden grid grid-rows-[auto_minmax(0,1fr)_auto] min-h-[70vh]">
            {/* header row */}
            <div className="px-4 py-3 border-b flex items-center justify-between gap-2">
              <div>
                <div className="text-lg font-semibold">Players</div>
                <div className="text-xs text-gray-500">Tap a player (home or opp), then tap a stat.</div>
              </div>

              <div className="flex items-center gap-2">
                <div className="hidden sm:flex items-center gap-2 text-xs px-2 py-1 rounded-full border bg-gray-50">
                  <span className="font-semibold">{activeGame.period || "Q1"}</span>
                  <span className="opacity-70">•</span>
                  <span className="font-semibold">{formatScore(scoreHome, scoreOpp)}</span>
                </div>

                <button
                  onClick={() => setHideLeftPanel((v) => !v)}
                  className="px-3 py-2 rounded-xl border text-sm bg-white"
                >
                  {hideLeftPanel ? "Show Setup" : "Hide Setup"}
                </button>

                {editOppRoster && <span className="text-xs px-2 py-1 rounded-full bg-gray-100 border">Opp edit ON</span>}
              </div>
            </div>

            {/* scroll row (ONLY this scrolls) */}
            <div className="p-3 overflow-hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 h-full min-h-0">
                {/* LEFT: OPPONENT */}
                <div className="rounded-2xl border overflow-hidden flex flex-col min-h-0">
                  <div className="px-3 py-2 border-b bg-gray-50 flex items-center justify-between">
                    <div className="text-sm font-semibold">{oppName.toUpperCase()}</div>
                    <div className="text-xs text-gray-500">tap to select</div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto">
                    <PlayersTable
                      side="opp"
                      players={activeGame.oppRoster}
                      ids={activeGame.oppRoster.map((p) => p.id)}
                      lines={activeGame.linesOpp}
                      selected={selected}
                      onSelect={(playerId) => selectPlayer("opp", playerId)}
                      compactMode={compactMode}
                      editable={editOppRoster}
                      onEdit={(id, patch) => setOppPlayer(id, patch)}
                      rowRefs={oppRowRefs}
                    />
                  </div>
                </div>

                {/* RIGHT: HOME */}
                <div className="rounded-2xl border overflow-hidden flex flex-col min-h-0">
                  <div className="px-3 py-2 border-b bg-gray-50 flex items-center justify-between">
                    <div className="text-sm font-semibold">{homeName.toUpperCase()}</div>
                    <div className="text-xs text-gray-500">tap to select</div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-auto">
                    <PlayersTable
                      side="home"
                      players={rustlersRoster}
                      ids={activeGame.homeRosterIds}
                      lines={activeGame.linesHome}
                      selected={selected}
                      onSelect={(playerId) => selectPlayer("home", playerId)}
                      compactMode={compactMode}
                      editable={false}
                      onEdit={() => {}}
                      rowRefs={homeRowRefs}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* bottom row (ALWAYS visible) */}
            <div className="border-t bg-white">
              <div className="p-3 grid grid-cols-[320px_minmax(0,1fr)] gap-3">
                {/* Left: Quick / History */}
                <div className="rounded-2xl border bg-gray-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setBottomPanel("quick")}
                        className={`px-3 py-2 rounded-xl border text-sm ${bottomPanel === "quick" ? "bg-black text-white" : "bg-white"}`}
                      >
                        Quick
                      </button>
                      <button
                        onClick={() => setBottomPanel("history")}
                        className={`px-3 py-2 rounded-xl border text-sm ${bottomPanel === "history" ? "bg-black text-white" : "bg-white"}`}
                      >
                        History
                      </button>
                    </div>
                    {bottomPanel === "quick" ? (
                      <button onClick={() => setQuick([])} className="px-3 py-2 rounded-xl border text-sm bg-white">
                        Clear
                      </button>
                    ) : (
                      <div className="text-xs text-gray-500">{history.length ? `${history.length}` : "0"}</div>
                    )}
                  </div>

                  <div className="mt-2 text-xs text-gray-600">
                    Selected:{" "}
                    {selected ? (
                      <>
                        <span className="font-semibold">{resolveSideName(selected.side)}</span> —{" "}
                        {resolvePlayerLabel(selected.side, selected.playerId)}
                      </>
                    ) : (
                      "—"
                    )}
                  </div>

                  {bottomPanel === "quick" ? (
                    <div className="mt-2 grid grid-cols-1 gap-2 max-h-[210px] overflow-auto pr-1">
                      {quick.length ? (
                        quick.map((q) => {
                          const active = selected?.side === q.side && selected?.playerId === q.playerId;
                          const label = resolvePlayerLabel(q.side, q.playerId);
                          return (
                            <button
                              key={`${q.side}_${q.playerId}`}
                              onClick={() => selectPlayer(q.side, q.playerId)}
                              className={`w-full text-left px-3 py-3 rounded-2xl border ${active ? "bg-black text-white" : "bg-white"}`}
                            >
                              <div className="text-[10px] opacity-80">{resolveSideName(q.side)}</div>
                              <div className="font-semibold">{label}</div>
                            </button>
                          );
                        })
                      ) : (
                        <div className="text-sm text-gray-500 py-2">Tap players during the game — they’ll appear here.</div>
                      )}
                    </div>
                  ) : (
                    <div className="mt-2 grid grid-cols-1 gap-2 max-h-[210px] overflow-auto pr-1">
                      {history.length ? (
                        history.slice(0, 30).map((ev) => {
                          const who = playerNameForHistory(ev);
                          const sideName = resolveSideName(ev.side);
                          const scoreTxt = formatScore(ev.homeScore, ev.oppScore);
                          return (
                            <div key={ev.id} className="rounded-2xl border bg-white px-3 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[10px] text-gray-500">{ev.period}</div>
                                <div className="text-xs font-semibold">{scoreTxt}</div>
                              </div>
                              <div className="text-sm font-semibold">
                                {who} <span className="text-xs text-gray-500">({sideName})</span>{" "}
                                <span className="text-xs px-2 py-1 rounded-full border bg-gray-50">{ev.label}</span>
                              </div>
                            </div>
                          );
                        })
                      ) : (
                        <div className="text-sm text-gray-500 py-2">No events yet.</div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right: Buttons */}
                <div className="rounded-2xl border p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Tap Stats</div>
                    <div className="flex items-center gap-2 text-xs px-2 py-1 rounded-full border bg-gray-50">
                      <span className="font-semibold">{activeGame.period || "Q1"}</span>
                      <span className="opacity-70">•</span>
                      <span className="font-semibold">{formatScore(scoreHome, scoreOpp)}</span>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    {statButtons.map((b) => (
                      <button
                        key={b.label}
                        onClick={() => onTapStat(b)}
                        className={`px-4 py-4 rounded-2xl border text-base ${b.hot ? "bg-black text-white" : "bg-white"}`}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 text-sm font-semibold">Corrections</div>
                  <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                    {negButtons.map((b) => (
                      <button key={b.label} onClick={() => onTapStat(b)} className="px-4 py-4 rounded-2xl border text-base bg-white">
                        {b.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button onClick={undoLast} className="px-3 py-2 rounded-xl border text-sm bg-white">
                      Undo
                    </button>
                    <button onClick={clearSelectedPlayer} className="px-3 py-2 rounded-xl border text-sm bg-white">
                      Clear Player
                    </button>
                    <button onClick={clearGameStats} className="px-3 py-2 rounded-xl border text-sm bg-white">
                      Clear Game
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* end right */}
        </div>
      </div>
    );
  };

  // -----------------------------
  // Rosters tab (bulk paste + copy for both)
  // -----------------------------
  const RosterEditor = ({
    title,
    subtitle,
    list,
    onSetList,
  }: {
    title: string;
    subtitle: React.ReactNode;
    list: Player[];
    onSetList: (next: Player[]) => void;
  }) => {
    const [bulkOpen, setBulkOpen] = useState(true);
    const [bulkText, setBulkText] = useState("");

    const setPlayer = (idx: number, patch: Partial<Player>) => {
      const next = [...list];
      next[idx] = { ...next[idx], ...patch };
      onSetList(next);
    };

    const applyBulk = (mode: "replace" | "fill") => {
      const parsed = parseRosterSmart(bulkText);
      if (!parsed.length) {
        setToast("Nothing recognized — paste again");
        return;
      }

      const next = [...list];

      if (mode === "replace") {
        for (let i = 0; i < next.length; i++) {
          const row = parsed[i];
          if (!row) next[i] = { ...next[i], no: "", name: "", ht: "", cls: "", pos: "" };
          else next[i] = { ...next[i], ...row };
        }
      } else {
        let pi = 0;
        for (let i = 0; i < next.length && pi < parsed.length; i++) {
          const p = next[i];
          const isEmpty = !(p.no || p.name || p.ht || p.cls || p.pos);
          if (!isEmpty) continue;
          next[i] = { ...p, ...parsed[pi++] };
        }
      }

      onSetList(next);
      setToast(`Imported ${parsed.length} row(s)`);
      setBulkText("");
    };

    const copyRoster = async () => {
      try {
        await copyToClipboard(rosterToTSV(list));
        setToast("Roster copied (paste into Excel)");
      } catch {
        setToast("Clipboard blocked by browser");
      }
    };

    return (
      <div className="w-full px-2 sm:px-3 py-3">
        <div className="bg-white rounded-2xl border shadow-sm p-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <div className="text-xl font-semibold tracking-tight">{title}</div>
              <div className="text-sm text-gray-600 mt-1">{subtitle}</div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setBulkOpen((v) => !v)} className="px-3 py-2 rounded-xl border text-sm bg-white">
                {bulkOpen ? "Hide Paste Box" : "Show Paste Box"}
              </button>
              <button onClick={copyRoster} className="px-3 py-2 rounded-xl bg-black text-white text-sm">
                Copy Roster (Excel)
              </button>
            </div>
          </div>

          {bulkOpen && (
            <div className="mt-4 rounded-2xl border p-3 bg-gray-50">
              <div className="text-sm font-semibold">Paste roster from website</div>
              <div className="text-xs text-gray-600 mt-1">Tabs/spaces both work.</div>

              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={"3\tJordyn Pugh\tSO\tG\t5'1\"\n10\tGracen Werdel\tSR\tG\t5'7\""}
                className="mt-2 w-full h-44 p-3 rounded-xl border font-mono text-xs"
              />

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button onClick={() => applyBulk("replace")} className="px-3 py-2 rounded-xl bg-black text-white text-sm">
                  Replace Roster
                </button>
                <button onClick={() => applyBulk("fill")} className="px-3 py-2 rounded-xl border bg-white text-sm">
                  Fill Empty Slots
                </button>
                <div className="flex-1" />
                <button onClick={() => setBulkText("")} className="px-3 py-2 rounded-xl border bg-white text-sm">
                  Clear
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b">
                  <th className="py-2 text-left">No</th>
                  <th className="py-2 text-left">Name</th>
                  <th className="py-2 text-left">Ht</th>
                  <th className="py-2 text-left">Class</th>
                  <th className="py-2 text-left">Pos</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p, idx) => (
                  <tr key={p.id} className="border-b hover:bg-gray-50">
                    <td className="py-2 pr-2 w-16">
                      <input value={p.no} onChange={(e) => setPlayer(idx, { no: e.target.value })} className="w-full px-2 py-2 rounded-xl border" />
                    </td>
                    <td className="py-2 pr-2 min-w-[220px]">
                      <input value={p.name} onChange={(e) => setPlayer(idx, { name: e.target.value })} className="w-full px-2 py-2 rounded-xl border" />
                    </td>
                    <td className="py-2 pr-2 w-24">
                      <input value={p.ht} onChange={(e) => setPlayer(idx, { ht: e.target.value })} className="w-full px-2 py-2 rounded-xl border" />
                    </td>
                    <td className="py-2 pr-2 w-24">
                      <input value={p.cls} onChange={(e) => setPlayer(idx, { cls: e.target.value })} className="w-full px-2 py-2 rounded-xl border" />
                    </td>
                    <td className="py-2 pr-2 w-24">
                      <input value={p.pos} onChange={(e) => setPlayer(idx, { pos: e.target.value })} className="w-full px-2 py-2 rounded-xl border" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 rounded-2xl border p-3 bg-gray-50">
            <div className="text-sm font-semibold">Tip</div>
            <div className="text-sm text-gray-700 mt-1">
              Import → then <b>Copy Roster (Excel)</b> for a clean backup.
            </div>
          </div>
        </div>
      </div>
    );
  };

  const RostersTab = () => {
    const setRustlers = (next: Player[]) => setStore((s) => ({ ...s, roster: { ...s.roster, [team]: next } }));
    const setOppTemplate = (next: Player[]) => setStore((s) => ({ ...s, oppRoster: { ...s.oppRoster, [team]: next } }));

    return (
      <div>
        <div className="w-full px-2 sm:px-3 pt-3">
          <div className="bg-white rounded-2xl border shadow-sm p-3 flex items-center gap-2">
            <button
              onClick={() => setRosterMode("rustlers")}
              className={`px-3 py-2 rounded-xl border text-sm ${rosterMode === "rustlers" ? "bg-black text-white" : "bg-white"}`}
            >
              Rustlers Roster
            </button>
            <button
              onClick={() => setRosterMode("opponent")}
              className={`px-3 py-2 rounded-xl border text-sm ${rosterMode === "opponent" ? "bg-black text-white" : "bg-white"}`}
            >
              Opponent Roster (Template)
            </button>
            <div className="text-xs text-gray-500 ml-auto">
              Team: <span className="font-semibold">{team === "girls" ? "Girls" : "Boys"}</span>
            </div>
          </div>
        </div>

        {rosterMode === "rustlers" ? (
          <RosterEditor
            title={`${team === "girls" ? "Girls" : "Boys"} — Rustlers Roster`}
            subtitle={
              <>
                Supported paste format: <b>No, Name, Class, Pos, Height</b>
              </>
            }
            list={rustlersRoster}
            onSetList={setRustlers}
          />
        ) : (
          <RosterEditor
            title={`${team === "girls" ? "Girls" : "Boys"} — Opponent Roster (Template)`}
            subtitle={
              <>
                Paste opponent roster here (same format). Used when you create a <b>New Game</b>.
              </>
            }
            list={opponentTemplateRoster}
            onSetList={setOppTemplate}
          />
        )}
      </div>
    );
  };

  const SeasonTab = () => {
    const gp = season.gp;

    const Row = ({ label, line }: { label: string; line: any }) => (
      <tr className="border-b">
        <td className="py-2 font-semibold">{label}</td>
        <td className="py-2 text-right">{line.pts}</td>
        <td className="py-2 text-right">
          {line.fgm}/{line.fga} <span className="text-xs text-gray-500">{pct(line.fgm, line.fga)}</span>
        </td>
        <td className="py-2 text-right">
          {line.tpm}/{line.tpa} <span className="text-xs text-gray-500">{pct(line.tpm, line.tpa)}</span>
        </td>
        <td className="py-2 text-right">
          {line.ftm}/{line.fta} <span className="text-xs text-gray-500">{pct(line.ftm, line.fta)}</span>
        </td>
        <td className="py-2 text-right">{line.to}</td>
        <td className="py-2 text-right">{line.pf}</td>
      </tr>
    );

    const makeAvgLine = (avgObj: any) => ({
      pts: avgObj.pts,
      fgm: avgObj.fgm,
      fga: avgObj.fga,
      tpm: avgObj.tpm,
      tpa: avgObj.tpa,
      ftm: avgObj.ftm,
      fta: avgObj.fta,
      to: avgObj.to,
      pf: avgObj.pf,
    });

    return (
      <div className="w-full px-2 sm:px-3 py-3">
        <div className="bg-white rounded-2xl border shadow-sm p-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-lg font-semibold">Season Overview</div>
              <div className="text-sm text-gray-600 mt-1">Auto-aggregates from all saved games for this team.</div>
            </div>
            <button onClick={exportSeasonCSV} className="px-3 py-2 rounded-xl border text-sm">
              Export
            </button>
          </div>

          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="px-2 py-1 rounded-full bg-gray-100 border">Games: {gp}</span>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b">
                  <th className="py-2 text-left">Side</th>
                  <th className="py-2 text-right">PTS</th>
                  <th className="py-2 text-right">FG</th>
                  <th className="py-2 text-right">3</th>
                  <th className="py-2 text-right">FT</th>
                  <th className="py-2 text-right">TO</th>
                  <th className="py-2 text-right">PF</th>
                </tr>
              </thead>
              <tbody>
                <Row label="Rustlers Totals" line={season.homeTotals} />
                <Row label="Opp Totals" line={season.oppTotals} />
                <Row label="Rustlers Per Game" line={makeAvgLine(season.homeAvgs)} />
                <Row label="Opp Per Game" line={makeAvgLine(season.oppAvgs)} />
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      {header}
      {tab === "live" && <Live />}
      {tab === "roster" && <RostersTab />}
      {tab === "season" && <SeasonTab />}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
          <div className="px-4 py-3 rounded-2xl bg-black text-white text-sm shadow-lg">{toast}</div>
        </div>
      )}

      <div className="py-6" />
    </div>
  );
}

// -----------------------------
// Players Table (removed REB/AST/STL/BLK columns)
// -----------------------------
function PlayersTable({
  side,
  players,
  ids,
  lines,
  selected,
  onSelect,
  compactMode,
  editable,
  onEdit,
  rowRefs,
}: {
  side: SideKey;
  players: Player[];
  ids: string[];
  lines: Record<string, Line>;
  selected: { side: SideKey; playerId: string } | null;
  onSelect: (playerId: string) => void;
  compactMode: boolean;
  editable: boolean;
  onEdit: (id: string, patch: Partial<Player>) => void;
  rowRefs: React.MutableRefObject<Record<string, HTMLTableRowElement | null>>;
}) {
  const getPlayer = (id: string) => players.find((p) => p.id === id);

  return (
    <table className="w-full text-sm border-separate border-spacing-0">
      <thead className="sticky top-0 z-20 bg-white">
        <tr className="text-xs text-gray-500 border-b">
          <th className="py-2 text-left sticky left-0 z-30 bg-white border-b w-14 pl-2">No</th>
          <th className="py-2 text-left sticky left-[56px] z-30 bg-white border-b min-w-[160px]">Name</th>
          <th className="py-2 text-left sticky left-[216px] z-30 bg-white border-b w-14">Pos</th>

          {editable && (
            <>
              <th className="py-2 text-left border-b w-20">Ht</th>
              <th className="py-2 text-left border-b w-20">Cls</th>
            </>
          )}

          <th className="py-2 text-right border-b w-14">PTS</th>
          <th className="py-2 text-right border-b w-20">FG</th>
          <th className="py-2 text-right border-b w-20">3</th>
          <th className="py-2 text-right border-b w-20">FT</th>
          <th className="py-2 text-right border-b w-14">TO</th>
          <th className="py-2 text-right border-b w-14 pr-2">PF</th>
        </tr>
      </thead>

      <tbody>
        {ids.map((id) => {
          const p = getPlayer(id);
          if (!p) return null;
          const l = lines[id] || emptyLine();
          const active = selected?.side === side && selected?.playerId === id;

          const rowH = compactMode ? "py-1.5" : "py-2.5";
          const cellBg = active ? "bg-yellow-50" : "bg-white";
          const hoverBg = active ? "" : "hover:bg-gray-50";

          return (
            <tr
              key={`${side}_${id}`}
              ref={(el) => {
                rowRefs.current[id] = el;
              }}
              onClick={() => onSelect(id)}
              className={`border-b cursor-pointer ${hoverBg}`}
            >
              <td className={`${rowH} sticky left-0 z-10 ${cellBg} border-b pl-2 w-14`}>
                {editable ? (
                  <input
                    value={p.no}
                    onChange={(e) => onEdit(id, { no: e.target.value })}
                    className="w-12 px-2 py-2 rounded-xl border bg-white text-base"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="font-medium text-base">{p.no}</span>
                )}
              </td>

              <td className={`${rowH} sticky left-[56px] z-10 ${cellBg} border-b min-w-[160px]`}>
                {editable ? (
                  <input
                    value={p.name}
                    onChange={(e) => onEdit(id, { name: e.target.value })}
                    className="w-full max-w-[260px] px-2 py-2 rounded-xl border bg-white text-base"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="font-medium text-base">{p.name}</span>
                )}
              </td>

              <td className={`${rowH} sticky left-[216px] z-10 ${cellBg} border-b w-14`}>
                {editable ? (
                  <input
                    value={p.pos}
                    onChange={(e) => onEdit(id, { pos: e.target.value })}
                    className="w-12 px-2 py-2 rounded-xl border bg-white text-base"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="text-base">{p.pos}</span>
                )}
              </td>

              {editable && (
                <>
                  <td className={`${rowH} border-b w-20`}>
                    <input
                      value={p.ht}
                      onChange={(e) => onEdit(id, { ht: e.target.value })}
                      className="w-16 px-2 py-2 rounded-xl border bg-white text-base"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className={`${rowH} border-b w-20`}>
                    <input
                      value={p.cls}
                      onChange={(e) => onEdit(id, { cls: e.target.value })}
                      className="w-16 px-2 py-2 rounded-xl border bg-white text-base"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                </>
              )}

              <td className={`${rowH} border-b text-right w-14 font-semibold text-base`}>{l.pts}</td>
              <td className={`${rowH} border-b text-right w-20 text-base`}>
                {l.fgm}/{l.fga} <span className="text-xs text-gray-500">{pct(l.fgm, l.fga)}</span>
              </td>
              <td className={`${rowH} border-b text-right w-20 text-base`}>
                {l.tpm}/{l.tpa} <span className="text-xs text-gray-500">{pct(l.tpm, l.tpa)}</span>
              </td>
              <td className={`${rowH} border-b text-right w-20 text-base`}>
                {l.ftm}/{l.fta} <span className="text-xs text-gray-500">{pct(l.ftm, l.fta)}</span>
              </td>
              <td className={`${rowH} border-b text-right w-14 text-base`}>{l.to}</td>
              <td className={`${rowH} border-b text-right w-14 pr-2 text-base`}>{l.pf}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// -----------------------------
// Totals Card (removed REB/AST/STL/BLK)
// -----------------------------
function TotalsCard({ title, line }: { title: string; line: any }) {
  return (
    <div className="rounded-2xl border p-3">
      <div className="text-xs text-gray-500">{title}</div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <Mini k="PTS" v={line.pts} bold />
        <Mini k="FG" v={`${line.fgm}/${line.fga}`} />
        <Mini k="FG%" v={pct(line.fgm, line.fga)} />
        <Mini k="3" v={`${line.tpm}/${line.tpa}`} />
        <Mini k="3%" v={pct(line.tpm, line.tpa)} />
        <Mini k="FT" v={`${line.ftm}/${line.fta}`} />
        <Mini k="FT%" v={pct(line.ftm, line.fta)} />
        <Mini k="TO" v={line.to} />
        <Mini k="PF" v={line.pf} />
      </div>
    </div>
  );
}

function Mini({ k, v, bold }: { k: string; v: any; bold?: boolean }) {
  return (
    <div className="rounded-xl bg-white border px-2 py-2">
      <div className="text-[10px] text-gray-500">{k}</div>
      <div className={`text-sm ${bold ? "font-semibold" : ""}`}>{v === "" ? "—" : v}</div>
    </div>
  );
}
