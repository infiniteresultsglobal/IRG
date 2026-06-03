#!/usr/bin/env node
/**
 * INFINETT Daily Store Audit
 * Fetches all Shopify products, auto-fixes brand consistency issues,
 * pulls last-24h order stats, and writes a markdown report.
 *
 * Required env vars:
 *   SHOPIFY_STORE_DOMAIN  — e.g. shopinfinettcom.com
 *   SHOPIFY_ADMIN_TOKEN   — Admin API access token (read_products + write_products + read_orders)
 */

import fs from 'fs';

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'shopinfinettcom.com';
const ADMIN_TOKEN  = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION  = '2024-01';
const BASE         = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}`;

const BRAND_VENDOR = 'INFINETT';
const BRAND_TAG    = 'INFINETT';

// Titles that contain these strings are intentionally archived as coming-soon drops
const COMING_SOON_MARKERS = ['COMING SOON', 'coming soon'];

// ─── Shopify helpers ────────────────────────────────────────────────────────

async function shopifyGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN },
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return { data: await res.json(), headers: res.headers };
}

async function shopifyPut(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function getAllProducts() {
  const products = [];
  let url = `/products.json?limit=250&fields=id,title,vendor,product_type,tags,status`;

  while (url) {
    const { data, headers } = await shopifyGet(url);
    products.push(...data.products);

    url = null;
    const link = headers.get('Link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (next) {
      const parsed = new URL(next[1]);
      url = parsed.pathname.replace(`/admin/api/${API_VERSION}`, '') + parsed.search;
    }
  }
  return products;
}

async function getOrderStats() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await shopifyGet(
      `/orders.json?status=any&created_at_min=${since}&limit=250&fields=id,total_price,financial_status`
    );
    const orders = data.orders || [];
    const revenue = orders
      .filter(o => o.financial_status !== 'voided' && o.financial_status !== 'refunded')
      .reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
    return { count: orders.length, revenue };
  } catch {
    return { count: null, revenue: null };
  }
}

// ─── Audit logic ─────────────────────────────────────────────────────────────

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map(t => t.trim()).filter(Boolean);
  return (raw || '').split(',').map(t => t.trim()).filter(Boolean);
}

function isComingSoon(product) {
  return COMING_SOON_MARKERS.some(m => product.title.includes(m));
}

async function auditProducts(products) {
  const fixed    = [];
  const warnings = [];
  let   active   = 0;
  let   archived = 0;
  let   draft    = 0;

  for (const p of products) {
    const tags = parseTags(p.tags);

    // Intentionally archived coming-soon items — skip silently
    if (isComingSoon(p) && p.status === 'archived') {
      archived++;
      continue;
    }

    if (p.status === 'active')   active++;
    else if (p.status === 'archived') archived++;
    else if (p.status === 'draft')    draft++;

    const updates    = {};
    const fixDetails = [];

    // 1. Wrong vendor
    if (p.vendor !== BRAND_VENDOR) {
      updates.vendor = BRAND_VENDOR;
      fixDetails.push(`vendor "${p.vendor}" → "${BRAND_VENDOR}"`);
    }

    // 2. Missing INFINETT tag
    if (!tags.includes(BRAND_TAG)) {
      updates.tags = [...tags, BRAND_TAG].join(', ');
      fixDetails.push(`added tag "${BRAND_TAG}"`);
    }

    // 3. Missing product type on active products (warn only — can't guess)
    if (!p.product_type && p.status === 'active') {
      warnings.push({ title: p.title, issue: 'missing product type — assign manually in Shopify' });
    }

    // Apply auto-fixes
    if (Object.keys(updates).length > 0) {
      try {
        await shopifyPut(`/products/${p.id}.json`, { product: updates });
        fixed.push({ title: p.title, details: fixDetails });
      } catch (err) {
        warnings.push({ title: p.title, issue: `auto-fix failed: ${err.message}` });
      }
    }
  }

  return { active, archived, draft, fixed, warnings };
}

// ─── Report builder ──────────────────────────────────────────────────────────

function buildReport(audit, orders, date) {
  const { active, archived, draft, fixed, warnings } = audit;

  let md = `# 🏪 INFINETT Daily Store Report\n**${date}**\n\n`;

  // Sales snapshot
  md += `## 💰 Last 24 Hours\n`;
  if (orders.count === null) {
    md += `_Order data unavailable (add \`read_orders\` scope to your API token)_\n\n`;
  } else {
    md += `| Orders | Revenue |\n|---|---|\n`;
    md += `| ${orders.count} | $${orders.revenue.toFixed(2)} USD |\n\n`;
  }

  // Product summary
  md += `## 📦 Product Status\n`;
  md += `| | Count |\n|---|---|\n`;
  md += `| Active | ${active} |\n`;
  md += `| Archived / Coming Soon | ${archived} |\n`;
  md += `| Draft | ${draft} |\n`;
  md += `| Auto-fixed today | ${fixed.length} |\n`;
  md += `| Warnings | ${warnings.length} |\n\n`;

  // Fixes
  if (fixed.length > 0) {
    md += `## 🔧 Auto-Fixed\n`;
    for (const f of fixed) {
      md += `- **${f.title}** — ${f.details.join(', ')}\n`;
    }
    md += '\n';
  }

  // Warnings
  if (warnings.length > 0) {
    md += `## ⚠️ Needs Manual Attention\n`;
    for (const w of warnings) {
      md += `- **${w.title}** — ${w.issue}\n`;
    }
    md += '\n';
  }

  // All clear
  if (fixed.length === 0 && warnings.length === 0) {
    md += `## ✅ Everything Looks Good\n`;
    md += `All active products have correct vendor, INFINETT tag, and product types.\n\n`;
  }

  md += `---\n*Auto-generated by INFINETT Store Audit · [Actions](https://github.com/ESPEUTN/IRG/actions)*`;
  return md;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!ADMIN_TOKEN) {
    console.error('❌  SHOPIFY_ADMIN_TOKEN is not set. Add it as a GitHub secret or .env file.');
    process.exit(1);
  }

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/New_York',
  });

  console.log(`\n🔍  Starting INFINETT store audit — ${date}\n`);

  const [products, orders] = await Promise.all([getAllProducts(), getOrderStats()]);
  console.log(`📦  ${products.length} products fetched`);

  const audit = await auditProducts(products);
  console.log(`✅  ${audit.fixed.length} auto-fixed  |  ⚠️  ${audit.warnings.length} warnings`);

  const report = buildReport(audit, orders, date);

  // Print to console
  console.log('\n' + report);

  // Write to GitHub Actions step summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
  }

  // Exit non-zero if manual attention needed (marks the Action as failed/warning)
  if (audit.warnings.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
