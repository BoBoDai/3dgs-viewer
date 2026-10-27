const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: ["--no-proxy-server","--use-angle=metal","--enable-gpu",
      "--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream",
      "--use-file-for-fake-video-capture=/tmp/hand.y4m"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["camera"] });
  const page = await ctx.newPage();
  const model = process.argv[2] || "car.ply";
  await page.goto(`http://localhost:5173/?model=${model}`);
  await page.waitForFunction(() => window.__demo?.state.numSplats > 0, { timeout: 120000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `/tmp/show-${model.replace(".ply","")}-still.png` });
  await page.click("#btn-camera");
  await page.waitForFunction(() => document.getElementById("hand-status").textContent.includes("已跟踪"), { timeout: 60000 });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `/tmp/show-${model.replace(".ply","")}-hand.png` });
  console.log(await page.evaluate(() => ({
    fps: document.getElementById("fps").textContent,
    pivot: window.__demo.pivot.position.toArray().map(n => +n.toFixed(2)),
    scale: +window.__demo.holder.scale.x.toFixed(2),
    fov: +window.__demo.camera.fov.toFixed(1),
  })));
  await browser.close();
})();
