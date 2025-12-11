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
    timeWindowHours: 48, // Increased to 48h for more lenient filtering
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
 *  DEBUG FLAGS - Set these to true to bypass strict filters
 *  ============================================= */
const DEBUG_MODE = process.env.DEBUG === 'true' || false;
const BYPASS_GPT = process.env.BYPASS_GPT === 'true' || false;
const BYPASS_DEDUPE = process.env.BYPASS_DEDUPE === 'true' || false;

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
  console.log(`📊 DEBUG_MODE: ${DEBUG_MODE}, BYPASS_GPT: ${BYPASS_GPT}, BYPASS_DEDUPE: ${BYPASS_DEDUPE}`);
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
 *  RSS Feed Integration with Enhanced Debugging
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
  
  // In debug mode, show feed breakdown
  if (DEBUG_MODE) {
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        console.log(`    [DEBUG] ${CONFIG.rss.feeds[idx]}: ${r.value.length} items`);
      } else {
        console.log(`    [DEBUG] ${CONFIG.rss.feeds[idx]}: FAILED - ${r.reason.message}`);
      }
    });
  }
  
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
    
    console.log(`    ✓ Got ${data.length} bytes`);
    
    const items = [];
    // More flexible regex that handles various RSS/XML formats
    const itemMatches = data.matchAll(/<(item|entry)[^>]*>([\s\S]*?)<\/(item|entry)>/g);
    
    for (const match of itemMatches) {
      const itemContent = match[2] || match[0]; // Use captured group or full match
      
      const extractField = (regex) => {
        const fieldMatch = itemContent.match(regex);
        if (!fieldMatch) return '';
        // Try multiple capture groups for CDATA and regular content
        const content = fieldMatch[1] || fieldMatch[2] || fieldMatch[3] || '';
        return he.decode(content.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim());
      };
      
      const title = extractField(/<title>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/title>/i);
      const link = extractField(/<link>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/link>/i);
      const description = extractField(/<description>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/description>/i);
      const pubDate = extractField(/<(pubDate|published|updated)>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/\1>/i);
      
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
          date: pubDate || new Date().toISOString(), // Use current date if missing
          snippet: cleanSnippet || title,
          thumbnail,
        });
      }
    }
    
    console.log(`    ✓ Parsed ${items.length} items`);
    return items;
  } catch (err) {
    console.error(`    ❌ Failed ${feedUrl}: ${err.message}`);
    return [];
  }
}

/** =============================================
 *  Date Filter - FIXED to be more lenient
 *  ============================================= */
function withinLast24h(dateStr) {
  if (!dateStr) return DEBUG_MODE; // Accept missing dates in debug mode
  
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    const hoursDiff = (Date.now() - d.getTime()) / (1000 * 60 * 60);
    return hoursDiff <= (DEBUG_MODE ? 96 : CONFIG.filters.timeWindowHours);
  }
  
  // Try relative time
  const s = String(dateStr).toLowerCase();
  const match = s.match(/([0-9]{1,3})\s*(minute|min|ore|ora|oră|hours|hour|h|zile|zi|day|days)/);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    let hours = 0;
    if (/min/.test(unit)) hours = val / 60;
    else if (/ora|oră|ore|hour|hours|h/.test(unit)) hours = val;
    else if (/zi|zile|day/.test(unit)) hours = val * 24;
    return hours <= (DEBUG_MODE ? 96 : CONFIG.filters.timeWindowHours);
  }
  
  return DEBUG_MODE; // Accept if can't parse in debug mode
}

// ... (keep all other helper functions)

/** =============================================
 *  Entity Queries - MATCHES YOUR KIMI SESSION
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
    // YOUR NEW KEYWORDS:
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

// ... (keep all other functions)

/** =============================================
 *  Build Pipeline with Enhanced Debugging
 *  ============================================= */
async function buildData() {
  const todayKey = new Date()
    .toLocaleDateString("ro-RO", { timeZone: CONFIG.misc.timezone })
    .replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.paths.cacheDir, `report-${todayKey}.json`);

  await fs.promises.mkdir(CONFIG.paths.cacheDir, { recursive: true });
  if (fs.existsSync(cacheFile) && !DEBUG_MODE) {
    console.log("✓ Using cached report for today");
    return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  }

  console.log("\n🚀 Starting report generation...");
  console.log(`📊 DEBUG_MODE: ${DEBUG_MODE}, BYPASS_GPT: ${BYPASS_GPT}`);
  
  const pools = {};
  for (const name of ENTITY_ORDER) {
    console.log(`\n📥 Fetching: ${name}`);
    const raw = await fetchEntityPool(name);
    console.log(`   [DEBUG] ${name}: Raw items: ${raw.length}`);
    
    // Show sample items in debug mode
    if (DEBUG_MODE && raw.length > 0) {
      console.log(`   [DEBUG] ${name}: Sample items:`, raw.slice(0,2).map(i => ({
        title: i.title?.substring(0,60),
        date: i.date,
        source: i.source
      })));
    }
    
    pools[name] = raw;
  }

  console.log("\n🔍 Step 2: Filtering and deduplicating...");
  for (const name of ENTITY_ORDER) {
    const arr = (pools[name] || []).filter(x => x.title && x.link && withinLast24h(x.date));
    console.log(`   [DEBUG] ${name}: After date filter: ${arr.length}`);
    
    if (arr.length === 0) {
      console.log(`   [DEBUG] ${name}: SKIPPING - no items passed date filter`);
      continue;
    }
    
    // Show date debugging in debug mode
    if (DEBUG_MODE && arr.length > 0) {
      console.log(`   [DEBUG] ${name}: First 3 dates:`, arr.slice(0,3).map(i => 
        `${i.date} -> valid:${!isNaN(new Date(i.date).getTime())} -> within24h:${withinLast24h(i.date)}`
      ));
    }
    
    let filtered = [];
    if (name === "Local (Primării)") {
      filtered = arr.filter(looksRomanianArticle).filter(localRoleCityPass);
    } else {
      filtered = arr.filter(looksRomanianArticle);
    }
    console.log(`   [DEBUG] ${name}: After content filters: ${filtered.length}`);
    
    filtered = enforcePoliticalRules(name, filtered);
    console.log(`   [DEBUG] ${name}: After political rules: ${filtered.length}`);
    
    // Bypass GPT if flag set
    let gptFiltered = filtered;
    if (!BYPASS_GPT) {
      gptFiltered = await gptFilterForEntity(name, filtered);
      console.log(`   [DEBUG] ${name}: After GPT filter: ${gptFiltered.length}`);
    }
    
    const ded = BYPASS_DEDUPE ? gptFiltered : await dedupe(gptFiltered);
    console.log(`   [DEBUG] ${name}: After dedupe: ${ded.length}`);
    
    pools[name] = ded.slice(0, DEBUG_MODE ? 50 : CONFIG.filters.maxArticlesPerEntity);
  }

  console.log("\n🗂️  Step 3: Clustering articles...");
  const entities = [];
  for (const name of ENTITY_ORDER) {
    const items = pools[name] || [];
    if (!items.length) {
      console.log(`   [DEBUG] ${name}: SKIPPING - no items to cluster`);
      continue;
    }

    console.log(`   [DEBUG] ${name}: Processing ${items.length} items`);
    const clusters = await bunchForEntity(name, items);
    console.log(`   [DEBUG] ${name}: Created ${clusters.length} clusters`);
    
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
      console.log(`   [DEBUG] ${name}: Cluster ${idx + 1}: ${subset.length} articles`);
    }
    
    if (subjects.length > 0) {
      entities.push({ name, subjects });
      console.log(`   [DEBUG] ${name}: Added ${subjects.length} subjects`);
    }
  }

  // Add demo content if no entities found and in debug mode
  if (DEBUG_MODE && entities.length === 0) {
    console.log("\n⚠️ DEBUG_MODE: Adding demo entity since nothing else worked");
    entities.push({
      name: "Demo Debug",
      subjects: [{
        label: "Demo Subject",
        titlu_ro: "Demo: Verificare Sistem",
        sumar_ro: "Acest subiect apare deoarece nu s-a găsit conținut real. Setați DEBUG=false pentru producție.",
        items: [{
          title: "Articol Demo 1",
          link: "https://example.com/demo1",
          source: "demo.ro",
          date: new Date().toISOString(),
          snippet: "Acesta este un articol demonstrativ.",
          thumbnail: null
        }],
        thumbnail: null,
        thumbnailSource: ''
      }]
    });
  }

  console.log("\n🔧 Step 4: Post-processing...");
  crossEntityCollapseURLUnion(entities);
  await crossEntityGPTCollapse(entities);

  entities.sort((a, b) => ENTITY_PRIORITY.indexOf(a.name) - ENTITY_PRIORITY.indexOf(b.name));

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

  await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
  await fs.promises.writeFile(OUT_JSON, JSON.stringify(report, null, 2));
  await fs.promises.writeFile(LOGS_JSON, JSON.stringify({ ...report, entities: report.entities.map(e => ({ name: e.name, subjects: e.subjects.length })) }, null, 2));
  if (!DEBUG_MODE) await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log("\n✅ Report generation complete!");
  console.log(`📊 Final stats: ${report.stats.totalEntities} entities, ${report.stats.totalSubjects} subjects, ${report.stats.totalArticles} articles`);

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
    
    // Final warning if no content
    if (report.stats.totalEntities === 0) {
      console.warn("\n⚠️  WARNING: No content was generated!");
      console.warn("   Run with DEBUG=true to see detailed debugging and bypass filters");
    }
    
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
