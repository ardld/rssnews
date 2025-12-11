import fs from "fs";
import path from "path";
import axios from "axios";
import { JSDOM } from "jsdom";

/** =============================================
 *  Minimal Working Configuration
 *  ============================================= */
const CONFIG = {
  api: {
    timeout: 20000,
    maxRetries: 2,
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
    ]
  },
  filters: {
    timeWindowHours: 48, // Wider window for testing
    maxArticlesPerEntity: 20,
  },
  paths: {
    outDir: path.join(process.cwd(), "public"),
    cacheDir: path.join(process.cwd(), ".cache"),
  },
};

const OUT_HTML = path.join(CONFIG.paths.outDir, "index.html");
const OUT_JSON = path.join(CONFIG.paths.outDir, "data.json");

/** =============================================
 *  RSS Feed Integration - SIMPLIFIED
 *  ============================================= */
async function fetchAllRSSFeeds() {
  console.log("📡 Fetching RSS feeds...");
  const allItems = [];
  
  for (const feedUrl of CONFIG.rss.feeds) {
    try {
      console.log(`  Fetching: ${feedUrl}`);
      const response = await axios.get(feedUrl, { 
        timeout: CONFIG.api.timeout,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContextPolitBot/1.0)' }
      });
      
      const data = response.data;
      const itemMatches = data.matchAll(/<item>([\s\S]*?)<\/item>/g);
      
      for (const match of itemMatches) {
        const itemContent = match[1];
        
        const extract = (regex) => {
          const m = itemContent.match(regex);
          return m ? (m[1] || m[2] || '').replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim() : '';
        };
        
        const title = extract(/<title>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/title>)/s);
        const link = extract(/<link>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/link>)/s);
        const description = extract(/<description>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/description>)/s);
        const pubDate = extract(/<pubDate>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/pubDate>)/s);
        
        // Extract thumbnail - simple version
        let thumbnail = null;
        const imgMatch = description.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (imgMatch) thumbnail = imgMatch[1];
        
        const cleanSnippet = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (title && link) {
          allItems.push({
            title,
            link: link.replace(/&utm_.*/g, '').split('#')[0],
            source: new URL(link).hostname.replace('www.', ''),
            date: pubDate,
            snippet: cleanSnippet || title,
            thumbnail,
          });
        }
      }
      
      console.log(`    ✓ Got ${allItems.length} items so far`);
    } catch (err) {
      console.error(`    ❌ Failed ${feedUrl}: ${err.message}`);
    }
  }
  
  console.log(`✓ Total items: ${allItems.length}`);
  return allItems;
}

/** =============================================
 *  Date Filter - SIMPLIFIED
 *  ============================================= */
function withinTimeWindow(dateStr) {
  if (!dateStr) return true; // Accept if no date
  
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    const hoursDiff = (Date.now() - d.getTime()) / (1000 * 60 * 60);
    return hoursDiff <= CONFIG.filters.timeWindowHours;
  }
  
  // Try relative time
  const s = String(dateStr).toLowerCase();
  const match = s.match(/([0-9]{1,3})\s*(minute|min|minut|ore|ora|oră|hours|hour|h|zile|zi|day|days)/);
  if (match) {
    const val = parseInt(match[1], 10);
    const unit = match[2];
    let hours = 0;
    if (/min/.test(unit)) hours = val / 60;
    else if (/ora|oră|ore|hour|hours|h/.test(unit)) hours = val;
    else if (/zi|zile|day/.test(unit)) hours = val * 24;
    return hours <= CONFIG.filters.timeWindowHours;
  }
  
  return true; // Default accept
}

function domainOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** =============================================
 *  Entity Queries - SIMPLIFIED
 *  ============================================= */
const ENTITY_ORDER = ["guvern", "parlament", "putere", "opozitie", "presedintie", "local"];

const QUERIES = {
  "presedintie": ["președinte Iohannis", "președinte", "Klaus Iohannis"],
  "guvern": ["guvern", "premier", "ministru"],
  "parlament": ["parlament", "deputat", "senator"],
  "putere": ["PSD", "PNL", "USR", "UDMR", "coaliție"],
  "opozitie": ["AUR", "George Simion", "SOS România"],
  "local": ["primar", "primărie", "consiliu județean"],
};

async function fetchEntityPool(name) {
  const queries = QUERIES[name] || [];
  if (!queries.length) return [];
  
  const allItems = await fetchAllRSSFeeds();
  const results = [];
  
  for (const query of queries) {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    for (const item of allItems) {
      const text = `${item.title} ${item.snippet}`.toLowerCase();
      if (keywords.every(kw => text.includes(kw))) {
        if (!results.some(r => r.link === item.link)) {
          results.push(item);
        }
      }
    }
  }
  
  return results;
}

/** =============================================
 *  Simple Clustering (NO GPT)
 *  ============================================= */
function simpleClustering(items) {
  // Group by shared keywords in titles
  const clusters = [];
  const used = new Set();
  
  for (let i = 0; i < items.length && clusters.length < 5; i++) {
    if (used.has(i)) continue;
    
    const titleWords = items[i].title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const cluster = [i];
    used.add(i);
    
    for (let j = i + 1; j < items.length && cluster.length < 5; j++) {
      if (used.has(j)) continue;
      
      const compareTitle = items[j].title.toLowerCase();
      const sharedWords = titleWords.filter(w => compareTitle.includes(w));
      
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
  
  // If we have items but no clusters, create one cluster with first 5 items
  if (clusters.length === 0 && items.length > 0) {
    clusters.push({
      label: "Știri de actualitate",
      indices: items.slice(0, 5).map((_, i) => i)
    });
  }
  
  return clusters.slice(0, 3);
}

/** =============================================
 *  HTML Generation
 *  ============================================= */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateContentHTML(report, when) {
  const entities = report.entities || [];
  
  if (!entities.length) {
    return `<div style="padding:20px;background:#f8d7da;border:2px solid #dc3545;margin:20px 0;">
      <h2>⚠️ Error: No content found</h2>
      <p>Possible issues:</p>
      <ol>
        <li>RSS feeds returned no articles within the time window</li>
        <li>All feeds are unreachable (check network/errors above)</li>
        <li>Entity queries matched nothing</li>
      </ol>
      <p><strong>Try:</strong> Check the build logs above for "✓ Got X items" messages</p>
    </div>`;
  }
  
  return entities.map(e => {
    const subs = e.subjects || [];
    if (!subs.length) return '';
    
    const cards = subs.map(s => {
      const items = (s.items || []).slice(0, 5).map(it => 
        `<li>
          <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a>
          <span style="font-size:11px;color:#666;margin-left:8px;">${esc(it.source)}</span>
        </li>`
      ).join('');
      
      const sum = s.sumar_ro ? `<p style="color:#555;margin:8px 0;">${esc(s.sumar_ro)}</p>` : '';
      
      const thumbnailHtml = s.thumbnail ? 
        `<div style="margin-bottom:10px;">
           <img src="${esc(s.thumbnail)}" style="max-width:100%;height:auto;border:1px solid #ccc;" alt="">
           <p style="font-size:11px;color:#999;margin-top:4px;">sursa: ${esc(s.thumbnailSource || '')}</p>
         </div>` : '';
      
      return `
        <div style="border-bottom:2px solid #000;padding:15px 0;">
          ${thumbnailHtml}
          <h3 style="font-size:20px;margin:0 0 8px;">${esc(s.titlu_ro || s.label || 'Subiect')}</h3>
          ${sum}
          <ul style="margin:0;padding-left:20px;">${items}</ul>
        </div>`;
    }).join('');
    
    return `
      <section style="margin:30px 0;">
        <h2 style="background:#ffd400;display:inline-block;padding:5px 10px;border:2px solid #000;font-size:18px;font-weight:bold;margin:0 0 15px;text-transform:uppercase;">
          ${esc(e.name)}
        </h2>
        ${cards}
      </section>`;
  }).join('');
}

function baseHTML({ report }) {
  const when = new Date().toLocaleString("ro-RO");
  const contentHtml = generateContentHTML(report, when);
  
  return `<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CONTEXTPOLITIC.ro</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{font-family:Inter,system-ui,sans-serif;line-height:1.6;color:#000;max-width:1200px;margin:0 auto;padding:20px}
a{color:#000;text-decoration:none;border-bottom:2px solid #ffd400}
a:hover{border-bottom-color:#000}
</style>
</head>
<body>
  ${contentHtml}
  <footer style="margin-top:40px;padding-top:20px;border-top:2px solid #000;text-align:center;font-size:12px;">
    <p>Generat la: ${when}</p>
  </footer>
</body>
</html>`;
}

/** =============================================
 *  Build Pipeline - MINIMAL
 *  ============================================= */
async function buildData() {
  console.log("\n🚀 Starting MINIMAL report generation...");
  
  const pools = {};
  for (const name of ENTITY_ORDER) {
    console.log(`\n📥 Fetching: ${name}`);
    const raw = await fetchEntityPool(name);
    console.log(`   Raw count: ${raw.length}`);
    
    const filtered = raw.filter(x => withinTimeWindow(x.date)).slice(0, 20);
    console.log(`   After date filter: ${filtered.length}`);
    
    pools[name] = filtered;
  }

  console.log("\n📊 Creating entities...");
  const entities = [];
  
  for (const name of ENTITY_ORDER) {
    const items = pools[name] || [];
    if (!items.length) {
      console.log(`  ⊘ ${name}: No items`);
      continue;
    }
    
    console.log(`  ${name}: ${items.length} items, creating clusters...`);
    const clusters = simpleClustering(items);
    console.log(`  ${name}: ${clusters.length} clusters created`);
    
    const subjects = clusters.map(cl => {
      const subset = cl.indices.map(i => items[i]).filter(Boolean);
      return {
        label: cl.label,
        titlu_ro: subset[0]?.title || "Subiect",
        sumar_ro: subset[0]?.snippet?.substring(0, 150) || "",
        items: subset,
        thumbnail: subset[0]?.thumbnail || null,
        thumbnailSource: subset[0]?.source || '',
      };
    });
    
    if (subjects.length) {
      entities.push({ name, subjects });
      console.log(`  ✓ ${name}: ${subjects.length} subjects added`);
    }
  }

  const report = { 
    generatedAt: new Date().toISOString(), 
    timezone: CONFIG.misc.timezone, 
    entities,
    stats: {
      totalEntities: entities.length,
      totalSubjects: entities.reduce((sum, e) => sum + (e.subjects?.length || 0), 0)
    }
  };
  
  console.log(`\n✅ Done! ${report.stats.totalEntities} entities, ${report.stats.totalSubjects} subjects`);
  return report;
}

/** =============================================
 *  Main
 *  ============================================= */
async function run() {
  try {
    const report = await buildData();
    
    // Save JSON
    await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
    await fs.promises.writeFile(OUT_JSON, JSON.stringify(report, null, 2));
    
    // Generate and save HTML
    const html = baseHTML({ report });
    await fs.promises.writeFile(OUT_HTML, html, "utf-8");
    
    console.log(`\n✅ SUCCESS: ${OUT_HTML} written (${html.length} bytes)`);
    console.log(`📊 Content: ${report.stats.totalEntities} sections, ${report.stats.totalSubjects} stories`);
    
  } catch (err) {
    console.error("\n❌ FATAL ERROR:", err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });
}
