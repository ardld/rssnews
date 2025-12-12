import fs from "fs";
import path from "path";
import OpenAI from "openai";
import he from "he";
import Parser from "rss-parser";

/** Configuration */
const CONFIG = {
  openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  model: "gpt-5.1",
  outDir: path.join(process.cwd(), "public"),
  cacheDir: path.join(process.cwd(), ".cache"),
  timezone: "Europe/Bucharest",
  feeds: [
    "https://www.biziday.ro/feed/",
    "https://b365.ro/feed/",
    "https://www.digi24.ro/rss",
    "https://hotnews.ro/c/actualitate/feed",
    "https://www.g4media.ro/feed",
    "https://libertatea.ro/feed/",
    "https://spotmedia.ro/feed",
    "https://recorder.ro/feed",
    "https://pressone.ro/api/rss",
    "https://romania.europalibera.org/api/zvo_mml-vomx_-tpeukvm_",
    "https://adevarul.ro/rss/index",
  ],
  // Source credibility (higher = more trustworthy)
  sourceCredibility: {
    "recorder.ro": 1.0,
    "pressone.ro": 1.0,
    "g4media.ro": 0.9,
    "hotnews.ro": 0.9,
    "adevarul.ro": 0.8,
    "digi24.ro": 0.8,
    "libertatea.ro": 0.7,
    "spotmedia.ro": 0.8,
    "biziday.ro": 0.7,
    "b365.ro": 0.6,
    "europalibera.org": 0.9,
  },
};

const openai = new OpenAI({ apiKey: CONFIG.openaiKey });
const parser = new Parser();

/** Entity definitions */
const ENTITIES = [
  "Președinție",
  "Guvern",
  "Parlament",
  "Coaliție (Putere)",
  "Opoziție",
  "Local (Primării)",
];

const QUERIES = {
  "Președinție": [
    "Nicușor Dan", 
    "Nicusor Dan", 
    "Administrația Prezidențială", 
    "Administratia Prezidentiala"
  ],
  "Guvern": [
    "Guvernul României",
    "Guvernul Romaniei",
    "Premierul României",
    "Premierul Romaniei",
    "prim-ministru României",
    "prim-ministru Romaniei",
    "ministerul",
    "ministrul",
    "ministra",
    "guvernul",
    "Bolojan",
  ],
  "Parlament": [
    "Parlamentul României",
    "Parlamentul Romaniei",
    "Camera Deputaților",
    "Camera Deputatilor",
    "Senatul României",
    "Senatul Romaniei",
    "deputatul",
    "senatorul",
    "senatoarea",
    "deputații",
    "senatorii",
    "votul din plen",
  ],
  "Coaliție (Putere)": [
    "PSD",
    "Partidul Social Democrat",
    "PNL",
    "Partidul Național Liberal",
    "Partidul National Liberal",
    "UDMR",
    "Uniunea Democrată Maghiară din România",
    "Uniunea Democrat Maghiar din Romania",
    "USR",
    "Uniunea Salvați România",
    "Uniunea Salvati Romania",
  ],
  "Opoziție": [
    "AUR",
    "Alianța pentru Unirea Românilor",
    "Alianta pentru Unirea Romanilor",
    "George Simion",
    "SOS România",
    "SOS Romania",
    "Diana Șoșoacă",
    "Diana Sosoaca",
    "Partidul Oamenilor Tineri",
    "Partidul POT",
    "Anamaria Gavrilă",
    "Anamaria Gavrila",
  ],
  "Local (Primării)": [
    "primar",
    "primăria",
    "primaria",
    "primarul"
  ],
};

/** Helper functions */
const canonicalizeUrl = (url) => {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_", "gclid", "fbclid"].forEach(p => {
      Array.from(u.searchParams.keys()).forEach(k => {
        if (k.toLowerCase().startsWith(p)) u.searchParams.delete(k);
      });
    });
    return u.toString();
  } catch {
    return url;
  }
};

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const withinLast24h = (dateStr) => {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  return Date.now() - d.getTime() <= 24 * 60 * 60 * 1000;
};

/** Fetch RSS feeds */
async function fetchRSS() {
  console.log("📡 Fetching RSS feeds...");
  const articles = [];
  
  for (const feedUrl of CONFIG.feeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      feed.items.forEach(item => {
        articles.push({
          title: item.title || "",
          link: canonicalizeUrl(item.link || ""),
          source: item.creator || feed.title || domainOf(feedUrl),
          date: item.pubDate || item.isoDate || "",
          snippet: item.contentSnippet || item.content || "",
          thumbnail: item.enclosure?.url || "",
        });
      });
      console.log(`  ✓ ${feed.title}: ${feed.items.length} articles`);
    } catch (err) {
      console.error(`  ⚠️  Failed: ${feedUrl}`);
    }
  }
  
  // Enrich articles with metadata
  const enriched = await Promise.all(articles.map(enrichArticle));
  
  // Calculate viral scores
  const withViral = calculateViralScores(enriched);
  
  // Filter out low-quality/disinformation (but only for LOW credibility sources)
  return withViral.filter(a => {
    // Only apply disinfo filter to sources with credibility < 0.9
    if (a.hasDisinfo && a.credibility < 0.9) {
      console.log(`  ⚠️  Filtered disinfo: ${a.title.slice(0, 60)}...`);
      return false;
    }
    return true;
  });
}

/** Calculate article credibility score */
function getCredibilityScore(article) {
  const domain = domainOf(article.link);
  return CONFIG.sourceCredibility[domain] || 0.5;
}

/** Detect disinformation signals */
const DISINFO_SIGNALS = [
  "fake news", "mainstream media", "globaliști", "globalisti",
  "deep state", "elita", "tradatori", "trădători",
  "soroș", "soros", "bill gates", "klaus schwab",
  "masonii", "mason", "iluminati", "illuminati",
  "dacii", "daci liberi", "imperiu colonial",
  "schengen e o conspirație", "ne vând țara",
];

function hasDisinfoSignals(text) {
  const lower = text.toLowerCase();
  return DISINFO_SIGNALS.some(sig => lower.includes(sig));
}

/** Enhanced article validation */
async function enrichArticle(article) {
  const credibility = getCredibilityScore(article);
  const hasDisinfo = hasDisinfoSignals(`${article.title} ${article.snippet}`);
  
  return {
    ...article,
    credibility,
    hasDisinfo,
  };
}

/** Calculate viral score (how many sources cover the same story) */
function calculateViralScores(articles) {
  // Group articles by similarity (simplified: same key terms in title)
  const storyGroups = new Map();
  
  articles.forEach(article => {
    const words = article.title
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 4); // Only significant words
    
    const key = words.slice(0, 3).sort().join('_'); // First 3 significant words
    
    if (!storyGroups.has(key)) {
      storyGroups.set(key, []);
    }
    storyGroups.get(key).push(article);
  });
  
  // Assign viral scores based on how many different sources cover it
  articles.forEach(article => {
    const words = article.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const key = words.slice(0, 3).sort().join('_');
    const group = storyGroups.get(key) || [];
    const uniqueSources = new Set(group.map(a => domainOf(a.link))).size;
    
    // Viral if 3+ different sources cover it
    article.viralScore = uniqueSources;
    article.isViral = uniqueSources >= 3;
  });
  
  return articles;
}
const ROMANIA_SIGNALS = [
  "românia", "romania", "românesc", "romanesc", "bucuresti", "bucurești",
  "cluj", "timișoara", "timisoara", "iași", "iasi", "constanța", "constanta",
  "brașov", "brasov", "sibiu", "craiova", "galați", "galati", "ploiești", "ploiesti"
];

const IRRELEVANT_SIGNALS = [
  "budapesta", "budapest", "ungaria", "maghiar", "orban",
  "venezuela", "machado", "oslo", "veneția", "rialto",
  "tezaur", "colosseum mall", "inaugurare", "oferte speciale",
  "edituri", "manuale", "academiei române", "ioan-aurel pop"
];

function isAboutRomania(article) {
  const text = `${article.title} ${article.snippet}`.toLowerCase();
  
  // Reject clearly irrelevant
  if (IRRELEVANT_SIGNALS.some(sig => text.includes(sig))) {
    return false;
  }
  
  // Must have Romania signal
  return ROMANIA_SIGNALS.some(sig => text.includes(sig));
}

/** Filter articles by keywords */
function filterByKeywords(articles, entityName) {
  const keywords = QUERIES[entityName] || [];
  return articles
    .filter(isAboutRomania)
    .filter(article => {
      const text = `${article.title} ${article.snippet}`.toLowerCase();
      return keywords.some(kw => text.includes(kw.toLowerCase()));
    });
}

/** Deduplicate by URL */
function deduplicateByUrl(articles) {
  const seen = new Map();
  articles.forEach(article => {
    const url = canonicalizeUrl(article.link);
    if (!seen.has(url)) seen.set(url, article);
  });
  return Array.from(seen.values());
}

/** GPT-5.1: Cluster articles into topics */
async function clusterArticles(entityName, articles) {
  if (!articles.length) return [];
  
  const payload = articles.slice(0, 50).map((a, i) => ({
    i,
    title: a.title,
    source: a.source,
  }));
  
  const prompt = `Grupează aceste articole românești în maximum 3 subiecte principale (topic-uri).
Pentru fiecare subiect, selectează până la 5 articole relevante.

Returnează JSON strict în acest format:
[
  {"label": "Titlu subiect 1", "indices": [0, 3, 5]},
  {"label": "Titlu subiect 2", "indices": [1, 4, 7]}
]

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Răspunde DOAR cu JSON valid." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content.trim();
    const clusters = JSON.parse(content);
    
    return Array.isArray(clusters) ? clusters.slice(0, 3) : [];
  } catch (err) {
    console.error(`  ⚠️  Clustering failed for ${entityName}:`, err.message);
    return [];
  }
}

/** GPT-5.1: Generate title, summary, and context */
async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "", context: "", sentiment: "neutral" };
  
  // Sort by credibility for better summarization
  const sorted = articles.sort((a, b) => (b.credibility || 0.5) - (a.credibility || 0.5));
  
  const payload = sorted.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 200),
    source: a.source,
    credibility: a.credibility,
  }));
  
  const prompt = `Analizează aceste articole românești și creează:

1. TITLU: Un titlu scurt și jurnalistic (maxim 12 cuvinte)
2. SUMAR: Un sumar obiectiv de maxim 2 propoziții
3. CONTEXT: O propoziție de context dacă e necesar (de ex: "Vine după..." sau "În contextul...")
4. SENTIMENT: Tonul general (pozitiv/negativ/neutru/controversat)
5. VERIFICARE: Notează dacă există afirmații neconfirmate sau contradictorii între surse

IMPORTANT: 
- Folosește sursele cu credibilitate mai mare (Recorder, Pressone, G4Media)
- Dacă sursele spun lucruri diferite, menționează-o
- Evită speculații

Format răspuns:
TITLU: <titlu>
SUMAR: <sumar>
CONTEXT: <context sau "N/A">
SENTIMENT: <pozitiv|negativ|neutru|controversat>
VERIFICARE: <"Confirmat de multiple surse" sau "Necesită verificare: [motiv]">

Articole (sortate după credibilitate):
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Răspunde în limba română, obiectiv și precis." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const title = content.match(/TITLU:\s*(.+)/)?.[1]?.trim() || "";
    const summary = content.match(/SUMAR:\s*(.+)/)?.[1]?.trim() || "";
    const context = content.match(/CONTEXT:\s*(.+)/)?.[1]?.trim() || "";
    const sentiment = content.match(/SENTIMENT:\s*(\w+)/)?.[1]?.trim() || "neutral";
    const verification = content.match(/VERIFICARE:\s*(.+)/)?.[1]?.trim() || "";
    
    return { 
      title, 
      summary, 
      context: context === "N/A" ? "" : context,
      sentiment,
      verification,
    };
  } catch (err) {
    console.error("  ⚠️  Title/summary generation failed:", err.message);
    return { title: "", summary: "", context: "", sentiment: "neutral", verification: "" };
  }
}

/** GPT-5.1: Classify and deduplicate articles across entities */
async function classifyAndDeduplicate(entitiesData) {
  console.log("\n🔍 Classifying and deduplicating across entities...");
  
  // Collect all articles with their current entity assignments
  const allArticles = [];
  entitiesData.forEach(entity => {
    entity.articles.forEach(article => {
      allArticles.push({
        ...article,
        currentEntity: entity.name,
        id: canonicalizeUrl(article.link),
      });
    });
  });
  
  // Deduplicate by URL first
  const uniqueArticles = new Map();
  allArticles.forEach(article => {
    if (!uniqueArticles.has(article.id)) {
      uniqueArticles.set(article.id, article);
    }
  });
  
  const articles = Array.from(uniqueArticles.values());
  
  if (articles.length === 0) return entitiesData;
  
  // Batch articles for GPT classification
  const batches = [];
  const BATCH_SIZE = 40;
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }
  
  const classifications = new Map();
  
  for (const batch of batches) {
    const payload = batch.map((a, i) => ({
      i,
      title: a.title,
      snippet: a.snippet.slice(0, 200),
      currentEntity: a.currentEntity,
    }));
    
    const prompt = `Clasifică aceste articole românești în EXACT UNA dintre următoarele categorii:

REGULI STRICTE:
1. "Opoziție" = DOAR AUR, SOS România, POT, George Simion, Diana Șoșoacă, Anamaria Gavrilă
2. "Guvern" = ministere, miniștri, justiție, magistrați, CSM, DNA, ÎCCJ, spitale, sănătate
3. "Parlament" = DOAR despre legi noi, voturi în plen, legislație, amendamente
4. "Coaliție (Putere)" = PSD, PNL, UDMR, USR (partide la guvernare)
5. "Președinție" = Nicușor Dan, Cotroceni, Administrația Prezidențială
6. "Local (Primării)" = primari, primării, consilii locale (NU primari din alte țări)
7. "EXCLUDE" = orice nu e relevant pentru România sau politica românească

IMPORTANT:
- Magistrați, judecători, procurori, justiție → "Guvern" (NU "Opoziție")
- Dacă articolul e despre o persoană din Opoziție → păstrează la "Opoziție"
- Dacă aceeași persoană apare în mai multe categorii → alege DOAR categoria principală
- Știri externe (Budapesta, Venezuela, etc.) → "EXCLUDE"
- Știri comerciale (magazine, oferte) → "EXCLUDE"

Răspunde cu JSON array de obiecte: [{"i": 0, "entity": "Guvern"}, {"i": 1, "entity": "EXCLUDE"}]

Articole:
${JSON.stringify(payload, null, 2)}`;

    try {
      const response = await openai.chat.completions.create({
        model: CONFIG.model,
        messages: [
          { role: "system", content: "Răspunde DOAR cu JSON valid." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
      });
      
      const content = response.choices[0].message.content.trim();
      const results = JSON.parse(content);
      
      if (Array.isArray(results)) {
        results.forEach(result => {
          const article = batch[result.i];
          if (article && result.entity !== "EXCLUDE") {
            classifications.set(article.id, result.entity);
          }
        });
      }
    } catch (err) {
      console.error("  ⚠️  Classification batch failed:", err.message);
      // Fallback: keep original classifications
      batch.forEach(article => {
        classifications.set(article.id, article.currentEntity);
      });
    }
  }
  
  // Rebuild entities with classified articles
  const newEntitiesData = ENTITIES.map(name => ({
    name,
    articles: [],
  }));
  
  articles.forEach(article => {
    const assignedEntity = classifications.get(article.id);
    if (assignedEntity) {
      const entity = newEntitiesData.find(e => e.name === assignedEntity);
      if (entity) {
        entity.articles.push(article);
      }
    }
  });
  
  console.log("  ✓ Classification complete");
  newEntitiesData.forEach(e => {
    console.log(`    ${e.name}: ${e.articles.length} articles`);
  });
  
  return newEntitiesData;
}
/** Pick best thumbnail from articles */
function pickBestThumbnail(items) {
  for (const item of items) {
    if (item.thumbnail && item.thumbnail.length > 10 && 
        !/logo|sprite|icon|avatar|default/i.test(item.thumbnail)) {
      return item.thumbnail;
    }
  }
  return null;
}
async function buildReport() {
  console.log("\n🚀 Starting report generation...\n");
  
  // Check cache
  const today = new Date().toLocaleDateString("ro-RO").replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.cacheDir, `report-${today}.json`);
  
  await fs.promises.mkdir(CONFIG.cacheDir, { recursive: true });
  if (fs.existsSync(cacheFile)) {
    console.log("✓ Using cached report");
    return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  }
  
  // Fetch articles
  const allArticles = await fetchRSS();
  console.log(`\n✓ Total articles: ${allArticles.length}\n`);
  
  // Initial filtering by keywords for each entity
  const entitiesData = [];
  
  for (const entityName of ENTITIES) {
    console.log(`📊 Initial filtering for ${entityName}...`);
    
    let articles = filterByKeywords(allArticles, entityName);
    articles = articles.filter(a => withinLast24h(a.date));
    articles = deduplicateByUrl(articles);
    
    console.log(`  → ${articles.length} articles`);
    
    entitiesData.push({
      name: entityName,
      articles,
    });
  }
  
  // GPT classification and deduplication across entities
  const classifiedData = await classifyAndDeduplicate(entitiesData);
  
  // Process each entity with clustering
  const entities = [];
  
  for (const entityData of classifiedData) {
    const entityName = entityData.name;
    const articles = entityData.articles;
    
    if (!articles.length) continue;
    
    console.log(`\n📊 Clustering ${entityName}...`);
    
    // Cluster into topics
    const clusters = await clusterArticles(entityName, articles);
    console.log(`  → ${clusters.length} topics found`);
    
    // Generate summaries for each topic
    const subjects = [];
    for (const cluster of clusters) {
      const items = cluster.indices
        .map(i => articles[i])
        .filter(Boolean)
        .slice(0, 5);
      
      if (!items.length) continue;
      
      const { title, summary, context, sentiment, verification } = await generateTitleSummary(items);
      
      // Calculate source diversity and viral score
      const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
      const avgCredibility = items.reduce((sum, it) => sum + (it.credibility || 0.5), 0) / items.length;
      const maxViralScore = Math.max(...items.map(it => it.viralScore || 1));
      const isViral = maxViralScore >= 3;
      
      subjects.push({
        label: cluster.label || title,
        titlu_ro: title,
        sumar_ro: summary,
        context_ro: context,
        sentiment,
        verification,
        items,
        // Metadata
        sourceDiversity: uniqueSources,
        avgCredibility: Math.round(avgCredibility * 100) / 100,
        articleCount: items.length,
        viralScore: maxViralScore,
        isViral,
      });
    }
    
    // Sort subjects: viral stories first, then by source diversity
    subjects.sort((a, b) => {
      if (a.isViral !== b.isViral) return b.isViral - a.isViral;
      return b.sourceDiversity - a.sourceDiversity;
    });
    
    entities.push({ name: entityName, subjects });
  }
  
  // Create report
  const report = {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities,
  };
  
  // Save
  await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(CONFIG.outDir, "data.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log("\n✅ Report generated successfully!\n");
  return report;
}
/** HTML generation */
function generateHTML(report) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", {
    timeZone: CONFIG.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });
  
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CONTEXTPOLITIC.ro – ${he.encode(when)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#1a1a1a;--bg:#fff;--muted:#6b7280;--line:#e5e7eb;--accent:#005a95;--accent-ink:#fff;--popular:#dc2626}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:Inter,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}
.wrap{max-width:1200px;margin:0 auto;padding:40px 20px}
.entity{margin:40px 0 32px}
.entity__t{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:8px 16px;font:800 16px/1 Space Grotesk,sans-serif;text-transform:uppercase;margin:0 0 16px;border-radius:4px}
.card{border-bottom:1px solid var(--line);padding:24px 0;margin:0 0 16px;display:grid;grid-template-columns:1fr 200px;gap:24px;align-items:start}
.card__body{min-width:0}
.card__head{display:flex;align-items:flex-start;gap:12px;margin:0 0 12px}
.card__t{font:800 24px/1.2 Space Grotesk,sans-serif;margin:0;flex:1}
.card__meta{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.badge{font-size:11px;padding:3px 8px;border-radius:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.badge--popular{background:var(--popular);color:#fff}
.badge--outlets{background:#dbeafe;color:#1e40af}
.card__thumb{width:200px;height:120px;object-fit:cover;border-radius:4px;border:1px solid var(--line)}
.sub__context{font-size:14px;color:var(--muted);margin:0 0 8px;font-style:italic}
.sub__sum{font-size:16px;color:var(--ink);margin:0 0 12px;line-height:1.5}
.items{margin:0;padding:0;list-style:none}
.items li{margin:8px 0;font-size:14px;display:flex;gap:8px}
.items a{color:inherit;text-decoration:none;border-bottom:1px solid rgba(10,10,10,.1)}
.items a:hover{border-bottom-color:var(--accent)}
.src{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
.more-sources{font-size:13px;color:var(--muted);margin:8px 0 0;font-style:italic}
.other-news{margin:40px 0;padding:24px;background:#f9fafb;border-radius:8px}
.other-news__t{font:800 20px/1.2 Space Grotesk,sans-serif;margin:0 0 16px}
.other-news__item{margin:12px 0;padding:12px 0;border-bottom:1px solid var(--line)}
.other-news__item:last-child{border:none}
.other-news__link{font-size:15px;font-weight:600;color:var(--ink);text-decoration:none;border-bottom:1px solid rgba(10,10,10,.1)}
.other-news__link:hover{border-bottom-color:var(--accent)}
@media(max-width:768px){
  .card{grid-template-columns:1fr}
  .card__thumb{width:100%;height:200px;order:-1}
}
</style>
</head>
<body>
<main class="wrap">
  <div id="content"></div>
</main>
<script>
const data=${JSON.stringify(report)};
const content=document.getElementById("content");
const fmtDomain=u=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch{return""}};

// Render main entities
const entitiesHTML=data.entities.map(e=>{
  if(!e.subjects.length)return "";
  const cards=e.subjects.map(s=>{
    const items=s.items.map(it=>
      \`<li><a href="\${it.link}" target="_blank">\${it.title}</a><span class="src">\${fmtDomain(it.link)}</span></li>\`
    ).join("");
    const moreSources=s.additionalItems>0?\`<div class="more-sources">+\${s.additionalItems} mai multe surse</div>\`:"";
    const ctx=s.context_ro?\`<p class="sub__context">\${s.context_ro}</p>\`:"";
    const sum=s.sumar_ro?\`<p class="sub__sum">\${s.sumar_ro}</p>\`:"";
    const popularBadge=s.isPopular?\`<span class="badge badge--popular">POPULAR</span>\`:"";
    const thumb=s.thumbnail?\`<img src="\${s.thumbnail}" alt="thumbnail" class="card__thumb" loading="lazy"/>\`:"";
    const meta=\`<div class="card__meta">
      \${popularBadge}
      <span class="badge badge--outlets">\${s.sourceDiversity||1} outlet-uri</span>
    </div>\`;
    return\`<div class="card">
      <div class="card__body">
        <div class="card__head"><h3 class="card__t">\${s.titlu_ro||s.label}</h3></div>
        \${meta}\${ctx}\${sum}
        <ul class="items">\${items}</ul>
        \${moreSources}
      </div>
      \${thumb}
    </div>\`;
  }).join("");
  return\`<section class="entity"><h2 class="entity__t">\${e.name}</h2>\${cards}</section>\`;
}).join("");

// Render other news
const otherNewsHTML=data.otherNews&&data.otherNews.length?\`
  <div class="other-news">
    <h2 class="other-news__t">Alte Știri de Interes</h2>
    \${data.otherNews.map(item=>\`
      <div class="other-news__item">
        <a href="\${item.link}" target="_blank" class="other-news__link">\${item.title}</a>
        <div class="src" style="margin-top:4px">\${fmtDomain(item.link)}</div>
      </div>
    \`).join('')}
  </div>
\`:"";

content.innerHTML=entitiesHTML+otherNewsHTML;
</script>
</body>
</html>`;
}

/** Main execution */
async function main() {
  if (!CONFIG.openaiKey) {
    console.error("❌ OPENAI_API_KEY required");
    process.exit(1);
  }
  
  const report = await buildReport();
  const html = generateHTML(report);
  
  await fs.promises.writeFile(
    path.join(CONFIG.outDir, "index.html"),
    html,
    "utf-8"
  );
  
  console.log(`✅ HTML saved to ${path.join(CONFIG.outDir, "index.html")}`);
  console.log(`📊 Statistics:`);
  console.log(`   - Entities: ${report.entities.length}`);
  console.log(`   - Topics: ${report.entities.reduce((s,e)=>s+e.subjects.length,0)}`);
  console.log(`   - Articles: ${report.entities.reduce((s,e)=>s+e.subjects.reduce((ss,sub)=>ss+sub.items.length,0),0)}`);
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
