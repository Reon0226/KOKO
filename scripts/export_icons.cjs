// SVG アイコンを PNG に書き出す（PWA / iOS / Android 用）。Playwright の Chromium を使う。
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, '..', 'public', 'icons');
const jobs = [['icon.svg', 'icon-512.png', 512], ['icon.svg', 'icon-192.png', 192], ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512], ['icon-maskable.svg', 'icon-maskable-192.png', 192]];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(dir, src), 'utf8');
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}" style="display:block">`);
    await p.screenshot({ path: path.join(dir, out), omitBackground: true });
  }
  if (process.argv[2]) { // 確認用: 角丸・丸・マスカブル安全域で切り抜いた見本
    const svg = n => 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(dir, n)).toString('base64');
    await p.setViewportSize({ width: 760, height: 240 });
    await p.setContent(`<body style="margin:0;background:#888;display:flex;gap:20px;padding:20px">
      <img src="${svg('icon.svg')}" width="200">
      <img src="${svg('icon.svg')}" width="200" style="border-radius:50%">
      <div style="width:200px;height:200px;border-radius:50%;overflow:hidden;position:relative"><img src="${svg('icon-maskable.svg')}" width="250" style="position:absolute;left:-25px;top:-25px"></div></body>`);
    await p.screenshot({ path: process.argv[2] });
  }
  await b.close();
})();
