/**
 * requirements_inventory.js
 * Inventories all HTML reference files in requirements/ & legacy-demo/
 * and maps them to Next.js routes, components, and test coverage.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const REQ_DIR = path.join(ROOT_DIR, 'requirements');
const LEGACY_DIR = path.join(ROOT_DIR, 'legacy-demo');
const APP_DIR = path.join(ROOT_DIR, 'src', 'app');

function getFiles(dir, ext = '.html') {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getFiles(fullPath, ext));
    } else if (file.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

function runInventory() {
  console.log('================================================================');
  console.log('🔍 Mari Energies LMS — Repository & Requirements Inventory');
  console.log('================================================================\n');

  const legacyHtmlFiles = getFiles(LEGACY_DIR);
  console.log(`📁 Found ${legacyHtmlFiles.length} HTML reference screens in legacy-demo/:`);
  legacyHtmlFiles.forEach((f) => {
    const rel = path.relative(ROOT_DIR, f);
    console.log(`  - ${rel}`);
  });

  const masterReqFile = path.join(REQ_DIR, 'LMS_Land_Management_System_Demo_v3 Updated 10 Oct 2026.html');
  console.log(`\n📄 Master HTML Reference File:`);
  if (fs.existsSync(masterReqFile)) {
    const stats = fs.statSync(masterReqFile);
    console.log(`  - ${path.relative(ROOT_DIR, masterReqFile)} (${(stats.size / 1024).toFixed(1)} KB)`);
  } else {
    console.log(`  - Warning: Master reference file not found at expected path`);
  }

  // Scan Next.js routes
  const appRoutes = [];
  function scanApp(dir, routePrefix = '') {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const full = path.join(dir, item);
      if (fs.statSync(full).isDirectory()) {
        if (item.startsWith('(') && item.endsWith(')')) {
          scanApp(full, routePrefix);
        } else if (!item.startsWith('_')) {
          scanApp(full, `${routePrefix}/${item}`);
        }
      } else if (item === 'page.tsx' || item === 'page.jsx') {
        appRoutes.push(routePrefix === '' ? '/' : routePrefix);
      }
    }
  }
  scanApp(APP_DIR);

  console.log(`\n⚡ Next.js App Router Page Routes (${appRoutes.length} routes found):`);
  appRoutes.sort().forEach((r) => console.log(`  - ${r}`));

  // Mapping Matrix
  const mappingMatrix = [
    { route: '/login', ref: 'requirments/LMS_...html #login / legacy-demo/login', title: 'Enterprise Login Portal' },
    { route: '/dashboard', ref: 'legacy-demo/dashboard/index.html', title: 'Executive & Operational Dashboard' },
    { route: '/projects', ref: 'legacy-demo/projects/index.html', title: 'E&P Concession Projects' },
    { route: '/surveys', ref: 'legacy-demo/surveys/index.html', title: 'Cadastral Surveys & Land Records' },
    { route: '/landowners', ref: 'legacy-demo/landowners/index.html', title: 'Landowner Profiles & FBR WHT Status' },
    { route: '/cases', ref: 'legacy-demo/cases/index.html', title: 'Compensation Cases & 6-Tier SoD Pipeline' },
    { route: '/leases', ref: 'legacy-demo/leases/index.html', title: 'Surface Leases & Renewal Tracking' },
    { route: '/payments', ref: 'legacy-demo/payments/index.html', title: 'Finance Payments, Vouchers & Cheques' },
    { route: '/gis', ref: 'legacy-demo/gis/index.html', title: 'Interactive GIS Spatial Vector Map' },
    { route: '/reports', ref: 'legacy-demo/reports/index.html', title: 'Analytical & Regulatory Reports' },
    { route: '/requests', ref: 'legacy-demo/acquisitions/index.html', title: '4-Tier Land Acquisition Requests' },
    { route: '/dbpfc', ref: 'legacy-demo/dbpfc/index.html', title: 'District Price Committees & Rates' },
    { route: '/rows', ref: 'legacy-demo/rows/index.html', title: 'Pipeline Right-of-Way (ROW) Corridors' },
    { route: '/audit', ref: 'legacy-demo/audit/index.html', title: 'Immutable Tamper-Evident Audit Trail' },
  ];

  console.log('\n📋 Reference-to-Application Traceability Mapping:');
  console.table(mappingMatrix);

  return { legacyHtmlFiles, appRoutes, mappingMatrix };
}

if (require.main === module) {
  runInventory();
}

module.exports = { runInventory };
