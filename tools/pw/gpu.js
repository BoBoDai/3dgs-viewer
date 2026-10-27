const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-proxy-server","--use-angle=metal","--enable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const url = process.argv[2];
  if (!url) {
    console.error("用法: node gpu.js <url>");
    process.exit(1);
  }
  await page.goto(url);
  await page.waitForFunction(() => window.__demo?.state.numSplats > 0, { timeout: 120000 });
  await page.waitForTimeout(6000);
  console.log(await page.evaluate(() => {
    const gl = window.__demo.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.VERSION),
             fps: document.getElementById("fps").textContent };
  }));
  await page.screenshot({ path: "/tmp/gpu.png" });
  await browser.close();
})();
