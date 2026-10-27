const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-proxy-server", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const logs = [];
  page.on("console", (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
  page.on("requestfailed", (req) =>
    logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`),
  );

  const url = process.argv[2];
  if (!url) {
    console.error("用法: node test.js <url> [screenshot]");
    process.exit(1);
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForFunction(
      () => window.__demo && window.__demo.state.numSplats > 0,
      { timeout: 90000 },
    );
  } catch (error) {
    console.log("MODEL NOT LOADED");
  }

  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const s = window.__demo?.state;
    return {
      numSplats: s?.numSplats,
      modelName: s?.modelName,
      baseScale: s?.baseScale,
      modelStatus: document.getElementById("model-status").textContent,
      handStatus: document.getElementById("hand-status").textContent,
      fps: document.getElementById("fps").textContent,
      gl: (() => {
        const gl = window.__demo?.renderer.getContext();
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.VERSION);
      })(),
    };
  });

  console.log(JSON.stringify(info, null, 2));
  console.log("--- console ---");
  console.log(logs.slice(0, 40).join("\n") || "(none)");

  await page.screenshot({ path: process.argv[3] || "/tmp/3dgs-test.png" });
  await browser.close();
})();
