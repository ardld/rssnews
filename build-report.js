import fs from "fs";
import path from "path";
import OpenAI from "openai";
import jw from "jaro-winkler";
import he from "he";
import Parser from "rss-parser";

/** =============================================
 *  Configuration
 *  ============================================= */
const CONFIG = {
  api: {
    openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
    timeout: 20000,
    maxRetries: 3,
    retryDelay: 1000,
  },
  llm: {
    model: "gpt-5.2", // ← CHANGED from "gpt-5.1"
    embeddingModel: "text-embedding-3-small",
    embeddingBatchSize: 100,
    maxTokens: 3000,
    reasoning: {
      effort: "medium", // ← ADDED: moderate thinking level
    },
    text: {
      verbosity: "medium", // ← ADDED: control output length
    },
  },
  // ... rest of config unchanged
};

const OUT_HTML = path.join(CONFIG.paths.outDir, "index.html");
const OUT_JSON = path.join(CONFIG.paths.outDir, "data.json");
const LOGS_JSON = path.join(CONFIG.paths.outDir, "logs.json");

const openai = CONFIG.api.openaiKey ? new OpenAI({ apiKey: CONFIG.api.openaiKey }) : null;
const llmCache = new Map();
const rssParser = new Parser();

// ... Rate Limiter, Validation & Error Handling, Helper functions unchanged ...

/** =============================================
 *  LLM Operations (UPDATED for GPT-5.2 Responses API)
 *  ============================================= */
async function cachedLLMCall(key, fn) {
  if (llmCache.has(key)) {
    console.log(`  Using cached LLM response for: ${key.slice(0, 50)}...`);
    return llmCache.get(key);
  }
  const result = await fn();
  llmCache.set(key, result);
  return result;
}

function extractJSONArray(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }
  return null;
}

async function gptTitleMerge(items) {
  if (!openai) return items;
  const MAX = 60;
  const sub = items.slice(0, MAX);
  const payload = sub.map((it, i) => ({ i, title: it.title, url: it.link }));
  const prompt = `Primești o listă de titluri de știri românești din ultimele 24h.
Identifică grupuri de titluri care descriu ACELAȘI SUBIECT (aceeași știre), chiar dacă formulările diferă.
Criterii:
- Sinonimie clară, mici variații, publicări în lanț (aceeași informație).
- Ignoră diferențe minore de timp sau stil.
- NU grupa titluri dacă sunt despre episoade DISTINCTE.

Răspunde STRICT JSON ca listă de obiecte: [{"indices":[0,5,7]},{"indices":[2,3]}]. Fără alt text.`;

  try {
    await openaiLimiter.acquire();
    // ← CHANGED: Using Responses API with reasoning.medium and low verbosity for JSON
    const r = await openai.responses.create({
      model: CONFIG.llm.model,
      input: prompt + "\n\n" + JSON.stringify(payload, null, 2),
      reasoning: { effort: CONFIG.llm.reasoning.effort },
      text: { verbosity: "low" }, // Low verbosity for structured JSON output
    });
    // ← CHANGED: Response parsing for Responses API
    const raw = r.output || "[]";
    let groups = [];
    try {
      groups = JSON.parse(raw);
      if (!Array.isArray(groups)) groups = [];
    } catch {
      groups = [];
    }
    if (!groups.length) return items;

    const keep = new Array(sub.length).fill(true);
    for (const g of groups) {
      const arr = Array.isArray(g?.indices) ? g.indices.filter((x) => Number.isInteger(x) && x >= 0 && x < sub.length) : [];
      if (arr.length <= 1) continue;
      arr.slice(1).forEach((idx) => (keep[idx] = false));
    }
    const collapsed = sub.filter((_, i) => keep[i]);
    return collapsed.concat(items.slice(MAX));
  } catch (err) {
    console.warn("⚠️  GPT title-merge failed:", err.message);
    return items;
  }
}

async function dedupe(items) {
  const byCanon = new Map();
  for (const it of items) {
    const validation = validateArticle(it);
    if (!validation.valid) {
      console.warn("⚠️  Invalid article:", validation.errors.join(", "));
      continue;
    }
    const k = canonicalizeUrl(it.link || "");
    if (!byCanon.has(k)) byCanon.set(k, it);
  }
  let list = Array.from(byCanon.values());

  if (openai && list.length > 0) {
    try {
      const BATCH_SIZE = CONFIG.llm.embeddingBatchSize;
      const batches = [];
      for (let i = 0; i < list.length; i += BATCH_SIZE) batches.push(list.slice(i, i + BATCH_SIZE));
      const allVecs = [];
      for (const [idx, batch] of batches.entries()) {
        try {
          const texts = batch.map((x) => `${x.title}\n${x.snippet || ""}`.slice(0, CONFIG.llm.maxTokens));
          await openaiLimiter.acquire();
          const { data } = await openai.embeddings.create({ model: CONFIG.llm.embeddingModel, input: texts });
          allVecs.push(...data.map((d) => d.embedding));
          console.log(`  Processed embedding batch ${idx + 1}/${batches.length}`);
        } catch (err) {
          console.error(`❌ Embedding batch ${idx + 1} failed:`, err.message);
          allVecs.push(...new Array(batch.length).fill(null));
        }
      }
      const out = [];
      for (let i = 0; i < list.length; i++) {
        if (!allVecs[i]) {
          out.push(list[i]);
          continue;
        }
        let dup = false;
        for (let j = 0; j < out.length; j++) {
          if (!out[j]._emb) continue;
          const sim = cosine(allVecs[i], out[j]._emb);
          if (sim >= CONFIG.filters.embeddingSimilarity) {
            dup = true;
            break;
          }
        }
        if (!dup) {
          const e = { ...list[i], _emb: allVecs[i] };
          out.push(e);
        }
      }
      list = out.map((x) => {
        delete x._emb;
        return x;
      });
    } catch (err) {
      console.warn("⚠️  Embedding deduplication failed, falling back to JW:", err.message);
    }
  }

  const out2 = [];
  for (const it of list) {
    const dom = domainOf(it.link);
    const normT = (it.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    let dup = false;
    for (const ex of out2) {
      const dom2 = domainOf(ex.link);
      const normT2 = (ex.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
      if (dom === dom2 && jw(normT, normT2) > CONFIG.filters.jwSimilarity) {
        dup = true;
        break;
      }
    }
    if (!dup) out2.push(it);
  }

  const out3 = await gptTitleMerge(out2);
  return out3;
}

async function gptFilterForEntity(entityName, items) {
  if (!openai || !items.length) return items;
  const cacheKey = `filter:${entityName}:${items.length}`;
  return cachedLLMCall(cacheKey, async () => {
    const slim = items.map((it, i) => ({ i, title: it.title, snippet: (it.snippet || "").slice(0, 200) }));
    const prompt = `FILTRARE ECHILIBRATĂ: Păstrează articolele relevante pentru entitatea "${entityName}" din România. 

CRITERII DE PĂSTRARE:
- Articolul menționează explicit entitatea sau persoane/instituții cheie din categorie.
- Articolul este despre acțiuni, declarații sau evenimente cu impact asupra entității.

CRITERII DE ELIMINARE (STRICTĂ):
- Elimină DOAR știrile EVIDENT irelevante: reclame, sport, monden, anunțuri imobiliare, sau știri despre alte localități fără legătură.
- Elimină știrile unde cuvintele cheie apar doar tangențial, fără substanță.

Răspunde cu un array JSON de indici ai articolelor DE PĂSTRAT. Exemplu: [0, 2, 5, 8]`;

    try {
      await openaiLimiter.acquire();
      // ← CHANGED: Using Responses API with reasoning.medium and low verbosity for JSON
      const r = await openai.responses.create({
        model: CONFIG.llm.model,
        input: prompt + "\n\nArticole:\n" + JSON.stringify(slim, null, 2),
        reasoning: { effort: CONFIG.llm.reasoning.effort },
        text: { verbosity: "low" },
      });
      // ← CHANGED: Response parsing for Responses API
      const txt = r.output || "[]";
      const indices = extractJSONArray(txt);
      if (Array.isArray(indices)) {
        const valid = indices.filter((n) => Number.isInteger(n) && n >= 0 && n < items.length);
        console.log(`  GPT filter for ${entityName}: kept ${valid.length}/${items.length}`);
        return valid.map((i) => items[i]);
      }
      console.warn(`⚠️  GPT filter failed to parse for ${entityName}, keeping all`);
      return items;
    } catch (err) {
      console.error(`❌ GPT filter failed for ${entityName}:`, err.message);
      return items;
    }
  });
}

const PROMPT_CLUSTER = `INSTRUCȚIUNE CRITICĂ: Grupează articolele pe același subiect (același eveniment/declarație/politică).

IMPORTANT: Folosește DOAR titlul și conținutul real al articolului pentru grupare. IGNORĂ complet:
- Titluri de articole similare din sidebar
- Link-uri către alte articole
- Secțiuni "Citește și" sau "Vezi și"
- Reclame sau conținut promovat
- Orice alt zgomot HTML din pagină

Concentrează-te doar pe conținutul articolului principal. Este despre același om, acțiune sau lucru?

Elimină near-duplicate. Întoarce top 3 clustere după diversitate outlet-uri și recență. Pentru fiecare cluster, selectează ≤5 itemi pe acela;i subiect. Răspunde STRICT în JSON, ca o listă de obiecte { "label": string, "indices": number[] } fără alt text.`;

const PROMPT_TITLE_SUM = `Instrucțiune: Primești până la 5 articole (titlu, lead, fragment). Scrie un titlu RO scurt, jurnalistic (nu copia niciun headline) și un sumar RO de cel mult 2 propoziții scurte, neutru și bazat pe fapte comune între surse (fără speculații).

IMPORTANT: Folosește doar conținutul real al articolelor. Ignoră link-uri externe sau zgomot HTML.

FORMAT STRICT:

TITLU_RO: <titlu jurnalistic scurt>
SUMAR_RO: <max 2 propoziții scurte>`;

async function bunchForEntity(entityName, items) {
  if (!items || !items.length) return [];
  if (!openai) return [];

  const cacheKey = `cluster:${entityName}:${items.map((it) => it.link).join("|")}`;
  return cachedLLMCall(cacheKey, async () => {
    const userItems = items.map((it, i) => ({
      i,
      title: it.title,
      source: it.source,
      link: it.link,
      date: it.date,
    }));
    try {
      await openaiLimiter.acquire();
      // ← CHANGED: Using Responses API with reasoning.medium and low verbosity for JSON
      const r = await openai.responses.create({
        model: CONFIG.llm.model,
        input: PROMPT_CLUSTER + "\n\n" + JSON.stringify({ entity: entityName, items: userItems }, null, 2),
        reasoning: { effort: CONFIG.llm.reasoning.effort },
        text: { verbosity: "low" },
      });
      // ← CHANGED: Response parsing for Responses API
      let parsed = [];
      try {
        parsed = JSON.parse(r.output || "");
      } catch (e) {
        console.warn(`⚠️  Failed to parse cluster JSON for ${entityName}:`, e.message);
        parsed = [];
      }
      if (!Array.isArray(parsed)) parsed = [];
      return parsed.slice(0, 3).map((c) => ({
        label: String(c.label || `Subiect ${entityName}`),
        indices: Array.isArray(c.indices) ? c.indices.slice(0, 5) : [],
      }));
    } catch (err) {
      console.error(`❌ Clustering failed for ${entityName}:`, err.message);
      return [];
    }
  });
}

async function titleAndSummaryFor(items) {
  if (!openai || !items.length) return { title: "", summary: "" };
  const cacheKey = `title:${items.map((it) => it.link).join(",")}`;
  return cachedLLMCall(cacheKey, async () => {
    const payload = items.map((it) => ({
      titlu: it.title,
      lead: it.snippet || "",
      fragment: it.snippet || "",
    }));
    try {
      await openaiLimiter.acquire();
      // ← CHANGED: Using Responses API with reasoning.medium and medium verbosity for text
      const r = await openai.responses.create({
        model: CONFIG.llm.model,
        input: PROMPT_TITLE_SUM + "\n\n" + JSON.stringify(payload, null, 2),
        reasoning: { effort: CONFIG.llm.reasoning.effort },
        text: { verbosity: "medium" }, // Medium verbosity for balanced text generation
      });
      // ← CHANGED: Response parsing for Responses API
      const txt = r.output || "";
      const t = /TITLU_RO:\s*([^\n]+)/m.exec(txt)?.[1]?.trim() || "";
      const s = /SUMAR_RO:\s*([\s\S]+)/m.exec(txt)?.[1]?.trim() || "";
      return { title: t, summary: s };
    } catch (err) {
      console.error("❌ Title/summary generation failed:", err.message);
      return { title: "", summary: "" };
    }
  });
}

// ... crossEntityCollapseURLUnion, scoreOwner functions unchanged ...

async function crossEntityGPTCollapse(entities) {
  if (!openai) return entities;

  const refs = [];
  entities.forEach((e, eIdx) => {
    (e.subjects || []).forEach((s, sIdx) => {
      const itemTitles = (s.items || []).map((it) => it.title);
      const domains = (s.items || []).map((it) => domainOf(it.link));
      refs.push({
        eIdx,
        sIdx,
        entity: e.name,
        t: s.titlu_ro || s.label || "",
        sum: s.sumar_ro || "",
        items: itemTitles,
        domains,
      });
    });
  });

  if (!refs.length) return entities;

  const MAX_SUBJECTS = 80;
  const sample = refs.slice(0, MAX_SUBJECTS);
  const payload = sample.map((x, i) => ({
    i,
    entity: x.entity,
    title: x.t,
    summary: x.sum,
    items: x.items.slice(0, 5),
    domains: Array.from(new Set(x.domains)).slice(0, 6),
  }));

  const prompt = `Primești o listă de subiecte (carduri) extrase din presă, unele repetate în entități diferite (ex: Guvern, Președinție).
Grupează DOAR acele subiecte care descriu EVIDENT același eveniment (ex: aceeași vizită, aceeași declarație, aceeași ședință).
Ignoră variații minore de titlu sau de outlet. NU uni subiecte diferite.

Returnează STRICT JSON ca o listă de obiecte:
[{"indices":[0,5,8]},{"indices":[1,3]}]

Unde "indices" sunt indicii din lista de intrare (0-based). Nu include motive sau text suplimentar.`;

  let groups = [];
  try {
    await openaiLimiter.acquire();
    // ← CHANGED: Using Responses API with reasoning.medium and low verbosity for JSON
    const r = await openai.responses.create({
      model: CONFIG.llm.model,
      input: prompt + "\n\n" + JSON.stringify(payload, null, 2),
      reasoning: { effort: CONFIG.llm.reasoning.effort },
      text: { verbosity: "low" },
    });
    // ← CHANGED: Response parsing for Responses API
    const raw = r.output || "[]";
    try {
      groups = JSON.parse(raw);
      if (!Array.isArray(groups)) groups = [];
    } catch {
      groups = [];
    }
  } catch (err) {
    console.warn("⚠️  crossEntityGPTCollapse failed:", err.message);
    return entities;
  }
  if (!groups.length) return entities;

  // ... rest of logic unchanged ...
  const toDelete = new Set();
  for (const g of groups) {
    const arr = Array.isArray(g?.indices) ? g.indices.filter((n) => Number.isInteger(n) && n >= 0 && n < sample.length) : [];
    if (arr.length <= 1) continue;

    const bucket = arr.map((idx) => sample[idx]);
    const aggText = bucket
      .map((b) => (b.title || "") + " " + (b.summary || "") + " " + (b.items || []).join(" • "))
      .join(" /// ");
    let owner = scoreOwner(aggText);
    if (!bucket.some((b) => b.entity === owner)) {
      owner = ENTITY_PRIORITY.find((n) => bucket.some((b) => b.entity === n)) || bucket[0].entity;
    }
    const ownerRef = bucket.find((b) => b.entity === owner) || bucket[0];

    const ownerReal = refs.find((r) => r.eIdx === ownerRef.eIdx && r.sIdx === ownerRef.sIdx);
    if (!ownerReal) continue;

    const merged = new Map();
    for (const idx of arr) {
      const ref = sample[idx];
      const real = refs.find((r) => r.eIdx === ref.eIdx && r.sIdx === ref.sIdx);
      if (!real) continue;
      const subj = entities[real.eIdx]?.subjects?.[real.sIdx];
      if (!subj) continue;
      for (const it of subj.items || []) {
        merged.set(itemSig(it), it);
      }
    }
    const ownerSubj = entities[ownerReal.eIdx]?.subjects?.[ownerReal.sIdx];
    if (ownerSubj) ownerSubj.items = Array.from(merged.values()).slice(0, 5);

    for (const idx of arr) {
      const ref = sample[idx];
      if (ref.eIdx === ownerReal.eIdx && ref.sIdx === ownerReal.sIdx) continue;
      toDelete.add(`${ref.eIdx}:${ref.sIdx}`);
    }
  }

  entities.forEach((e, eIdx) => {
    const kept = [];
    (e.subjects || []).forEach((s, sIdx) => {
      if (toDelete.has(`${eIdx}:${sIdx}`)) return;
      kept.push(s);
    });
    e.subjects = kept;
  });

  return entities;
}

// ... Build Pipeline, HTML Generation, Main function unchanged ...

/** =============================================
 *  Main
 *  ============================================= */
async function run() {
  try {
    validateEnv();
    const report = await buildData();
    const html = baseHTML({ report });
    await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
    await fs.promises.writeFile(OUT_HTML, html, "utf-8");
    console.log(`\n✅ Successfully wrote: ${OUT_HTML}`);
    console.log(`📊 Report statistics:`);
    console.log(`   - Total entities: ${report.entities.length}`);
    console.log(`   - Total subjects: ${report.entities.reduce((sum, e) => sum + e.subjects.length, 0)}`);
    console.log(
      `   - Total articles: ${report.entities.reduce((sum, e) => sum + e.subjects.reduce((s, sub) => s + sub.items.length, 0), 0)}`
    );
  } catch (err) {
    console.error("\n❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });
}
