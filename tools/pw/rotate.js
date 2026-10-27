const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server","--use-angle=metal","--enable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto("http://localhost:5173/?model=scene.ply");
  await page.waitForFunction(() => window.__demo?.state.numSplats > 0, { timeout: 120000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.__demo.state.targetRoll = 0.35; });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/rot-roll.png" });
  await page.evaluate(() => { window.__demo.state.targetRoll = 0; window.__demo.state.spin = true; });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "/tmp/rot-spin.png" });
  console.log(await page.evaluate(() => ({ roll: window.__demo.pivot.rotation.z, spin: window.__demo.holder.rotation.y, fps: document.getElementById("fps").textContent })));
  await browser.close();
})();
