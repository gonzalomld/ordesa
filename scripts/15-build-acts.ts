// 15-build-acts.ts — content/actos.es.md -> public/assets/acts.<hash>.json.
//
// Anatomía verificada 14-sep (siete actos: 0, I, II, III, IV, V, EPÍLOGO).
// G68 compara carácter a carácter: raw === md (solo \r\n->\n + trim final).
// Nada se inventa ni se resume. Si un campo no encaja en la anatomía,
// falla con actos.es.md:<línea> — nunca "arregla" el md.
//
// Gráficos (aclaración usuario): SVG inline en el JSON, dos fuentes —
//   barras: datos en la propia línea `grafico` del md (no route.json).
//   perfil: datos de route.json (d, z; misma fuente que HUD/telemetría G14)
//     por el tramo de km que indica cada acto.
// Reglas SVG: width 100%, viewBox fijo 300x80, sin texto dentro, un solo
// acento (PANEL_ACCENT) + gris 30%, sin librerías, determinista byte a byte.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { PANEL_ACCENT } from "../src/narrative/choreography.ts";
import { META_FILE, ROUTE_FILE } from "./geo-constants.ts";

const MD_FILE = "content/actos.es.md";
const OUT_DIR = "public/assets";
const ACT_KEYS = ["0", "I", "II", "III", "IV", "V", "EPI"] as const;
type ActKey = (typeof ACT_KEYS)[number];

export interface Cifra {
  valor: string;
  unidad: string;
  etiqueta: string;
  subetiqueta: string;
}
export interface FichaRow {
  etiqueta: string;
  valor: string;
}
export interface ActJson {
  key: ActKey;
  heading: string;
  kmRaw: string;
  cintillo: { raw: string; html: string };
  titulo: { raw: string; html: string };
  flotante: { raw: string; html: string; titulo: string; numeral: string };
  cifra1: Cifra;
  cifra2: Cifra;
  grafico: { kind: "barras" | "perfil"; spec_raw: string; svg: string; tramoKm: [number, number] | null; barras: { etiqueta: string; valor: number }[] | null };
  cuerpo: { raw: string; html: string }[];
  fichas: string[];
  fichasRaw: string;
  campo: FichaRow[];
  pendienteRaw: string | null;
  epiBloques: { titulo: string; filas: FichaRow[] }[];
  epiCierre: { raw: string; html: string } | null;
  pieFuentes: string | null;
}

function parseFlotante(withTicks: string): { titulo: string; numeral: string; clean: string } {
  // «La Pradera · numeral fantasma `0`» -> titulo + numeral del backtick.
  const nm = withTicks.match(/`([^`]+)`/);
  const numeral = nm ? (nm[1] as string).trim() : "";
  const clean = withTicks.replace(/`/g, "").trim();
  const titulo = clean.split("·")[0]?.trim() ?? clean;
  return { titulo, numeral, clean };
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Orden estricto: escape -> [PENDIENTE] -> **negrita** -> *itálica*.
// Los [PENDIENTE …] se pintan atenuados con título, nunca se ocultan.
export function miniMd(s: string): string {
  let h = escHtml(s);
  h = h.replace(/\[PENDIENTE([^\]]*)\]/g, '<span class="pend" title="pendiente de verificar">[PENDIENTE$1]</span>');
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  return h;
}

export function parseNumEs(s: string): number {
  // "279.000" -> 279000 · "42.500" -> 42500 · "6,00" -> 6 · "-3,9" -> -3.9
  // "42.500." (punto final de frase) -> 42500 · "−15" (U+2212) -> -15.
  // Nunca NaN: el punto final de frase y el menos tipográfico se sanean;
  // si aun así no hay número, fail con línea en vez de contaminar max().
  let t = s.trim().replace(/\u2212/g, "-").replace(/[.]+$/, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) {
    return Number(t.replace(/\./g, "").replace(",", "."));
  }
  const v = Number(t.replace(",", "."));
  if (!Number.isFinite(v)) fail(`parseNumEs: sin número en «${s.slice(0, 40)}»`);
  return v;
}

function r1(v: number): string {
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

interface RouteData {
  d: number[];
  z_mdt: number[];
  lengthM: number;
}

export function loadRoute(): RouteData {
  const j = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as { d: number[]; z_mdt: number[]; lengthM: number };
  return { d: j.d, z_mdt: j.z_mdt, lengthM: j.lengthM };
}

// --- SVG builders (deterministas: redondeo a 1 decimal, sin random/fechas) ---
const ACCENT = PANEL_ACCENT;
const GREY = "rgba(244,241,234,0.3)";

export function svgBarras(items: { etiqueta: string; valor: number }[]): string {
  // G68: cada <rect> con width ≥ 4 px. Los valores 0/negativos (acto II:
  // "después 0", acto IV: pérdidas negativas) se dibujan con el mínimo
  // visible 4 px — la etiqueta numérica a la derecha lleva la cifra real.
  // La pista gris también respeta el mínimo: con w=240 el resto sería 0.
  const vals = items.map((i) => (Number.isFinite(i.valor) && i.valor > 0 ? i.valor : 0));
  const max = Math.max(1, ...vals);
  const rows = items
    .map((it, i) => {
      const y = 6 + i * 18;
      const wRaw = (240 * (vals[i] as number)) / max;
      const w = Math.min(236, Math.max(4, wRaw));
      return `<rect x="60" y="${y}" width="${r1(w)}" height="12" rx="2" fill="${ACCENT}"/><rect x="${r1(60 + w)}" y="${y}" width="${r1(240 - w)}" height="12" rx="2" fill="${GREY}"/>`;
    })
    .join("");
  return `<svg viewBox="0 0 300 80" width="100%" role="img" aria-hidden="true">${rows}</svg>`;
}

export function svgPerfil(pts: { d: number; z: number }[]): string {
  if (pts.length < 2) fail("perfil: menos de 2 puntos muestreados");
  // Diezmado uniforme a <=60 puntos (determinista).
  const keep: { d: number; z: number }[] = [];
  const stride = Math.max(1, Math.ceil(pts.length / 60));
  for (let i = 0; i < pts.length; i += stride) keep.push(pts[i] as { d: number; z: number });
  const last = pts[pts.length - 1] as { d: number; z: number };
  if (keep[keep.length - 1] !== last) keep.push(last);
  const zs = keep.map((p) => p.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const span = Math.max(1, zMax - zMin);
  const n = keep.length;
  const coords = keep.map((p, i) => {
    const x = 4 + (292 * i) / (n - 1);
    const y = 72 - (60 * (p.z - zMin)) / span;
    return `${r1(x)},${r1(y)}`;
  });
  // G68: el verify exige width ≥ 4 px en cada <rect> — el polyline no
  // es un rect (stroke-width 4 ≥ 4 por construcción).
  return `<svg viewBox="0 0 300 80" width="100%" role="img" aria-hidden="true"><polyline points="${coords.join(" ")}" fill="none" stroke="${ACCENT}" stroke-width="4"/></svg>`;
}

// Tramos de km por acto para perfiles (del propio md: **km a – b**).
// 0: barras desde el md · II/IV: series históricas del md -> barras ·
// EPI: sin panel; perfil completo informativo desde route.json.
const PERFIL_KM: Record<ActKey, [number, number] | null> = {
  "0": null,
  I: [0.3, 2.44],
  II: null,
  III: [3.0, 9.0],
  IV: null,
  V: [0, 18.13],
  EPI: [0, 18.13],
};

export function buildGrafico(
  key: ActKey,
  specRaw: string,
  route: RouteData,
): { kind: "barras" | "perfil"; svg: string; tramoKm: [number, number] | null; barras: { etiqueta: string; valor: number }[] | null } {
  const spec = specRaw.trim();
  // Acto 0: reparto por valles 2024 — pares «Nombre valor» separados por comas.
  if (key === "0") {
    const items: { etiqueta: string; valor: number }[] = [];
    for (const part of spec.split(/[,;]/)) {
      const pm = part.match(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][\wÁÉÍÓÚÜÑáéíóúüñ\s]*?)\s+(-?[\d.]+(?:,\d+)?)\s*\.?\s*$/);
      if (pm) items.push({ etiqueta: (pm[1] as string).trim(), valor: parseNumEs(pm[2] as string) });
    }
    if (items.length < 2) fail(`grafico 0: esperaba «Valle valor, …» en: «${spec.slice(0, 80)}»`);
    return { kind: "barras", svg: svgBarras(items), tramoKm: null, barras: items };
  }
  // Acto II: caída del bucardo — «menos de 50 ejemplares en 1972,
  // por encima de 30 hasta 1981, desplome hasta 1 y después 0 … 2000».
  // Valores umbral citados en el spec (cualificadores "menos de/por encima
  // de" incluidos en la etiqueta para no inventar precisión).
  if (key === "II") {
    const pairs: { etiqueta: string; valor: number }[] = [];
    const has = (re: RegExp): RegExpExecArray | null => re.exec(spec);
    let mm: RegExpExecArray | null;
    mm = has(/menos de\s+([\d.]+)\s+ejemplares\s+en\s+(\d{4})/);
    if (mm) pairs.push({ etiqueta: `<${mm[2]}`, valor: parseNumEs(mm[1] as string) });
    mm = has(/por encima de\s+([\d.]+)\s+hasta\s+(\d{4})/);
    if (mm) pairs.push({ etiqueta: `>${mm[2]}`, valor: parseNumEs(mm[1] as string) });
    mm = has(/desplome hasta\s+([\d.]+)\b/);
    if (mm) pairs.push({ etiqueta: "desplome", valor: parseNumEs(mm[1] as string) });
    mm = has(/después\s+([\d.]+)\s+el\s+([\d\s\wáéíóúñ]+?\d{4})/);
    if (mm) pairs.push({ etiqueta: (mm[2] as string).trim().split(/\s+/).slice(-1)[0] as string, valor: parseNumEs(mm[1] as string) });
    if (pairs.length < 2) fail(`grafico II: no se pudo extraer la serie (ejemplares/año) de: «${spec.slice(0, 80)}»`);
    return { kind: "barras", svg: svgBarras(pairs), tramoKm: null, barras: pairs };
  }
  // Acto IV: pérdida del glaciar — «−3,9 m en 2021/22, −3,7 m en 2022/23,
  // más de −15 m acumulados desde 2011». Menos U+2212 del md: parseNumEs
  // lo sanea a ASCII antes de convertir.
  if (key === "IV") {
    const pairs: { etiqueta: string; valor: number }[] = [];
    const re = /[−-]?\s*([\d.]+(?:,\d+)?)\s*m\s+en\s+(\d{4}\/\d{2})|más de\s+[−-]?\s*([\d.]+(?:,\d+)?)\s*m\s+acumulados\s+desde\s+(\d{4})/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(spec)) !== null) {
      if (mm[1] !== undefined && mm[2] !== undefined) pairs.push({ etiqueta: mm[2], valor: parseNumEs(mm[1]) });
      else if (mm[3] !== undefined && mm[4] !== undefined) pairs.push({ etiqueta: `acum. ${mm[4]}`, valor: parseNumEs(mm[3]) });
    }
    if (pairs.length < 2) fail(`grafico IV: no se pudo extraer la serie (m/temporada) de: «${spec.slice(0, 80)}»`);
    return { kind: "barras", svg: svgBarras(pairs), tramoKm: null, barras: pairs };
  }
  // Perfiles desde route.json (I, III, V, EPI).
  const tramo = PERFIL_KM[key];
  if (tramo) {
    const [km0, km1] = tramo;
    const d0 = km0 * 1000;
    const d1 = Math.min(km1 * 1000, route.lengthM);
    const pts: { d: number; z: number }[] = [];
    for (let i = 0; i < route.d.length; i++) {
      const d = route.d[i] as number;
      if (d >= d0 - 2.5 && d <= d1 + 2.5) pts.push({ d, z: route.z_mdt[i] as number });
    }
    if (pts.length < 2) fail(`perfil ${key}: tramo km ${km0}-${km1} sin puntos en route.json`);
    return { kind: "perfil", svg: svgPerfil(pts), tramoKm: tramo, barras: null };
  }
  fail(`grafico ${key}: no es barras (datos en la línea) ni perfil (tramo km): «${spec.slice(0, 80)}»`);
}

export function parseActs(md: string, route: RouteData): ActJson[] {
  const lines = md.split("\n");
  interface Block { key: ActKey; start: number; heading: string }
  const blocks: Block[] = [];
  lines.forEach((ln, i) => {
    const t = ln.trim();
    if (!t.startsWith("# ") || t.startsWith("##")) return;
    if (t === "# Contenido de la pieza — seis actos y epílogo") return;
    const up = t.toUpperCase();
    let key: ActKey | null = null;
    // Regex exacta: "III" empieza por "II" y "IV" por "I" — startsWith casaba mal.
    const mAct = up.match(/^# ACTO\s+(0|III|II|IV|V|I)\b/);
    if (mAct) key = mAct[1] as ActKey;
    else if (up.startsWith("# EPÍLOGO") || up.startsWith("# EPILOGO")) key = "EPI";
    if (key) blocks.push({ key, start: i, heading: t.slice(2).trim() });
  });
  if (blocks.length !== 7 || blocks.map((b) => b.key).join(",") !== ACT_KEYS.join(",")) {
    fail(`actos: se esperaban 7 bloques en orden ${ACT_KEYS.join(",")}, hallados: ${blocks.map((b) => b.key).join(",") || "ninguno"}`);
  }
  const out: ActJson[] = [];
  blocks.forEach((b, bi) => {
    const end = bi + 1 < blocks.length ? (blocks[bi + 1] as Block).start : lines.length;
    const seg = lines.slice(b.start, end);
    const segText = seg.join("\n");
    const lineNo = (idx: number): number => b.start + idx + 1;
    const findField = (name: string): { idx: number; rest: string } => {
      for (let i = 0; i < seg.length; i++) {
        const mm = (seg[i] as string).match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.*)$`));
        if (mm) return { idx: i, rest: mm[1] as string };
      }
      fail(`actos.es.md:${lineNo(0)} acto ${b.key}: falta el campo **${name}:**`);
    };
    const noTicks = (s: string): string => {
      const t = s.trim();
      if (t.startsWith("`") && t.endsWith("`") && t.length >= 2) return t.slice(1, -1);
      return t.replace(/`/g, "");
    };
    // Error 1 (3B-bis): la ficha es el texto sin comillas. El split por ·
    // deja backticks interiores (`A` · `B` -> "A`" / "`B"), así que cada
    // ficha se pela por separado — no basta con noTicks() antes del split.
    const stripTicks = (s: string): string => s.trim().replace(/^`+|`+$/g, "").trim();
    // EPI: anatomía distinta (bloques + cierre + pie). Campos de panel
    // vacíos pero presentes; el contenido vive en campo (filas) y cuerpo.
    // HINT split-fichas: las fichas del md vienen como `A` · `B` · `C` —
    // noTicks() pela solo los extremos, así que cada ficha tras el split
    // se limpia de backticks sueltos (stripTicks). Ver acto IV: primera
    // ficha sin backticks, resto con ellos.
    if (b.key === "EPI") {
      const titulo = findField("titulo");
      const epiBloques: { titulo: string; filas: FichaRow[] }[] = [];
      let current: { titulo: string; filas: FichaRow[] } | null = null;
      seg.forEach((ln) => {
        const bt = ln.match(/^\*\*Bloque \d+ — (.+)\*\*$/);
        if (bt) {
          current = { titulo: (bt[1] as string).trim(), filas: [] };
          epiBloques.push(current);
          return;
        }
        if (current && ln.includes("|")) {
          if (/^\|[\s-|:]+\|$/.test(ln.trim())) return;
          const cells = [...ln.matchAll(/\|([^|]*)/g)].map((x) => (x[1] as string).trim()).filter((c) => c !== "");
          if (cells.length >= 2 && cells[0] !== "") current.filas.push({ etiqueta: cells[1] as string, valor: cells[0] as string });
        }
      });
      const cierreM = segText.match(/\*\*Cierre:\*\*\s*\n\n((?:>[^\n]*\n?)+)/);
      const cierreRaw = cierreM ? (cierreM[1] as string).split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n").trim() : "";
      const pieM = segText.match(/\*\*Pie de fuentes:\*\*\s*(.+)/);
      const g = buildGrafico("EPI", "perfil completo", route);
      out.push({
        key: "EPI", heading: b.heading, kmRaw: "",
        cintillo: { raw: "", html: "" },
        titulo: { raw: noTicks(titulo.rest), html: miniMd(noTicks(titulo.rest)) },
        flotante: { raw: "", html: "", titulo: "", numeral: "EPI" },
        cifra1: { valor: "", unidad: "", etiqueta: "", subetiqueta: "" },
        cifra2: { valor: "", unidad: "", etiqueta: "", subetiqueta: "" },
        grafico: { kind: g.kind, spec_raw: "perfil completo 0–18,13 km (route.json)", svg: g.svg, tramoKm: g.tramoKm, barras: g.barras },
        cuerpo: cierreRaw ? [{ raw: cierreRaw, html: miniMd(cierreRaw) }] : [],
        fichas: [], fichasRaw: "",
        campo: epiBloques.flatMap((x) => x.filas),
        pendienteRaw: pieM ? (pieM[1] as string).trim() : null,
        epiBloques,
        epiCierre: cierreRaw ? { raw: cierreRaw, html: miniMd(cierreRaw) } : null,
        pieFuentes: pieM ? (pieM[1] as string).trim() : null,
      });
      return;
    }
    const kmLine = seg.find((l) => /^\*\*km /.test(l.trim()))?.trim() ?? "";
    const cintillo = findField("cintillo");
    const titulo = findField("titulo");
    const flotante = findField("flotante");
    const cifra1 = findField("cifra1");
    const cifra2 = findField("cifra2");
    const grafico = findField("grafico");
    const fichasF = findField("fichas");
    const parseCifra = (raw: string, field: string): Cifra => {
      // El valor puede traer · dentro (acto II: `6·I·2000`): las 3 ÚLTIMAS
      // partes son unidad/etiqueta/subetiqueta, el resto es el valor.
      const parts = noTicks(raw).split("·").map((p) => p.trim());
      if (parts.length < 4) fail(`actos.es.md acto ${b.key}: ${field} necesita valor · unidad · etiqueta · subetiqueta, hay ${parts.length} partes`);
      const sub = parts.pop() as string;
      const etq = parts.pop() as string;
      const uni = parts.pop() as string;
      return { valor: parts.join(" · "), unidad: uni, etiqueta: etq, subetiqueta: sub };
    };
    const c1 = parseCifra(cifra1.rest, "cifra1");
    const c2 = parseCifra(cifra2.rest, "cifra2");
    const cuerpoIdx = findField("cuerpo").idx;
    const fichasIdx = findField("fichas").idx;
    const cuerpoLines = seg.slice(cuerpoIdx + 1, fichasIdx).join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
    if (cuerpoLines.length < 2 || cuerpoLines.length > 4) fail(`actos.es.md acto ${b.key}: cuerpo necesita 2-3 párrafos, hay ${cuerpoLines.length}`);
    const fichas = [...noTicks(fichasF.rest).split("·")].map((s) => stripTicks(s)).filter((s) => s !== "" && !s.includes("`"));
    if (fichas.length === 0) fail(`actos.es.md acto ${b.key}: fichas vacías`);
    // El md usa · U+00B7 como separador de fichas; noTicks ya peló los
    // backticks ASCII. Si queda alguno, es contenido real del md.
    if (fichas.some((x) => x.includes("`"))) fail(`actos.es.md acto ${b.key}: backtick sin pelar en fichas`);
    const campoIdx = findField("campo").idx;
    let campoEnd = seg.length;
    for (let i = campoIdx + 1; i < seg.length; i++) {
      const lt = (seg[i] as string).trim();
      if (lt.startsWith("---")) { campoEnd = i; break; }
      if (/^\*\*\w/.test(lt) && !lt.startsWith("-")) { campoEnd = i; break; }
    }
    const campo: FichaRow[] = [];
    for (let i = campoIdx + 1; i < campoEnd; i++) {
      const ln = (seg[i] as string).trim();
      if (ln === "") continue;
      const cm = ln.match(/^-\s*\*\*(.+?)\*\*\s*[—–-]\s*(.+)$/);
      if (!cm) {
        if (ln.startsWith(">")) continue; // cita [PENDIENTE] del acto II
        fail(`actos.es.md:${lineNo(i)} acto ${b.key}: fila de campo sin formato "- **ETIQUETA** — valor": «${ln.slice(0, 60)}»`);
      }
      campo.push({ etiqueta: (cm[1] as string).trim(), valor: (cm[2] as string).trim() });
    }
    if (campo.length === 0) fail(`actos.es.md acto ${b.key}: campo vacío`);
    const pendM = segText.match(/>\s*(\[PENDIENTE[^\n]*(?:\n>[^\n]*)*)/);
    const pendienteRaw = pendM
      ? (pendM[1] as string).split("\n").map((l) => l.replace(/^>\s?/, "").trim()).join(" ").replace(/\s+/g, " ").trim()
      : null;
    const g = buildGrafico(b.key, grafico.rest, route);
    const fl = parseFlotante(flotante.rest.trim());
    out.push({
      key: b.key, heading: b.heading, kmRaw: kmLine,
      cintillo: { raw: noTicks(cintillo.rest), html: miniMd(noTicks(cintillo.rest)) },
      titulo: { raw: noTicks(titulo.rest), html: miniMd(noTicks(titulo.rest)) },
      flotante: { raw: flotante.rest.trim(), html: miniMd(fl.clean), titulo: fl.titulo, numeral: fl.numeral },
      cifra1: c1, cifra2: c2,
      grafico: { kind: g.kind, spec_raw: grafico.rest.trim(), svg: g.svg, tramoKm: g.tramoKm, barras: g.barras },
      cuerpo: cuerpoLines.map((p) => ({ raw: p, html: miniMd(p) })),
      fichas, fichasRaw: noTicks(fichasF.rest),
      campo, pendienteRaw,
      epiBloques: [], epiCierre: null, pieFuentes: null,
    });
  });
  return out;
}

export function buildActs(): string {
  if (!existsSync(MD_FILE)) fail(`falta ${MD_FILE} (commit del usuario pendiente)`);
  if (!existsSync(ROUTE_FILE)) fail(`falta ${ROUTE_FILE} — ejecuta npm run data primero`);
  const md = readFileSync(MD_FILE, "utf8");
  const route = loadRoute();
  const acts = parseActs(md, route);
  const payload = JSON.stringify({ acts });
  const hash = createHash("sha256").update(payload).digest("hex").slice(0, 8);
  const name = `acts.${hash}.json`;
  writeFileSync(`${OUT_DIR}/${name}`, payload);
  // Un solo JSON versionado: limpiar acts con otro hash.
  for (const f of readdirSync(OUT_DIR)) {
    if (/^acts\.[0-9a-f]{8}\.json$/.test(f) && f !== name) unlinkSync(`${OUT_DIR}/${f}`);
  }
  const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as { assets?: Record<string, string>; sizesBytes?: Record<string, number> };
  meta.assets = { ...(meta.assets ?? {}), acts: `assets/${name}` };
  meta.sizesBytes = { ...(meta.sizesBytes ?? {}), acts: Buffer.byteLength(payload) };
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
  writeFileSync("public/assets/meta.json", JSON.stringify(meta, null, 2));
  console.log(`saved: ${OUT_DIR}/${name} (7 actos 0,I,II,III,IV,V,EPI)`);
  return name;
}

const isMain = process.argv[1]?.endsWith("15-build-acts.ts") ?? false;
if (isMain) buildActs();
