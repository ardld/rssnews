import fs from "fs";
import path from "path";
import axios from "axios";
import OpenAI from "openai";
import jw from "jaro-winkler";
import he from "he";

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
    model: "gpt-5.1",
    embeddingModel: "text-embedding-3-small",
    embeddingBatchSize: 100,
    maxTokens: 3000,
  },
  rss: {
    feeds: [
      "https://news.yam.ro/ro/rss",
      "https://hotnews.ro/c/actualitate/feed",
      "https://www.g4media.ro/feed",
      "https://libertatea.ro/feed/",
      "https://spotmedia.ro/feed",
      "https://recorder.ro/feed",
      "https://pressone.ro/api/rss",
      "https://romania.europalibera.org/api/zvo_mml-vomx-tpeukvm_"
    ]
  },
  filters: {
    embeddingSimilarity: 0.90,
    jwSimilarity: 0.92,
    maxArticlesPerEntity: 100,
    timeWindowHours: 24,
  },
  paths: {
    outDir: path.join(process.cwd(), "public"),
    cacheDir: path.join(process.cwd(), ".cache"),
  },
  misc: {
    timezone: "Europe/Bucharest",
  },
  analytics: { ga4: process.env.GA_MEASUREMENT_ID || "G-Z3SMLP8TGS" }
};

const OUT_HTML = path.join(CONFIG.paths.outDir, "index.html");
const OUT_JSON = path.join(CONFIG.paths.outDir, "data.json");
const LOGS_JSON = path.join(CONFIG.paths.outDir, "logs.json");

const openai = CONFIG.api.openaiKey ? new OpenAI({ apiKey: CONFIG.api.openaiKey }) : null;
const llmCache = new Map();

/** =============================================
 *  Rate Limiter
 *  ============================================= */
class RateLimiter {
  constructor(maxCalls, perMs) {
    this.maxCalls = maxCalls;
    this.perMs = perMs;
    this.calls = [];
  }
  async acquire() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < this.perMs);
    if (this.calls.length >= this.maxCalls) {
      const oldestCall = Math.min(...this.calls);
      const waitTime = this.perMs - (now - oldestCall);
      await new Promise((r) => setTimeout(r, waitTime));
      return this.acquire();
    }
    this.calls.push(now);
  }
}
const openaiLimiter = new RateLimiter(50, 60000);

/** =============================================
 *  Validation & Error Handling
 *  ============================================= */
function validateEnv() {
  const errors = [];
  if (!CONFIG.api.openaiKey) errors.push("OPENAI_API_KEY is required");
  if (errors.length) {
    console.error("❌ Configuration errors:", errors.join(", "));
    process.exit(1);
  }
  console.log("✓ Environment variables validated");
}

function validateArticle(item) {
  const errors = [];
  if (!item.title?.trim()) errors.push("Missing title");
  if (!item.link?.trim()) errors.push("Missing link");
  try { new URL(item.link); } catch { errors.push("Invalid URL"); }
  return { valid: errors.length === 0, errors };
}

async function withRetry(fn, maxRetries = CONFIG.api.maxRetries, delay = CONFIG.api.retryDelay) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === maxRetries - 1) throw err;
      console.warn(`⚠️  Retry ${i + 1}/${maxRetries} after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
}

/** =============================================
 *  RSS Feed Integration - SIMPLIFIED but ROBUST
 *  ============================================= */
let rssItemsCache = null;

async function fetchAllRSSFeeds() {
  if (rssItemsCache) {
    console.log("  Using cached RSS feed");
    return rssItemsCache;
  }
  
  console.log("  Fetching all RSS feeds...");
  const feedPromises = CONFIG.rss.feeds.map(url => fetchAndParseRSS(url));
  const results = await Promise.allSettled(feedPromises);
  
  const allItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(item => item.title && item.link);
  
  console.log(`  ✓ Total articles from all feeds: ${allItems.length}`);
  rssItemsCache = allItems;
  return allItems;
}

async function fetchAndParseRSS(feedUrl) {
  console.log(`  Fetching RSS: ${feedUrl}...`);
  try {
    const { data } = await withRetry(() => axios.get(feedUrl, { 
      timeout: CONFIG.api.timeout,
      headers: { 'User-Agent': 'ContextPolitBot/1.0' }
    }));
    
    const items = [];
    const itemMatches = data.matchAll(/<item>([\s\S]*?)<\/item>/g);
    
    for (const match of itemMatches) {
      const itemContent = match[1];
      
      const extractField = (regex) => {
        const fieldMatch = itemContent.match(regex);
        return fieldMatch ? he.decode(fieldMatch[1] || fieldMatch[2] || '').trim() : '';
      };
      
      const title = extractField(/<title>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/title>)/s);
      const link = extractField(/<link>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/link>)/s);
      const description = extractField(/<description>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/description>)/s);
      const pubDate = extractField(/<pubDate>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/pubDate>)/s);
      
      // Enhanced thumbnail extraction
      let thumbnail = null;
      const enclosureMatch = itemContent.match(/<enclosure\s+url=["']([^"']+)["'][^>]*type=["']image\/[^"']*["']/i);
      const mediaContentMatch = itemContent.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*medium=["']image["']/i);
      const imgInDescriptionMatch = description.match(/<img[^>]+src=["']([^"']+)["']/i);
      const ogImageMatch = itemContent.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      
      if (enclosureMatch) thumbnail = enclosureMatch[1];
      else if (mediaContentMatch) thumbnail = mediaContentMatch[1];
      else if (imgInDescriptionMatch) thumbnail = imgInDescriptionMatch[1];
      else if (ogImageMatch) thumbnail = ogImageMatch[1];
      
      // Make relative URLs absolute
      if (thumbnail && !thumbnail.startsWith('http')) {
        try {
          const baseUrl = new URL(feedUrl).origin;
          thumbnail = new URL(thumbnail, baseUrl).toString();
        } catch (e) {
          thumbnail = null;
        }
      }
      
      const cleanSnippet = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      
      if (title && link) {
        items.push({
          title,
          link: canonicalizeUrl(link),
          source: domainOf(link) || new URL(feedUrl).hostname,
          date: pubDate,
          snippet: cleanSnippet,
          thumbnail,
        });
      }
    }
    
    console.log(`    ✓ Parsed ${items.length} items`);
    return items;
  } catch (err) {
    console.error(`❌ Failed to fetch/parse ${feedUrl}:`, err.message);
    return [];
  }
}

/** =============================================
 *  Helpers
 *  ============================================= */
const now = () => new Date();

function withinLast24h(dateStr) {
  if (!dateStr) return false;
  
  // Try relative time first
  const s = String(dateStr).toLowerCase();
  const n = now().getTime();
  const rel = /([0-9]{1,3})\s*(minute|min|minut|ore|ora|oră|hours|hour|h|zile|zi|day|days)\s*(în urmă|in urma|ago)?/;
  const m = s.match(rel);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2];
    let ms = 0;
    if (/min/.test(unit)) ms = val * 60 * 1000;
    else if (/ora|oră|ore|hour|hours|h/.test(unit)) ms = val * 60 * 60 * 1000;
    else if (/zi|zile|day/.test(unit)) ms = val * 24 * 60 * 60 * 1000;
    return ms <= CONFIG.filters.timeWindowHours * 60 * 60 * 1000;
  }
  
  // FIXED: Check last 24h from now, not same calendar day
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  
  const twentyFourHoursAgo = now().getTime() - (CONFIG.filters.timeWindowHours * 60 * 60 * 1000);
  return d.getTime() >= twentyFourHoursAgo;
}

function canonicalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const bad = ["utm_", "gclid", "fbclid", "yclid", "mc_cid", "mc_eid"];
    for (const k of Array.from(url.searchParams.keys())) {
      if (bad.some((p) => k.toLowerCase().startsWith(p))) url.searchParams.delete(k);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function domainOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** =============================================
 *  Policy filters
 *  ============================================= */
const RO_SIGNALS = ["românia", "româniei", "romania", "romaniei", "bucurești", "bucuresti"];

const ROLE_WORDS = [
  "primar", "primarul", "primăria", "primaria", "consiliu local", "cl ",
  "hotărâre", "hotarare", "proiect", "buget",
  "consiliu județean", "consiliul județean", "consiliu judetean", "consiliul judetean", "cj ",
  "prefect", "prefectură", "prefectura",
];

const CITY_WORDS = [
  "sector 1", "sector 2", "sector 3", "sector 4", "sector 5", "sector 6",
  "bucurești", "bucuresti", "ilfov", "alba iulia", "arad", "pitești", "pitesti",
  // ... (keep the full list from original)
  "rădăuți", "radauti",
];

const ELECTION_WORDS = [
  "alegeri", "alegeri locale", "alegeri parlamentare", "alegeri prezidențiale",
  "candidat", "candidați", "candidatura", "campanie electorală", "vot", "urne"
];

// --- Political enforcement
const POWER_PARTIES = ["psd","pnl","udmr","usr"];
const POWER_PEOPLE = ["moșteanu", "mosteanu", "liviu-ionut mosteanu", "ionut mosteanu"];
const GOVERNMENT_ROLE_TOKENS = [
  "ministrul","ministru","ministerul","guvernul", "premier","vicepremier","secretar de stat"
];

function looksRomanianArticle(item) {
  const text = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  return RO_SIGNALS.some(signal => text.includes(signal)) || 
         text.includes('românia') || text.includes('romania') ||
         text.includes('bucurești') || text.includes('bucuresti');
}

function mentionsPowerSignals(item) {
  const t = (`${item.title || ""} ${item.snippet || ""}`)
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return POWER_PARTIES.some(p => t.includes(p)) ||
         POWER_PEOPLE.some(n => t.includes(n)) ||
         GOVERNMENT_ROLE_TOKENS.some(k => t.includes(k));
}

function enforcePoliticalRules(targetName, arr) {
  return arr.filter((it) => {
    if (targetName === "Opoziție" && mentionsPowerSignals(it)) return false;
    return true;
  });
}

function localRoleCityPass(item) {
  const text = (`${item.title || ""} ${item.snippet || ""}`)
    .toLowerCase().split(/\s+/).slice(0, 200).join(" ");
  if (ELECTION_WORDS.some(w => text.includes(w))) return false;
  return ROLE_WORDS.some(w => text.includes(w)) && CITY_WORDS.some(w => text.includes(w));
}

/** =============================================
 *  Entity Queries - WITH NEW PARLAMENT KEYWORDS
 *  ============================================= */
const ENTITY_ORDER = [
  "Președinție",
  "Guvern",
  "Parlament",
  "Coaliție (Putere)",
  "Opoziție",
  "Local (Primării)",
];

const QUERIES = {
  "Președinție": ["Nicușor Dan", "Nicusor Dan", "Administrația Prezidențială", "Administratia Prezidentiala"],
  "Guvern": [
    "Guvernul României", "Guvernul Romaniei", "Premierul României", "Premierul Romaniei",
    "prim-ministru României", "prim-ministru Romaniei", "ministerul", "ministrul", "ministra",
  ],
  "Parlament": [
    "Parlamentul României", "Parlamentul Romaniei", "Camera Deputaților", "Camera Deputatilor",
    "Senatul României", "Senatul Romaniei",
    // NEW KEYWORDS ADDED:
    "deputatul", "deputatii", "senatorii", "senatorul", "senatoarea", "deputata", "parlamentarii"
  ],
  "Coaliție (Putere)": [
    "PSD", "Partidul Social Democrat", "PNL", "Partidul Național Liberal", "Partidul National Liberal",
    "UDMR", "Uniunea Democrată Maghiară din România", "Uniunea Democrat Maghiar din Romania",
    "USR", "Uniunea Salvați România", "Uniunea Salvati Romania", "Dominic Fritz", "Cătălin Drulă", "Catalin Drula", "Bolojan",
  ],
  "Opoziție": [
    '(AUR OR Alianța pentru Unirea Românilor OR Alianta pentru Unirea Romanilor OR George Simion) -aurora -"de aur" -aurul -gold -prețul -pretul -gram -site:imobiliare.ro -site:storia.ro -site:olx.ro',
    "SOS România", "SOS Romania", "Diana Șoșoacă", "Diana Sosoaca",
    "Partidul Oamenilor Tineri", "Partidul POT", "Anamaria Gavrilă", "Anamaria Gavrila",
  ],
  "Local (Primării)": ["primar OR primăria OR consiliu județean OR CJ OR prefect"],
};

/** =============================================
 *  RSS-based News Search
 *  ============================================= */
async function serpNewsSearch(q, opts = {}) {
  console.log(`  Searching across all RSS feeds: "${q}"`);
  
  const allItems = await fetchAllRSSFeeds();
  
  const cleanQuery = q.replace(/-("[^"]+"|\S+)/g, '').replace(/\bsite:\S+/g, '').replace(/[()]/g, '').trim();
  const keywordGroups = cleanQuery.split(/\s+OR\s+/i).map(g => g.trim()).filter(Boolean);
  
  const results = allItems.filter(item => {
    const text = `${item.title} ${item.snippet}`.toLowerCase();
    return keywordGroups.some(group => {
      const terms = group.split(/\s+/).filter(Boolean);
      return terms.every(term => {
        const cleanTerm = term.replace(/"/g, '').toLowerCase();
        return text.includes(cleanTerm);
      });
    });
  });
  
  console.log(`  ✓ Found ${results.length} matches`);
  return results.slice(0, opts.num || 50);
}

async function fetchEntityPool(name) {
  const queries = QUERIES[name] || [];
  if (!queries.length) return [];
  const promises = queries.map(raw => serpNewsSearch(`site:*.ro ${raw}`, { num: 40 }));
  const results = await Promise.all(promises);
  return results.flat();
}

/** =============================================
 *  Deduplication
 *  ============================================= */
function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / Math.max(Math.sqrt(na * nb), 1e-9);
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
    const r = await openai.chat.completions.create({
      model: CONFIG.llm.model,
      messages: [
        { role: "system", content: "Răspunde DOAR cu JSON valid." },
        { role: "user", content: prompt + "\n\n" + JSON.stringify(payload, null, 2) },
      ],
    });
    const raw = r.choices?.[0]?.message?.content?.trim() || "[]";
    let groups = [];
    try { groups = JSON.parse(raw); } catch {}
    if (!Array.isArray(groups)) return items;

    const keep = new Array(sub.length).fill(true);
    for (const g of groups) {
      const arr = Array.isArray(g?.indices) ? g.indices.filter(x => Number.isInteger(x) && x >= 0 && x < sub.length) : [];
      if (arr.length <= 1) continue;
      arr.slice(1).forEach(idx => keep[idx] = false);
    }
    const collapsed = sub.filter((_, i) => keep[i]);
    return collapsed.concat(items.slice(MAX));
  } catch (err) {
    console.warn("⚠️  GPT title-merge failed:", err.message);
    return items;
  }
}

async function dedupe(items) {
  console.log(`  Starting deduplication for ${items.length} items...`);
  
  // 1) Canonical URL-based
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
  console.log(`  After URL dedup: ${list.length} items`);

  // 2) Embedding-based
  if (openai && list.length > 0) {
    try {
      const BATCH_SIZE = CONFIG.llm.embeddingBatchSize;
      const batches = [];
      for (let i = 0; i < list.length; i += BATCH_SIZE) batches.push(list.slice(i, i + BATCH_SIZE));
      const allVecs = [];
      for (const [idx, batch] of batches.entries()) {
        try {
          const texts = batch.map(x => `${x.title}\n${x.snippet || ""}`.slice(0, CONFIG.llm.maxTokens));
          await openaiLimiter.acquire();
          const { data } = await openai.embeddings.create({ model: CONFIG.llm.embeddingModel, input: texts });
          allVecs.push(...data.map(d => d.embedding));
          console.log(`  Processed embedding batch ${idx + 1}/${batches.length}`);
        } catch (err) {
          console.error(`❌ Embedding batch ${idx + 1} failed:`, err.message);
          allVecs.push(...new Array(batch.length).fill(null));
        }
      }
      const out = [];
      for (let i = 0; i < list.length; i++) {
        if (!allVecs[i]) { out.push(list[i]); continue; }
        let dup = false;
        for (let j = 0; j < out.length; j++) {
          if (!out[j]._emb) continue;
          const sim = cosine(allVecs[i], out[j]._emb);
          if (sim >= CONFIG.filters.embeddingSimilarity) { dup = true; break; }
        }
        if (!dup) out.push({ ...list[i], _emb: allVecs[i] });
      }
      list = out.map(x => { delete x._emb; return x; });
      console.log(`  After embedding dedup: ${list.length} items`);
    } catch (err) {
      console.warn("⚠️  Embedding deduplication failed, falling back to JW:", err.message);
    }
  }

  // 3) Same-domain + Jaro-Winkler title similarity
  const out2 = [];
  for (const it of list) {
    const dom = domainOf(it.link);
    const normT = (it.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    let dup = false;
    for (const ex of out2) {
      const dom2 = domainOf(ex.link);
      const normT2 = (ex.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
      if (dom === dom2 && jw(normT, normT2) > CONFIG.filters.jwSimilarity) { dup = true; break; }
    }
    if (!dup) out2.push(it);
  }
  console.log(`  After JW dedup: ${out2.length} items`);

  // 4) Optional LLM pass
  const out3 = await gptTitleMerge(out2);
  console.log(`  After LLM dedup: ${out3.length} items`);
  
  return out3;
}

/** =============================================
 *  LLM Operations with Fallbacks
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
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\[[\s\S]*\]/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return null;
}

async function gptFilterForEntity(entityName, items) {
  if (!openai || !items.length) return items;
  const cacheKey = `filter:${entityName}:${items.length}`;
  return cachedLLMCall(cacheKey, async () => {
    const slim = items.map((it, i) => ({ i, title: it.title, snippet: (it.snippet || "").slice(0, 200) }));
    const prompt = `FILTRARE ECHILIBRATĂ: Păstrează articolele relevante pentru entitatea "${entityName}" din România, dar fii flexibil.
CRITERII DE PĂSTRARE:
- Articolul menționează explicit entitatea sau persoane/instituții cheie din categorie.
- Articolul este despre acțiuni, declarații sau evenimente cu impact asupra entității.
- Articolele conexe care oferă context valoros sunt acceptabile.

CRITERII DE ELIMINARE (STRICTĂ):
- Elimină DOAR știrile EVIDENT irelevante: reclame, sport, monden, anunțuri imobiliare.
- Elimină știrile unde cuvintele cheie apar doar tangențial.

Răspunde cu un array JSON de indici ai articolelor DE PĂSTRAT. Exemplu: [0, 2, 5]`;

    try {
      await openaiLimiter.acquire();
      const r = await openai.chat.completions.create({
        model: CONFIG.llm.model,
        messages: [
          { role: "system", content: "Răspunde DOAR cu un array JSON de numere întregi." },
          { role: "user", content: `${prompt}\n\nArticole:\n${JSON.stringify(slim, null, 2)}` },
        ],
      });
      const txt = r.choices?.[0]?.message?.content?.trim() || "[]";
      const indices = extractJSONArray(txt);
      if (Array.isArray(indices)) {
        const valid = indices.filter(n => Number.isInteger(n) && n >= 0 && n < items.length);
        console.log(`  GPT filter for ${entityName}: kept ${valid.length}/${items.length}`);
        return valid.map(i => items[i]);
      }
      console.warn(`⚠️  GPT filter failed to parse, keeping all ${items.length} items`);
      return items;
    } catch (err) {
      console.error(`❌ GPT filter failed for ${entityName}:`, err.message);
      console.log(`  Fallback: keeping all ${items.length} items`);
      return items; // Fallback: keep all if GPT fails
    }
  });
}

const PROMPT_CLUSTER = `INSTRUCȚIUNE CRITICĂ: Grupează articolele pe același subiect (același eveniment/declarație/politică).
IMPORTANT: Folosește DOAR titlul și conținutul real al articolului pentru grupare. IGNORĂ sidebar, link-uri, reclame.
Elimină near-duplicate. Întoarce top 3 clustere. Răspunde STRICT JSON: [{"indices":[0,5,7]},{"indices":[2,3]}]`;

const PROMPT_TITLE_SUM = `Instrucțiune: Primești până la 5 articole (titlu, lead). Scrie un titlu RO scurt, jurnalistic și un sumar RO de max 2 propoziții, neutru și bazat pe fapte comune.

FORMAT:
TITLU_RO: <titlu scurt>
SUMAR_RO: <max 2 propoziții>`;

async function bunchForEntity(entityName, items) {
  if (!items || !items.length) return [];
  if (!openai) return fallbackClustering(items); // Fallback if no API key

  const cacheKey = `cluster:${entityName}:${items.map(it => it.link).join("|")}`;
  return cachedLLMCall(cacheKey, async () => {
    const userItems = items.map((it, i) => ({ i, title: it.title, source: it.source, link: it.link }));
    try {
      await openaiLimiter.acquire();
      const r = await openai.chat.completions.create({
        model: CONFIG.llm.model,
        messages: [
          { role: "system", content: PROMPT_CLUSTER },
          { role: "user", content: JSON.stringify({ entity: entityName, items: userItems }, null, 2) },
        ],
      });
      let parsed = [];
      try { parsed = JSON.parse(r.choices?.[0]?.message?.content || ""); } catch {}
      if (!Array.isArray(parsed)) return fallbackClustering(items);
      return parsed.slice(0, 3).map(c => ({
        label: String(c.label || `Subiect ${entityName}`),
        indices: Array.isArray(c.indices) ? c.indices.slice(0, 5) : [],
      }));
    } catch (err) {
      console.error(`❌ Clustering failed for ${entityName}:`, err.message);
      return fallbackClustering(items);
    }
  });
}

// Fallback clustering when GPT fails
function fallbackClustering(items) {
  console.log(`    FALLBACK: Creating clusters based on title similarity...`);
  const clusters = [];
  const used = new Set();
  
  for (let i = 0; i < items.length && clusters.length < 3; i++) {
    if (used.has(i)) continue;
    const baseWords = items[i].title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const cluster = [i];
    used.add(i);
    
    for (let j = i + 1; j < items.length && cluster.length < 5; j++) {
      if (used.has(j)) continue;
      const compareTitle = items[j].title.toLowerCase();
      const sharedWords = baseWords.filter(w => compareTitle.includes(w));
      if (sharedWords.length >= 2) {
        cluster.push(j);
        used.add(j);
      }
    }
    
    if (cluster.length >= 2) {
      clusters.push({
        label: items[i].title.substring(0, 60) + "...",
        indices: cluster
      });
    }
  }
  
  // If no clusters, create one with first 3 items
  if (clusters.length === 0 && items.length > 0) {
    clusters.push({
      label: "Știri de actualitate",
      indices: items.slice(0, 3).map((_, i) => i)
    });
  }
  
  console.log(`    FALLBACK: Created ${clusters.length} clusters`);
  return clusters;
}

async function titleAndSummaryFor(items) {
  if (!openai || !items.length) return { title: items[0]?.title || "", summary: "" };
  const cacheKey = `title:${items.map(it => it.link).join(",")}`;
  return cachedLLMCall(cacheKey, async () => {
    const payload = items.map(it => ({ titlu: it.title, lead: it.snippet || "" }));
    try {
      await openaiLimiter.acquire();
      const r = await openai.chat.completions.create({
        model: CONFIG.llm.model,
        messages: [
          { role: "system", content: PROMPT_TITLE_SUM },
          { role: "user", content: JSON.stringify(payload, null, 2) },
        ],
      });
      const txt = r.choices?.[0]?.message?.content || "";
      const t = /TITLU_RO:\s*([^\n]+)/m.exec(txt)?.[1]?.trim() || items[0]?.title || "";
      const s = /SUMAR_RO:\s*([\s\S]+)/m.exec(txt)?.[1]?.trim() || "";
      return { title: t, summary: s };
    } catch (err) {
      console.error("❌ Title/summary generation failed:", err.message);
      return { title: items[0]?.title || "", summary: "" };
    }
  });
}

/** =============================================
 *  Cross-entity topic collapsing
 *  ============================================= */
function itemSig(it) {
  const u = canonicalizeUrl(it.link || "");
  try {
    const { origin, pathname } = new URL(u);
    return origin + pathname;
  } catch {
    return u;
  }
}
function topicKeyFromItems(items) {
  const sigs = Array.from(new Set((items || []).map(itemSig))).sort();
  return djb2(sigs.join("|"));
}
const ENTITY_PRIORITY = [
  "Președinție", "Guvern", "Parlament", "Coaliție (Putere)", "Opoziție", "Local (Primării)"
];

function scoreOwner(allText) {
  const t = stripDiacritics(String(allText || "").toLowerCase());
  const score = (re) => (t.match(re) || []).length;
  const scores = new Map();
  scores.set("Președinție", score(/\bpresedinte|presedintie|cotroceni|nicusor\s+dan\b/g));
  scores.set("Guvern", score(/\bpremier|guvern|ministru|ministerul|ministra\b/g));
  scores.set("Parlament", score(/\bparlament|senat|camera\s+deputatilor|deputat|senator|parlamentar\b/g));
  scores.set("Coaliție (Putere)", score(/\bpsd|pnl|udmr|usr|coalit/g));
  scores.set("Opoziție", score(/\baur\b|\bsos\s+romania\b/g));
  scores.set("Local (Primării)", score(/\bprimar|primaria|consiliu\s+jude?tean|cj\b/g));

  let best = ENTITY_PRIORITY[0], bestVal = -1;
  for (const [name, val] of scores.entries()) {
    if (val > bestVal || (val === bestVal && ENTITY_PRIORITY.indexOf(name) < ENTITY_PRIORITY.indexOf(best))) {
      best = name;
      bestVal = val;
    }
  }
  return best;
}

function crossEntityCollapseURLUnion(entities) {
  const refs = [];
  entities.forEach((e, eIdx) => {
    (e.subjects || []).forEach((s, sIdx) => {
      const urls = new Set((s.items || []).map(x => itemSig(x)));
      const key = djb2(Array.from(urls).sort().join("|"));
      refs.push({ eIdx, sIdx, entity: e.name, subject: s, key, urls });
    });
  });

  const groups = new Map();
  for (const r of refs) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }

  const keys = Array.from(groups.keys());
  const parent = new Map(keys.map(k => [k, k]));
  const find = (k) => (parent.get(k) === k ? k : parent.set(k, find(parent.get(k))).get(k));
  const unite = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent.set(b, a);
  };

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const A = groups.get(keys[i])[0].urls;
      const B = groups.get(keys[j])[0].urls;
      let inter = 0;
      for (const u of A) if (B.has(u)) { inter++; if (inter >= 2) break; }
      if (inter >= 2) unite(keys[i], keys[j]);
    }
  }

  const buckets = new Map();
  for (const k of keys) {
    const root = find(k);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(...groups.get(k));
  }

  const toDelete = new Set();
  for (const [, bucket] of buckets) {
    if (bucket.length <= 1) continue;

    const aggText = bucket.map(r => {
      const s = r.subject;
      const titles = (s.items || []).map(it => it.title).join(" • ");
      return (s.titlu_ro || "") + " " + (s.sumar_ro || "") + " " + titles;
    }).join(" /// ");

    let owner = scoreOwner(aggText);
    if (!bucket.some(r => r.entity === owner)) {
      owner = ENTITY_PRIORITY.find(n => bucket.some(r => r.entity === n)) || bucket[0].entity;
    }
    const ownerRef = bucket.find(r => r.entity === owner) || bucket[0];

    const byUrl = new Map();
    for (const r of bucket) {
      for (const it of r.subject.items || []) {
        const sig = itemSig(it);
        if (!byUrl.has(sig)) byUrl.set(sig, it);
      }
    }
    const ownerSubj = entities[ownerRef.eIdx]?.subjects?.[ownerRef.sIdx];
    if (ownerSubj) ownerSubj.items = Array.from(byUrl.values()).slice(0, 5);

    for (const r of bucket) {
      if (r !== ownerRef) toDelete.add(`${r.eIdx}:${r.sIdx}`);
    }
  }

  entities.forEach((e, eIdx) => {
    const seen = new Set();
    const kept = [];
    (e.subjects || []).forEach((s, sIdx) => {
      if (toDelete.has(`${eIdx}:${sIdx}`)) return;
      const k = topicKeyFromItems(s.items || []);
      if (seen.has(k)) return;
      seen.add(k);
      kept.push(s);
    });
    e.subjects = kept;
  });

  return entities;
}

async function crossEntityGPTCollapse(entities) {
  if (!openai) return entities;

  const refs = [];
  entities.forEach((e, eIdx) => {
    (e.subjects || []).forEach((s, sIdx) => {
      const itemTitles = (s.items || []).map(it => it.title);
      const domains = (s.items || []).map(it => domainOf(it.link));
      refs.push({ eIdx, sIdx, entity: e.name, t: s.titlu_ro || s.label || "", sum: s.sumar_ro || "", items: itemTitles, domains });
    });
  });

  if (!refs.length) return entities;

  const MAX_SUBJECTS = 80;
  const sample = refs.slice(0, MAX_SUBJECTS);
  const payload = sample.map((x, i) => ({
    i, entity: x.entity, title: x.t, summary: x.sum, items: x.items.slice(0, 5), domains: Array.from(new Set(x.domains)).slice(0, 6),
  }));

  const prompt = `Primești o listă de subiecte (carduri) extrase din presă, unele repetate în entități diferite (ex: Guvern, Președinție).
Grupează DOAR acele subiecte care descriu EVIDENT același eveniment (ex: aceeași vizită, aceeași declarație, aceeași ședință).
Ignoră variații minore de titlu sau de outlet. NU uni subiecte diferite.
Returnează STRICT JSON ca o listă de obiecte: [{"indices":[0,5,8]},{"indices":[1,3]}]
Unde "indices" sunt indicii din lista de intrare (0-based).`;

  let groups = [];
  try {
    await openaiLimiter.acquire();
    const r = await openai.chat.completions.create({
      model: CONFIG.llm.model,
      messages: [
        { role: "system", content: "Răspunde DOAR cu JSON valid." },
        { role: "user", content: prompt + "\n\n" + JSON.stringify(payload, null, 2) },
      ],
    });
    const raw = r.choices?.[0]?.message?.content?.trim() || "[]";
    try { groups = JSON.parse(raw); } catch {}
  } catch (err) {
    console.warn("⚠️  crossEntityGPTCollapse failed:", err.message);
    return entities;
  }
  if (!groups.length) return entities;

  const toDelete = new Set();
  for (const g of groups) {
    const arr = Array.isArray(g?.indices) ? g.indices.filter(n => Number.isInteger(n) && n >= 0 && n < sample.length) : [];
    if (arr.length <= 1) continue;

    const bucket = arr.map(idx => sample[idx]);
    const aggText = bucket.map(b => (b.title || "") + " " + (b.summary || "") + " " + (b.items || []).join(" • ")).join(" /// ");
    let owner = scoreOwner(aggText);
    if (!bucket.some(b => b.entity === owner)) {
      owner = ENTITY_PRIORITY.find(n => bucket.some(b => b.entity === n)) || bucket[0].entity;
    }
    const ownerRef = bucket.find(b => b.entity === owner) || bucket[0];
    const ownerReal = refs.find(r => r.eIdx === ownerRef.eIdx && r.sIdx === ownerRef.sIdx);
    if (!ownerReal) continue;

    const merged = new Map();
    for (const idx of arr) {
      const ref = sample[idx];
      const real = refs.find(r => r.eIdx === ref.eIdx && r.sIdx === ref.sIdx);
      if (!real) continue;
      const subj = entities[real.eIdx]?.subjects?.[real.sIdx];
      if (!subj) continue;
      for (const it of subj.items || []) merged.set(itemSig(it), it);
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

/** =============================================
 *  HTML Generation
 *  ============================================= */
function esc(s) {
  return he.encode(String(s || ""), { useNamedReferences: true });
}

function getAnalyticsTag(id) {
  if (!id) return "";
  const safe = String(id).replace(/[^A-Za-z0-9_\-]/g, "");
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${safe}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${safe}');</script>`;
}

function getMinimalStyles() {
  return `<style>
:root{--ink:#0a0a0a;--bg:#ffffff;--muted:#4b5563;--accent:#ffd400;--max:1200px;--accent-ink:#0a0a0a}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}
.wrap{max-width:var(--max);margin:0 auto;padding:20px}

/* Entity header */
.entity{margin:24px 0 36px}
.entity__t{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:6px 10px;border:2px solid var(--ink);font:800 18px/1 Space Grotesk,Inter,sans-serif;letter-spacing:.02em;text-transform:uppercase;margin:0 0 14px}

/* Story card */
.card{border-bottom:2px solid var(--ink);padding:18px 0;margin:0 0 12px 0;position:relative}
.card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:10px;background:linear-gradient(180deg,var(--accent) 0%,var(--accent) 100%)}
.card__thumbnail{margin-bottom:12px}
.card__thumbnail img{max-width:100%;height:auto;display:block;border:2px solid var(--ink);background:#f5f5f5}
.thumbnail-source{font-size:11px;color:var(--muted);margin-top:4px;font-style:italic}
.card__t{font:800 24px/1.15 Space Grotesk,Inter,sans-serif;margin:0 0 8px;letter-spacing:-0.01em}
.sub__sum{font-size:16px;color:var(--muted);margin:8px 0 12px;line-height:1.5}
.items{margin:0;padding:0;list-style:none}
.items li{margin:6px 0;font-size:14px;line-height:1.45;display:flex;align-items:baseline;gap:8px}
.items a{color:inherit;text-decoration:none;border-bottom:2px solid rgba(10,10,10,.15);box-shadow:inset 0 -2px 0 rgba(10,10,10,.15);transition:box-shadow .15s,border-color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.items a:hover{box-shadow:inset 0 -2px 0 var(--ink);border-bottom-color:var(--ink)}
.items .src{display:inline-block;margin-left:4px;font-size:11px;padding:1px 6px;border:1.5px solid var(--ink);border-radius:999px;background:#fff;flex-shrink:0}

/* Mobile */
@media (max-width:900px){.wrap{padding:15px}.card__t{font-size:20px}.entity__t{font-size:16px}}
@media (max-width:600px){.card__t{font-size:18px;line-height:1.2}.items li{flex-direction:column;align-items:flex-start;gap:4px}.items .src{margin-left:0;margin-top:2px}}
</style>`;
}

function baseHTML({ report }) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", {
    timeZone: CONFIG.misc.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });

  const contentHtml = generateContentHTML(report, when);
  const sourceFooter = generateSourceFooter();

  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>CONTEXTPOLITIC.ro — ${esc(when)}</title>
${getAnalyticsTag(CONFIG.analytics.ga4)}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
${getMinimalStyles()}
</head>
<body>
<main class="wrap">
  <div class="content">${contentHtml}</div>
  ${sourceFooter}
</main>
</body>
</html>`;
}

function generateContentHTML(report, when) {
  const entities = report.entities || [];
  
  if (!entities.length) {
    return `<div style="padding:20px;background:#f8d7da;border:2px solid #dc3545;margin:20px 0;">
      <h2>⚠️ No content found</h2>
      <p>Possible issues:</p>
      <ol>
        <li>RSS feeds returned no articles within the time window (${CONFIG.filters.timeWindowHours}h)</li>
        <li>All feeds are unreachable (check network/errors above)</li>
        <li>Entity queries matched nothing (check QUERIES configuration)</li>
        <li>GPT filters are too restrictive</li>
      </ol>
      <p><strong>Debug:</strong> Check logs above for "✓ Got X items" messages</p>
    </div>`;
  }
  
  return entities.map(e => {
    const subs = e.subjects || [];
    if (!subs.length) return '';
    
    const cards = subs.map(s => {
      const items = (s.items || []).slice(0, 5).map(it => 
        `<li>
          <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
          <span class="src">${esc(domainOf(it.link))}</span>
        </li>`
      ).join('');
      
      const sum = s.sumar_ro ? `<p class="sub__sum">${esc(s.sumar_ro)}</p>` : '';
      
      const thumbnailHtml = s.thumbnail ? 
        `<div class="card__thumbnail">
           <img src="${esc(s.thumbnail)}" alt="Thumbnail" loading="lazy">
           <p class="thumbnail-source">sursa: ${esc(s.thumbnailSource || '')}</p>
         </div>` : '';
      
      return `
        <div class="card">
          ${thumbnailHtml}
          <div class="card__body">
            <h3 class="card__t">${esc(s.titlu_ro || s.label || 'Subiect')}</h3>
            ${sum}
            <ul class="items">${items}</ul>
          </div>
        </div>`;
    }).join('');
    
    return `
      <section class="entity">
        <h2 class="entity__t">${esc(e.name)}</h2>
        ${cards}
      </section>`;
  }).join('');
}

function generateSourceFooter() {
  const sources = CONFIG.rss.feeds.map(url => {
    try {
      const domain = new URL(url).hostname.replace('www.', '');
      const name = domain.split('.')[0];
      return { name, domain: `https://${domain}` };
    } catch {
      return null;
    }
  }).filter(Boolean);

  const sourceLinks = sources.map(s => 
    `<a href="${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.name)}</a>`
  ).join(', ');

  return `<div style="margin:40px 0 20px;padding:20px 0;border-top:2px solid var(--ink);text-align:center;font-size:13px;">
    <p><strong>Surse RSS:</strong> ${sourceLinks}</p>
  </div>`;
}

/** =============================================
 *  Build Pipeline
 *  ============================================= */
async function buildData() {
  const todayKey = new Date()
    .toLocaleDateString("ro-RO", { timeZone: CONFIG.misc.timezone })
    .replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.paths.cacheDir, `report-${todayKey}.json`);

  await fs.promises.mkdir(CONFIG.paths.cacheDir, { recursive: true });
  if (fs.existsSync(cacheFile)) {
    console.log("✓ Using cached report for today");
    return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  }

  console.log("\n🚀 Starting report generation...");
  const logs = { fetched: {}, filtered: {}, gpt_filtered: {}, deduped: {}, final: {} };

  console.log("\n📡 Step 1/4: Fetching from RSS feeds...");
  const pools = {};
  for (const name of ENTITY_ORDER) {
    console.log(`  Fetching: ${name}`);
    const raw = await fetchEntityPool(name);
    logs.fetched[name] = raw;
    pools[name] = raw;
    console.log(`  ✓ ${name}: ${raw.length} articles`);
  }

  console.log("\n🔍 Step 2/4: Filtering and deduplicating...");
  for (const name of ENTITY_ORDER) {
    const arr = (pools[name] || []).filter(x => x.title && x.link && withinLast24h(x.date));
    console.log(`  ${name}: ${arr.length} items after date filter`);
    
    let filtered = [];
    if (name === "Local (Primării)") {
      filtered = arr.filter(looksRomanianArticle).filter(localRoleCityPass);
    } else {
      filtered = arr.filter(looksRomanianArticle);
    }
    console.log(`  ${name}: ${filtered.length} items after content filters`);
    
    filtered = enforcePoliticalRules(name, filtered);
    logs.filtered[name] = filtered.length;

    const gptFiltered = await gptFilterForEntity(name, filtered);
    logs.gpt_filtered[name] = gptFiltered.length;

    const ded = await dedupe(gptFiltered);
    logs.deduped[name] = ded.length;
    pools[name] = ded.slice(0, CONFIG.filters.maxArticlesPerEntity);
    console.log(`  ✓ ${name}: ${arr.length} → ${filtered.length} → ${gptFiltered.length} → ${ded.length} articles`);
  }

  console.log("\n🗂️  Step 3/4: Clustering articles...");
  const entities = [];
  for (const name of ENTITY_ORDER) {
    const items = pools[name] || [];
    if (!items.length) {
      console.log(`  ⊘ ${name}: No articles`);
      continue;
    }

    console.log(`  Processing ${name}... (${items.length} items)`);
    const clusters = await bunchForEntity(name, items);
    console.log(`    Found ${clusters.length} clusters`);

    const subjects = [];
    for (const [idx, cl] of clusters.entries()) {
      const subset = cl.indices.map(i => items[i]).filter(Boolean).slice(0, 5);
      if (!subset.length) continue;

      const { title, summary } = await titleAndSummaryFor(subset);
      
      // Pick thumbnail from first article that has one
      const thumbnailItem = subset.find(item => item.thumbnail) || subset[0];
      const thumbnail = thumbnailItem?.thumbnail || null;
      const thumbnailSource = thumbnailItem?.source || '';

      subjects.push({
        label: cl.label || title || `Subiect ${subjects.length + 1}`,
        titlu_ro: title,
        sumar_ro: summary,
        items: subset,
        thumbnail,
        thumbnailSource,
      });
      console.log(`    ✓ Cluster ${idx + 1}: ${subset.length} articles${thumbnail ? ' (with thumbnail)' : ''}`);
    }
    
    if (subjects.length > 0) {
      entities.push({ name, subjects });
      console.log(`  ✓ ${name}: ${subjects.length} subjects created`);
    }
  }

  console.log("\n🔧 Post-processing: collapsing cross-entity topics...");
  crossEntityCollapseURLUnion(entities);
  await crossEntityGPTCollapse(entities);

  entities.sort((a, b) => ENTITY_PRIORITY.indexOf(a.name) - ENTITY_PRIORITY.indexOf(b.name));

  console.log("\n💾 Step 4/4: Saving results...");
  const report = { 
    generatedAt: new Date().toISOString(), 
    timezone: CONFIG.misc.timezone, 
    entities,
    stats: {
      totalEntities: entities.length,
      totalSubjects: entities.reduce((sum, e) => sum + (e.subjects?.length || 0), 0),
      totalArticles: entities.reduce((sum, e) => sum + (e.subjects?.reduce((sSum, s) => sSum + (s.items?.length || 0), 0) || 0), 0)
    }
  };
  logs.final.report = report;

  await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
  await fs.promises.writeFile(OUT_JSON, JSON.stringify(report, null, 2));
  await fs.promises.writeFile(LOGS_JSON, JSON.stringify(logs, null, 2));
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  console.log(`  ✓ Saved to ${OUT_JSON}`);
  console.log(`  ✓ Logs saved to ${LOGS_JSON}`);
  console.log(`  ✓ Cached to ${cacheFile}`);

  console.log("\n✅ Report generation complete!");
  console.log(`📊 Stats: ${report.stats.totalEntities} entities, ${report.stats.totalSubjects} subjects, ${report.stats.totalArticles} articles`);
  
  return report;
}

/** =============================================
 *  Main
 *  ============================================= */
async function run() {
  try {
    validateEnv();
    const report = await buildData();
    
    // Generate HTML
    const html = baseHTML({ report });
    await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
    await fs.promises.writeFile(OUT_HTML, html, "utf-8");
    
    console.log(`\n✅ SUCCESS: ${OUT_HTML} written (${html.length} bytes)`);
    console.log(`📊 Content: ${report.stats.totalEntities} sections, ${report.stats.totalSubjects} stories, ${report.stats.totalArticles} articles`);
    
  } catch (err) {
    console.error("\n❌ FATAL ERROR:", err.message);
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
