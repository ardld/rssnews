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
    "https://www.biziday.ro/feed/",
    "https://b365.ro/feed/",
    "https://www.digi24.ro/rss",
    "https://hotnews.ro/c/actualitate/feed",
    "https://www.g4media.ro/feed",
    "https://www.libertatea.ro/feed/",
    "https://spotmedia.ro/feed",
    "https://recorder.ro/feed",
    "https://pressone.ro/api/rss",
    "https://romania.europalibera.org/api/zvo_mml-vomx_-tpeukvm_",
    "https://adevarul.ro/rss/index",
  ],
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

/** Entities & Search Queries */
const ENTITIES = [
  "Președinție",
  "Guvern",
  "Parlament",
  "Coaliție (Putere)",
  "Opoziție",
  "Local (Primării)",
];

const QUERIES = {
  "Președinție": ["Nicușor Dan", "Administrația Prezidențială", "Iohannis", "Cotroceni", "Lasconi", "Geoana", "Președintele"],
  "Guvern": ["Guvernul", "Premierul", "Ciolacu", "Ministrul", "Ministerul", "Bolojan", "Minesterul", "OUG", "Hotărâre de Guvern"],
  "Parlament": ["Parlamentul", "Camera Deputaților", "Senatul", "Senator", "Deputat", "Plen", "Legislativ", "Comisie parlamentară"],
  "Coaliție (Putere)": ["PSD", "PNL", "UDMR", "USR", "Coalitia", "Ciuca", "Liderii coaliției"],
  "Opoziție": ["AUR", "Simion", "SOS România", "Șoșoacă", "Sosoaca", "Partidul POT", "Georgescu", "Liderul opoziției"],
  "Local (Primării)": ["primar", "primăria", "consiliul local", "București", "Cluj", "locală", "Sectorul"],
};

const STOP_WORDS = new Set([
  "de", "la", "si", "și", "in", "în", "cu", "o", "un", "mai", "pentru", "pe", "nu", "sa", "să", "din",
  "ale", "lui", "al", "ai", "fost", "este", "sunt", "au", "fi", "ca", "că", "ce", "cine", "cand", "când",
  "cum", "unde", "care", "doar", "tot", "toti", "toți", "dupa", "după", "prin", "peste", "sub", "fara", "fără"
]);

/** Helpers */
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
  } catch { return url; }
};

const domainOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

const withinLast24h = (dateStr) => {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  return Date.now() - d.getTime() <= 24 * 60 * 60 * 1000;
};

/** Jaccard Similarity for Grouping */
function getTokens(text) {
  return text.toLowerCase().replace(/[^\w\săîâșț]/g, "").split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function calculateSimilarity(str1, str2) {
  const set1 = new Set(getTokens(str1));
  const set2 = new Set(getTokens(str2));
  if (set1.size === 0 || set2.size === 0) return 0;
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
}

function clusterBySimilarity(articles) {
  const clusters = [];
  // Sort by length desc: longer titles are better seeds for clustering
  const sortedArticles = [...articles].sort((a, b) => b.title.length - a.title.length);

  for (const article of sortedArticles) {
    let bestClusterIndex = -1;
    let bestSimilarity = 0;

    for (let i = 0; i < clusters.length; i++) {
      // Compare against the seed (first article) of the cluster
      const sim = calculateSimilarity(article.title, clusters[i][0].title);
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterIndex = i;
      }
    }

    // Threshold: 0.20 (20% word overlap is sufficient to link similar topics)
    if (bestSimilarity >= 0.20 && bestClusterIndex !== -1) {
      clusters[bestClusterIndex].push(article);
    } else {
      clusters.push([article]);
    }
  }
  return clusters;
}

/** Fetching */
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
          credibility: CONFIG.sourceCredibility[domainOf(feedUrl)] || 0.5
        });
      });
    } catch (err) { console.error(`  ⚠️  Failed: ${feedUrl}`); }
  }
  return articles;
}

const ROMANIA_SIGNALS = [
  "românia", "romania", "românesc", "bucuresti", "cluj", "timișoara", "iași", "constanța",
  "brașov", "sibiu", "craiova", "guvern", "parlament", "ministru", "presedinte", "primar"
];
const IRRELEVANT_SIGNALS = [
  "budapesta", "ungaria", "maghiar", "orban viktor", "venezuela", "machado", "oslo", "veneția",
  "tezaur", "colosseum mall", "inaugurare", "oferte", "manuale", "horoscop", "meteo", "sport", "fotbal"
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

/** GPT Summary */
async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "", context: "", sentiment: "neutral" };
  const sorted = articles.sort((a, b) => b.credibility - a.credibility);
  
  const payload = sorted.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 150),
    source: a.source,
  }));
  
  const prompt = `Analizează acest grup de articole despre ACELAȘI subiect.
1. TITLU: Jurnalistic, scurt (max 10 cuvinte).
2. SUMAR: Obiectiv, max 25 cuvinte.
3. CONTEXT: Scurt ("Vine după...", "În contextul..."). Dacă nu e, scrie "N/A".
4. SENTIMENT: <neutru|controversat|pozitiv|negativ> (folosește neutru/controversat dacă nu e clar)

Format:
TITLU: ...
SUMAR: ...
CONTEXT: ...
SENTIMENT: ...

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [{ role: "system", content: "Editor știri, limba română." }, { role: "user", content: prompt }],
      temperature: 0.3,
    });
    const c = response.choices[0].message.content;
    const cleanContext = (c.match(/CONTEXT:\s*(.+)/)?.[1]?.trim() || "N/A") === "N/A" ? "" : c.match(/CONTEXT:\s*(.+)/)?.[1]?.trim();
    
    return { 
      title: c.match(/TITLU:\s*(.+)/)?.[1]?.trim() || sorted[0].title,
      summary: c.match(/SUMAR:\s*(.+)/)?.[1]?.trim() || "",
      context: cleanContext,
      sentiment: c.match(/SENTIMENT:\s*(\w+)/)?.[1]?.trim() || "neutru"
    };
  } catch { 
    console.error("  ⚠️  GPT Summary failed, using fallback title.");
    return { title: sorted[0].title, summary: "", context: "", sentiment: "neutral" }; 
  }
}

function pickBestThumbnail(items) {
  for (const item of items) {
    if (item.thumbnail && item.thumbnail.length > 10 && !/logo|sprite|icon|avatar|default/i.test(item.thumbnail)) return item.thumbnail;
  }
  return null;
}

/** Build Report */
async function buildReport() {
  console.log("🚀 Generare raport (Monocrom + Dedublare Globală)...");
  
  let allArticles = await fetchRSS();
  allArticles = allArticles.filter(a => withinLast24h(a.date));
  allArticles = deduplicateByUrl(allArticles);
  
  // GLOBAL DEDUPLICATION SET
  const globalUsedUrls = new Set();
  
  const entitiesOutput = [];

  // 1. Process Entities sequentially (order matters for deduplication)
  for (const entityName of ENTITIES) {
    console.log(`\n📂 Procesare: ${entityName}`);
    
    // a. Filter keywords AND exclude globally used URLs
    let entityArticles = filterByKeywords(allArticles, entityName)
      .filter(a => !globalUsedUrls.has(a.link));
    
    if (entityArticles.length === 0) continue;

    // b. Cluster
    const rawClusters = clusterBySimilarity(entityArticles);
    console.log(`   → Găsite ${rawClusters.length} topicuri potențiale.`);
    const subjects = [];

    for (const cluster of rawClusters) {
      const maxCred = Math.max(...cluster.map(c => c.credibility));
      // Filter clusters that are too small and low-credibility (e.g., 1 article from b365.ro)
      if (cluster.length < 2 && maxCred < 0.8) continue; 

      const items = cluster.slice(0, 5);
      
      // MARK AS USED GLOBALLY
      items.forEach(i => globalUsedUrls.add(i.link));

      const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
      const viralScore = cluster.length;
      const meta = await generateTitleSummary(items);
      
      subjects.push({
        label: meta.title,
        titlu_ro: meta.title,
        sumar_ro: meta.summary,
        context_ro: meta.context,
        sentiment: meta.sentiment,
        items: items, // First item is items[0]
        thumbnail: pickBestThumbnail(items),
        sourceDiversity: uniqueSources,
        viralScore: viralScore,
        isViral: uniqueSources >= 3 // Define viral as covered by 3+ unique sources
      });
    }

    subjects.sort((a, b) => b.viralScore - a.viralScore);
    const finalSubjects = subjects.slice(0, 6); // Keep top 6 topics

    if (finalSubjects.length > 0) {
      entitiesOutput.push({ name: entityName, subjects: finalSubjects });
    }
  }

  // 2. Process Other News (Leftovers)
  console.log("\n📰 Colectare Alte Știri...");
  const leftovers = allArticles.filter(a => !globalUsedUrls.has(a.link));
  const leftoverClusters = clusterBySimilarity(leftovers);
  const otherNewsCandidates = [];

  for (const cluster of leftoverClusters) {
    const maxCred = Math.max(...cluster.map(c => c.credibility));
    // Filter clusters that are not strong enough for "Other News"
    if (cluster.length < 2 && maxCred < 0.9) continue;

    const items = cluster;
    // Sort items by credibility to pick the best representation
    items.sort((a, b) => (b.credibility * 100 + b.title.length) - (a.credibility * 100 + a.title.length));
    const rep = items[0]; // Representative article

    // We still mark as used to ensure no duplicates if this logic is run again
    items.forEach(i => globalUsedUrls.add(i.link));

    otherNewsCandidates.push({
      title: rep.title,
      link: rep.link,
      source: rep.source,
      thumbnail: pickBestThumbnail(items) || rep.thumbnail,
      viralScore: new Set(items.map(it => domainOf(it.link))).size
    });
  }

  otherNewsCandidates.sort((a, b) => b.viralScore - a.viralScore);
  console.log(`   → Găsite ${otherNewsCandidates.length} știri relevante.`);

  return {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities: entitiesOutput,
    otherNews: otherNewsCandidates.slice(0, 12),
    sourcesList: CONFIG.feeds.map(f => domainOf(f)).filter((v,i,a)=>a.indexOf(v)===i) // unique domains
  };
}

/** HTML Generator (Monochrome & Integrated) */
function generateHTML(report) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", { timeZone: CONFIG.timezone, dateStyle: "long", timeStyle: "short" });
  
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Raport Știri – ${he.encode(when)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Merriweather:ital,wght@0,700;1,400&display=swap" rel="stylesheet">
<style>
:root{
  --bg: #ffffff;
  --ink: #18181b;       /* Zinc 900 */
  --ink-sec: #52525b;   /* Zinc 600 */
  --ink-tr: #a1a1aa;    /* Zinc 400 */
  --border: #e4e4e7;    /* Zinc 200 */
  --card-bg: #ffffff;
  --hover-bg: #f4f4f5;  /* Zinc 100 */
}
*{box-sizing:border-box}
body{
  margin:0;padding:0;
  font-family: 'Inter', system-ui, sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
a{color:inherit;text-decoration:none}
.wrap{max-width:1024px;margin:0 auto;padding:20px}

/* Discreet Header */
.top-bar{
  display:flex;justify-content:flex-end;
  font-size:0.75rem;color:var(--ink-tr);
  margin-bottom:40px;border-bottom:1px solid var(--border);padding-bottom:10px;
}

/* Typography */
h2 {
  font-size: 1.5rem; letter-spacing: -0.02em; font-weight: 800;
  margin: 40px 0 20px; text-transform: uppercase; border-bottom: 2px solid var(--ink);
  display: inline-block; padding-bottom: 4px;
}
h3 {
  font-family: 'Merriweather', serif; font-size: 1.15rem; font-weight: 700; margin: 0 0 10px;
  line-height: 1.4; transition: opacity 0.2s;
}
h3 a:hover { opacity: 0.7; }

/* Grid */
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 32px; }

/* Card - Monochrome */
.card {
  display: flex; flex-direction: column;
  border-bottom: 1px solid var(--border); padding-bottom: 24px;
}
.card:last-child { border-bottom: none; }

/* Viral Layout - Spans full width on desktop */
.card--viral { 
  grid-column: 1 / -1; 
  display: grid; 
  grid-template-columns: 1fr 1.5fr; 
  gap: 24px; 
  border-bottom: 4px solid var(--ink); 
  padding-bottom: 32px; 
  margin-bottom: 32px; 
}
@media(max-width: 768px) { .card--viral { grid-template-columns: 1fr; } }

/* Thumbnails */
.thumb-wrap {
  width: 100%; 
  aspect-ratio: 16/9; 
  background: var(--hover-bg); 
  border-radius: 4px; 
  overflow: hidden; 
  margin-bottom: 16px;
  border: 1px solid var(--border);
  display: block; /* Ensure it behaves like a block element */
}
.card--viral .thumb-wrap { margin-bottom: 0; height: 100%; }
.thumb { width: 100%; height: 100%; object-fit: cover; filter: grayscale(100%); transition: filter 0.3s; }
.card:hover .thumb { filter: grayscale(0%); } /* Color on hover effect */

/* Meta & Badges */
.meta { display: flex; gap: 8px; margin-bottom: 12px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }
.badge {
  padding: 2px 6px; border: 1px solid var(--ink-tr); border-radius: 0px;
  color: var(--ink-sec); background: transparent;
}
.badge-viral { background: var(--ink); color: #fff; border-color: var(--ink); }

.context { font-size: 0.85rem; color: var(--ink-sec); font-style: italic; margin-bottom: 8px; border-left: 2px solid var(--ink); padding-left: 8px; }
.summary { font-size: 0.95rem; color: var(--ink-sec); margin-bottom: 16px; }

/* Source Links */
.sources { list-style: none; padding: 0; margin: auto 0 0; font-size: 0.8rem; border-top: 1px dashed var(--border); padding-top: 12px; }
.sources li { 
  display: flex; justify-content: space-between; margin-bottom: 4px; color: var(--ink-sec); 
  overflow: hidden; /* For ellipsis on title */
}
.sources li a { 
  flex-shrink: 1; 
  min-width: 0; /* Important for flex to apply truncation */
  white-space: nowrap; 
  overflow: hidden; 
  text-overflow: ellipsis;
}
.sources li span { 
  flex-shrink: 0; /* Keep domain visible */
  margin-left: 8px; 
  color: var(--ink-tr);
}
.sources a:hover { text-decoration: underline; color: var(--ink); }

/* Other News - Compact List */
.other-section { margin-top: 60px; background: var(--hover-bg); padding: 32px; border-radius: 8px; }
.other-list { 
  display: grid; 
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); 
  gap: 24px; 
}
.other-item { display: flex; gap: 12px; align-items: start; }
.other-thumb { 
  width: 70px; height: 50px; background: #ddd; object-fit: cover; 
  border-radius: 2px; filter: grayscale(100%); flex-shrink: 0; 
}
.other-title { font-weight: 600; font-size: 0.9rem; line-height: 1.35; }
.other-meta { font-size: 0.7rem; color: var(--ink-tr); margin-top: 4px; }

/* Footer */
footer { margin-top: 80px; padding: 40px 0; border-top: 4px solid var(--ink); text-align: center; color: var(--ink-sec); font-size: 0.9rem; }
.sources-footer { margin-bottom: 12px; max-width: 800px; margin-left: auto; margin-right: auto; line-height: 1.8; color: var(--ink-tr); }
.coffee-btn {
  display: inline-block; margin-top: 16px; padding: 8px 16px; background: var(--ink); color: #fff; border-radius: 4px; font-weight: 600;
}
.coffee-btn:hover { opacity: 0.9; }
</style>
</head>
<body>
<main class="wrap">
  <div class="top-bar">Raport generat: ${he.encode(when)}</div>
  
  <div id="content"></div>
  
  <footer>
    <div class="sources-footer">Surse monitorizate: ${report.sourcesList.join(", ")}</div>
    <div>Logica AI de grupare și sumarizare. Verificați întotdeauna sursele originale.</div>
    <a href="https://revolut.me/haurbalaur" target="_blank" class="coffee-btn">☕ Oferă o cafea</a>
  </footer>
</main>

<script>
const data=${JSON.stringify(report)};
const content=document.getElementById("content");
const fmtDomain=u=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch{return""}};
// Pluralizare pentru badge-ul de surse
const pluralize=(n,s,p)=>n===1?s:p;

// Entities
const entitiesHTML=data.entities.map(e=>{
  if(!e.subjects.length)return "";
  
  const cards=e.subjects.map(s=>{
    const mainLink = s.items[0].link; // Prima știre din grup
    const isViral = s.isViral;
    
    // Lista de știri din grup
    const listItems = s.items.slice(0, isViral ? 5 : 3).map(it=>
      \`<li><a href="\${it.link}" target="_blank" title="\${it.title}">\${it.title}</a> <span>\${fmtDomain(it.link)}</span></li>\`
    ).join("");
    
    // Imaginea (Thumbnail)
    const thumbSrc = s.thumbnail;
    const thumbHTML = thumbSrc 
      ? \`<a href="\${mainLink}" target="_blank" class="thumb-wrap"><img src="\${thumbSrc}" class="thumb" loading="lazy" alt="Imagine de fundal pentru știre" onerror="this.style.display='none'"/></a>\` 
      : '';
    
    // Badges (Etichete)
    const badges = [];
    if(s.isViral) badges.push('<span class="badge badge-viral">Viral</span>');
    badges.push(\`<span class=\"badge\">\${s.sourceDiversity} \${pluralize(s.sourceDiversity, 'sursă', 'surse')}</span>\`);
    
    return \`
    <div class="card \${isViral ? 'card--viral' : ''}">
      \${thumbHTML}
      <div class="body">
        <div class="meta">\${badges.join("")}</div>
        <h3><a href="\${mainLink}" target="_blank">\${s.titlu_ro}</a></h3>
        \${s.context_ro ? \`<div class="context">\${s.context_ro}</div>\` : ''}
        <div class="summary">\${s.sumar_ro}</div>
        <ul class="sources">\${listItems}</ul>
      </div>
    </div>\`;
  }).join("");

  return \`<section><h2>\${e.name}</h2><div class="grid">\${cards}</div></section>\`;
}).join("");

// Other News
const otherNewsHTML = data.otherNews && data.otherNews.length ? \`
  <section class="other-section">
    <h2 style="margin-top:0">Alte Știri de Interes</h2>
    <div class="other-list">
      \${data.otherNews.map(item => \`
        <div class="other-item">
          \${item.thumbnail ? \`<img src="\${item.thumbnail}" class="other-thumb" loading="lazy" alt="" />\` : ''}
          <div class="other-content">
            <div class="other-title"><a href="\${item.link}" target="_blank">\${item.title}</a></div>
            <div class="other-meta">\${fmtDomain(item.link)}</div>
          </div>
        </div>
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
    console.error("❌ OPENAI_API_KEY required. Please set the OPENAI_API_KEY environment variable."); 
    process.exit(1); 
  }
  
  try {
    const report = await buildReport();
    const html = generateHTML(report);
    
    // Write report to public directory
    await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
    await fs.promises.writeFile(path.join(CONFIG.outDir, "index.html"), html, "utf-8");
    
    console.log(`\n✅ Raportul HTML a fost salvat în: ${path.join(CONFIG.outDir, "index.html")}`);
    console.log(`📊 Statistici:`);
    console.log(`   - Entități procesate: ${report.entities.length}`);
    console.log(`   - Știri în plus (Alte Știri): ${report.otherNews?.length || 0}`);
  } catch(e) {
    console.error("\n❌ EROARE FATALĂ în timpul generării raportului:", e);
    process.exit(1);
  }
}

main().catch(err => { 
  console.error("❌ Eroare Generală:", err); 
  process.exit(1); 
});
