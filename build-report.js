import fs from "fs";
import path from "path";
import OpenAI from "openai";
import he from "he";
import Parser from "rss-parser";

/** Configuration */
const CONFIG = {
  openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  model: "gpt-4-turbo",
  outDir: path.join(process.cwd(), "public"),
  cacheDir: path.join(process.cwd(), ".cache"),
  timezone: "Europe/Bucharest",
  feeds: [
    "https://news.yam.ro/ro/rss",
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
  sourceCredibility: {
    "news.yam.ro": 0.5,
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
  "Președinție": ["Nicușor Dan", "Administrația Prezidențială", "Iohannis", "Cotroceni", "Lasconi", "Geoana"],
  "Guvern": ["Guvernul", "Premierul", "Ciolacu", "Ministrul", "Ministerul", "Bolojan", "Minesterul", "OUG"],
  "Parlament": ["Parlamentul", "Camera Deputaților", "Senatul", "Senator", "Deputat", "Plen", "Legislativ"],
  "Coaliție (Putere)": ["PSD", "PNL", "UDMR", "USR", "Coalitia", "Ciuca"],
  "Opoziție": ["AUR", "Simion", "SOS România", "Șoșoacă", "Sosoaca", "Partidul POT", "Georgescu"],
  "Local (Primării)": ["primar", "primăria", "consiliul local", "București", "Cluj", "locală"],
};

/** STOP WORDS ROMANIAN */
const STOP_WORDS = new Set([
  "de", "la", "si", "și", "in", "în", "cu", "o", "un", "mai", "pentru", "pe", "nu", "sa", "să", "din",
  "ale", "lui", "al", "ai", "fost", "este", "sunt", "au", "fi", "ca", "că", "ce", "cine", "cand", "când",
  "cum", "unde", "care", "doar", "tot", "toti", "toți", "dupa", "după", "prin", "peste", "sub", "fara", "fără"
]);

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

/** Jaccard Similarity Logic for Grouping */
function getTokens(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\săîâșț]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function calculateSimilarity(str1, str2) {
  const set1 = new Set(getTokens(str1));
  const set2 = new Set(getTokens(str2));
  
  if (set1.size === 0 || set2.size === 0) return 0;
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/** Group articles by Topic Similarity */
function clusterBySimilarity(articles) {
  const clusters = [];
  const sortedArticles = [...articles].sort((a, b) => b.title.length - a.title.length);

  for (const article of sortedArticles) {
    let bestClusterIndex = -1;
    let bestSimilarity = 0;

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const sim = calculateSimilarity(article.title, cluster[0].title);
      
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterIndex = i;
      }
    }

    if (bestSimilarity >= 0.20 && bestClusterIndex !== -1) {
      clusters[bestClusterIndex].push(article);
    } else {
      clusters.push([article]);
    }
  }

  return clusters;
}

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
  
  const enriched = articles.map(a => {
    const cred = CONFIG.sourceCredibility[domainOf(a.link)] || 0.5;
    return { ...a, credibility: cred };
  });

  return enriched;
}

const ROMANIA_SIGNALS = [
  "românia", "romania", "românesc", "romanesc", "bucuresti", "bucurești",
  "cluj", "timișoara", "timisoara", "iași", "iasi", "constanța", "constanta",
  "brașov", "brasov", "sibiu", "craiova", "galați", "galati", "ploiești", "ploiesti",
  "ciolacu", "ciucă", "iohannis", "simion", "sosoaca", "lasconi", "geoana", "bolojan"
];

const IRRELEVANT_SIGNALS = [
  "budapesta", "ungaria", "maghiar", "orban viktor",
  "venezuela", "machado", "oslo", "veneția", "rialto",
  "tezaur", "colosseum mall", "inaugurare", "oferte speciale",
  "edituri", "manuale", "academiei române", "ioan-aurel pop",
  "horoscop", "meteo", "sport", "fotbal", "simona halep"
];

function isAboutRomania(article) {
  const text = `${article.title} ${article.snippet}`.toLowerCase();
  if (IRRELEVANT_SIGNALS.some(sig => text.includes(sig))) return false;
  return ROMANIA_SIGNALS.some(sig => text.includes(sig));
}

function filterByKeywords(articles, entityName) {
  const keywords = QUERIES[entityName] || [];
  return articles
    .filter(isAboutRomania)
    .filter(article => {
      const text = `${article.title} ${article.snippet}`.toLowerCase();
      return keywords.some(kw => text.includes(kw.toLowerCase()));
    });
}

function deduplicateByUrl(articles) {
  const seen = new Map();
  articles.forEach(article => {
    const url = canonicalizeUrl(article.link);
    if (!seen.has(url)) seen.set(url, article);
  });
  return Array.from(seen.values());
}

/** GPT: Generate title, summary, and context */
async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "", context: "", sentiment: "neutral" };
  
  const sorted = articles.sort((a, b) => (b.credibility || 0.5) - (a.credibility || 0.5));
  
  const payload = sorted.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 150),
    source: a.source,
  }));
  
  const prompt = `Analizează acest grup de articole (care sunt despre ACELAȘI subiect) și creează:
1. TITLU: Un titlu scurt, informativ, jurnalistic (max 10 cuvinte).
2. SUMAR: Un sumar obiectiv de max 25 cuvinte.
3. CONTEXT: O propoziție scurtă de context ("Vine după...", "În contextul..."). Dacă nu e clar, scrie "N/A".
4. SENTIMENT: <pozitiv|negativ|neutru|controversat>

Format răspuns strict:
TITLU: ...
SUMAR: ...
CONTEXT: ...
SENTIMENT: ...

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Ești un editor de știri experimentat. Răspunde în română." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const title = content.match(/TITLU:\s*(.+)/)?.[1]?.trim() || sorted[0].title;
    const summary = content.match(/SUMAR:\s*(.+)/)?.[1]?.trim() || "";
    const context = content.match(/CONTEXT:\s*(.+)/)?.[1]?.trim() || "";
    const sentiment = content.match(/SENTIMENT:\s*(\w+)/)?.[1]?.trim() || "neutral";
    
    return { 
      title, 
      summary, 
      context: context === "N/A" ? "" : context,
      sentiment
    };
  } catch (err) {
    console.error("  ⚠️  GPT Summary failed:", err.message);
    return { title: sorted[0].title, summary: "", context: "", sentiment: "neutral" };
  }
}

/** Pick best thumbnail */
function pickBestThumbnail(items) {
  for (const item of items) {
    if (item.thumbnail && item.thumbnail.length > 10 && 
        !/logo|sprite|icon|avatar|default/i.test(item.thumbnail)) {
      return item.thumbnail;
    }
  }
  return null;
}

/** Main Report Builder */
async function buildReport() {
  console.log("\n🚀 Starting report generation (Logic V2)...\n");
  
  const today = new Date().toLocaleDateString("ro-RO").replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.cacheDir, `report-v2-${today}.json`);
  
  await fs.promises.mkdir(CONFIG.cacheDir, { recursive: true });
  
  // 1. Fetch & Dedupe Global
  let allArticles = await fetchRSS();
  allArticles = allArticles.filter(a => withinLast24h(a.date));
  allArticles = deduplicateByUrl(allArticles);
  
  console.log(`✓ Fetched ${allArticles.length} recent articles.`);

  const usedUrls = new Set();
  const entitiesOutput = [];
  const allUsedSources = new Set();

  // 2. Process Entities
  for (const entityName of ENTITIES) {
    console.log(`\n📂 Processing: ${entityName}`);
    
    // a. Filter strictly by keywords
    let entityArticles = filterByKeywords(allArticles, entityName);
    
    // b. IMPORTANT: Remove articles already used in previous entities
    entityArticles = entityArticles.filter(a => !usedUrls.has(a.link));

    if (entityArticles.length === 0) continue;

    // c. CLUSTER BY SIMILARITY
    const rawClusters = clusterBySimilarity(entityArticles);
    console.log(`   → Found ${rawClusters.length} raw clusters (topics).`);

    const subjects = [];

    // d. Process each cluster
    for (const cluster of rawClusters) {
      const maxCred = Math.max(...cluster.map(c => c.credibility));
      
      if (cluster.length < 2 && maxCred < 0.8) continue; 

      const items = cluster.slice(0, 5);
      
      // Mark as used
      items.forEach(i => {
        usedUrls.add(i.link);
        allUsedSources.add(domainOf(i.link));
      });

      const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
      const viralScore = cluster.length;
      const isViral = uniqueSources >= 3;

      const meta = await generateTitleSummary(items);
      
      // Get the first (most credible) article's link for the main link
      const primaryLink = items[0]?.link || "";
      
      subjects.push({
        label: meta.title,
        titlu_ro: meta.title,
        sumar_ro: meta.summary,
        context_ro: meta.context,
        sentiment: meta.sentiment,
        items: items,
        thumbnail: pickBestThumbnail(items),
        sourceDiversity: uniqueSources,
        viralScore: viralScore,
        isViral: isViral,
        primaryLink: primaryLink
      });
    }

    subjects.sort((a, b) => b.viralScore - a.viralScore);
    const finalSubjects = subjects.slice(0, 6);

    if (finalSubjects.length > 0) {
      entitiesOutput.push({ name: entityName, subjects: finalSubjects });
    }
  }

  // 3. Collect "Alte Știri" (Other News)
  console.log("\n📰 Collecting Other News...");
  
  let leftovers = allArticles.filter(a => !usedUrls.has(a.link));
  
  const leftoverClusters = clusterBySimilarity(leftovers);
  const otherNewsCandidates = [];

  for (const cluster of leftoverClusters) {
    const maxCred = Math.max(...cluster.map(c => c.credibility));
    if (cluster.length < 2 && maxCred < 0.9) continue;

    const items = cluster;
    const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
    
    items.sort((a, b) => (b.credibility * 100 + b.title.length) - (a.credibility * 100 + a.title.length));
    const rep = items[0];

    // Track sources
    items.forEach(i => allUsedSources.add(domainOf(i.link)));

    otherNewsCandidates.push({
      title: rep.title,
      link: rep.link,
      source: rep.source,
      thumbnail: pickBestThumbnail(items) || rep.thumbnail,
      viralScore: uniqueSources
    });
  }

  otherNewsCandidates.sort((a, b) => b.viralScore - a.viralScore);
  const otherNews = otherNewsCandidates.slice(0, 12);

  const report = {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities: entitiesOutput,
    otherNews: otherNews,
    sources: Array.from(allUsedSources).sort()
  };

  await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
  await fs.promises.writeFile(path.join(CONFIG.outDir, "data.json"), JSON.stringify(report, null, 2));
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log("\n✅ Report generated successfully!");
  return report;
}

/** HTML Generator */
function generateHTML(report) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", {
    timeZone: CONFIG.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });
  
  const sourcesListHTML = report.sources ? report.sources.map(s => `<span class="source-tag">${he.encode(s)}</span>`).join(" ") : "";
  
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Raport Politic – ${he.encode(when)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg: #fafafa;
  --surface: #ffffff;
  --ink: #111111;
  --ink-secondary: #444444;
  --ink-tertiary: #888888;
  --border: #e0e0e0;
  --border-dark: #cccccc;
  --accent: #111111;
}
*{box-sizing:border-box}
body{
  margin:0;padding:0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
}
a{color:inherit;text-decoration:none;transition:opacity 0.2s}
a:hover{opacity:0.7}

.wrap{max-width:1100px;margin:0 auto;padding:40px 20px 60px}

/* Timestamp */
.timestamp{
  font-size:0.75rem;
  color:var(--ink-tertiary);
  text-align:right;
  margin-bottom:40px;
  padding-bottom:16px;
  border-bottom:1px solid var(--border);
}

/* Entity Section */
.entity{margin-bottom:56px}
.entity-header{
  margin-bottom:20px;
  padding-bottom:8px;
  border-bottom:2px solid var(--ink);
}
.entity-title{
  font-size:0.85rem;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:0.1em;
  margin:0;
  color:var(--ink);
}

/* Grid Layout */
.cards-grid{
  display:grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap:20px;
}

/* Card Style */
.card{
  background:var(--surface);
  border:1px solid var(--border);
  overflow:hidden;
  display:flex;flex-direction:column;
  transition:border-color 0.2s;
}
.card:hover{border-color:var(--border-dark)}

.card--viral{
  border-width:2px;
  border-color:var(--ink);
  grid-column: 1 / -1;
}
.card--viral .card-content{
  display:grid;
  grid-template-columns: 1fr 1.2fr;
  gap:24px;
}
@media(max-width: 768px){ .card--viral .card-content{ grid-template-columns: 1fr; } }

/* Thumbnail */
.thumb-container{
  position:relative;
  width:100%;
  aspect-ratio: 16/9;
  background:#f0f0f0;
  overflow:hidden;
}
.thumb-container a{display:block;width:100%;height:100%}
.card--viral .thumb-container{
  height:100%;
  min-height:220px;
}
@media(max-width: 768px){ .card--viral .thumb-container{ height:200px; } }

.thumb{width:100%;height:100%;object-fit:cover;display:block;filter:grayscale(30%);transition:filter 0.3s}
.thumb:hover{filter:grayscale(0%)}

/* Content */
.body{padding:16px;flex:1;display:flex;flex-direction:column}
.meta-top{display:flex;gap:6px;margin-bottom:10px;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
.badge{padding:3px 6px;border:1px solid var(--border-dark);color:var(--ink-secondary)}
.badge-viral{background:var(--ink);color:white;border-color:var(--ink)}

h3{
  font-size:1rem;
  font-weight:600;
  line-height:1.4;
  margin:0 0 8px;
}
h3 a{display:block}
.card--viral h3{font-size:1.25rem}

.context{font-size:0.75rem;color:var(--ink-tertiary);font-style:italic;margin-bottom:6px}
.summary{font-size:0.85rem;color:var(--ink-secondary);margin-bottom:12px;line-height:1.5}

/* Links List */
.links{list-style:none;padding:0;margin:auto 0 0;border-top:1px solid var(--border);padding-top:10px}
.links li{margin-bottom:4px;font-size:0.8rem;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.links a{font-weight:500;color:var(--ink-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.links span{font-size:0.65rem;color:var(--ink-tertiary);white-space:nowrap}

/* Other News Section */
.other-news-section{margin-top:60px;padding-top:32px;border-top:2px solid var(--ink)}
.other-news-title{font-size:0.85rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 20px}
.other-list{display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:16px}
.other-item{display:flex;gap:12px;align-items:start;padding:12px;border:1px solid var(--border);background:var(--surface)}
.other-item:hover{border-color:var(--border-dark)}
.other-thumb{width:70px;height:50px;object-fit:cover;background:#f0f0f0;filter:grayscale(40%);flex-shrink:0}
.other-content{flex:1;min-width:0}
.other-link{font-weight:500;font-size:0.85rem;display:block;margin-bottom:2px;line-height:1.3}
.other-source{font-size:0.7rem;color:var(--ink-tertiary)}

/* Footer */
footer{
  margin-top:80px;
  padding-top:24px;
  border-top:1px solid var(--border);
  font-size:0.75rem;
  color:var(--ink-tertiary);
}
.footer-sources{margin-bottom:16px}
.footer-sources-title{font-weight:600;color:var(--ink-secondary);margin-bottom:8px}
.source-tag{
  display:inline-block;
  padding:2px 6px;
  margin:2px;
  background:#f5f5f5;
  border:1px solid var(--border);
  font-size:0.7rem;
}
.footer-coffee{
  margin-top:16px;
  padding:12px;
  background:#f9f9f9;
  border:1px solid var(--border);
  text-align:center;
}
.footer-coffee a{font-weight:600;color:var(--ink)}

@media(max-width: 600px){
  .cards-grid{grid-template-columns:1fr}
  .other-list{grid-template-columns:1fr}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="timestamp">Raport generat: ${he.encode(when)}</div>
  <div id="content"></div>
  <footer>
    <div class="footer-sources">
      <div class="footer-sources-title">Surse utilizate</div>
      ${sourcesListHTML}
    </div>
    <div class="footer-coffee">
      ☕ Dacă ți-a fost util, poți să-mi dai o cafea: <a href="https://revolut.me/haurbalaur" target="_blank">revolut.me/haurbalaur</a>
    </div>
  </footer>
</main>
<script>
const data=${JSON.stringify(report)};
const content=document.getElementById("content");
const fmtDomain=u=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch{return""}};

// Helper pentru plural/singular
const fmtSources = n => n === 1 ? "1 sursă" : n + " surse";

// Render Entities
const entitiesHTML=data.entities.map(e=>{
  if(!e.subjects.length)return "";
  
  const cards=e.subjects.map(s=>{
    const isViral = s.isViral;
    const primaryLink = s.primaryLink || (s.items[0] ? s.items[0].link : "#");
    
    // Exclude first item from the links list since it's the primary link
    const otherItems = s.items.slice(1, isViral ? 5 : 4);
    const items = otherItems.map(it=>
      \`<li><a href="\${it.link}" target="_blank" title="\${it.title}">\${it.title}</a><span>\${fmtDomain(it.link)}</span></li>\`
    ).join("");
    
    const thumbSrc = s.thumbnail || "";
    const thumbHTML = thumbSrc ? \`<div class="thumb-container"><a href="\${primaryLink}" target="_blank"><img src="\${thumbSrc}" class="thumb" loading="lazy" onerror="this.parentElement.style.display='none'" /></a></div>\` : '';
    
    const viralBadge = s.isViral ? \`<span class="badge badge-viral">Viral</span>\` : '';
    const sourceBadge = \`<span class="badge">\${fmtSources(s.sourceDiversity)}</span>\`;
    
    const contextHTML = s.context_ro ? \`<div class="context">\${s.context_ro}</div>\` : '';
    
    // Viral layout vs Standard layout
    if(isViral && thumbSrc) {
       return \`
       <div class="card card--viral">
         <div class="card-content">
           \${thumbHTML}
           <div class="body">
             <div class="meta-top">\${viralBadge}\${sourceBadge}</div>
             <h3><a href="\${primaryLink}" target="_blank">\${s.titlu_ro}</a></h3>
             \${contextHTML}
             <div class="summary">\${s.sumar_ro}</div>
             \${items ? \`<ul class="links">\${items}</ul>\` : ''}
           </div>
         </div>
       </div>\`;
    }

    return \`
    <div class="card">
      \${thumbSrc ? thumbHTML : ''}
      <div class="body">
        <div class="meta-top">\${viralBadge}\${sourceBadge}</div>
        <h3><a href="\${primaryLink}" target="_blank">\${s.titlu_ro}</a></h3>
        \${contextHTML}
        <div class="summary">\${s.sumar_ro}</div>
        \${items ? \`<ul class="links">\${items}</ul>\` : ''}
      </div>
    </div>\`;
  }).join("");

  return \`
    <section class="entity">
      <div class="entity-header"><h2 class="entity-title">\${e.name}</h2></div>
      <div class="cards-grid">\${cards}</div>
    </section>
  \`;
}).join("");

// Render Other News
const otherNewsHTML = data.otherNews && data.otherNews.length ? \`
  <section class="other-news-section">
    <h2 class="other-news-title">Alte Știri</h2>
    <div class="other-list">
      \${data.otherNews.map(item => \`
        <a href="\${item.link}" target="_blank" class="other-item">
          \${item.thumbnail ? \`<img src="\${item.thumbnail}" class="other-thumb" loading="lazy" onerror="this.style.display='none'" />\` : ''}
          <div class="other-content">
            <div class="other-link">\${item.title}</div>
            <div class="other-source">\${fmtDomain(item.link)}</div>
          </div>
        </a>
      \`).join('')}
    </div>
  </section>
\` : "";

content.innerHTML = entitiesHTML + otherNewsHTML;
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
  
  try {
    const report = await buildReport();
    const html = generateHTML(report);
    
    await fs.promises.writeFile(path.join(CONFIG.outDir, "index.html"), html, "utf-8");
    
    console.log(`✅ HTML saved to ${path.join(CONFIG.outDir, "index.html")}`);
    console.log(`📊 Statistics:`);
    console.log(`   - Entities: ${report.entities.length}`);
    console.log(`   - Other News: ${report.otherNews?.length || 0}`);
    console.log(`   - Sources: ${report.sources?.length || 0}`);
  } catch(e) {
    console.error("FATAL ERROR:", e);
  }
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
