const { chromium } = require("playwright");

// 用法：node track.js [/path/to/hand.y4m] [url]
// 第二个参数默认进 ?hand=1，自动开启摄像头和手部同步；不需要先加载模型。
const videoPath = process.argv[2] || "/tmp/hand.y4m";
const url = process.argv[3] || "http://localhost:5173/3dgs-viewer/?hand=1";

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-proxy-server",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${videoPath}`,
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1100, height: 720 },
    permissions: ["camera"],
  });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__hand?.tracker()?.landmarker, {
    timeout: 90000,
  });
  console.log("hand landmarker ready");

  await page.waitForFunction(() => window.__hand?.rig?.lastSeen > 0, {
    timeout: 60000,
  });
  console.log("hand detected");

  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    samples.push(
      await page.evaluate(() => {
        const rig = window.__hand.rig;
        return {
          status: document.getElementById("hand-status").textContent,
          fps: document.getElementById("fps").textContent,
          inferenceMs: +(window.__hand.tracker()?.lastMs || 0).toFixed(1),
          active: rig === window.__hand.fallback ? "fallback" : "skinned",
          model: rig.url || null,
          visibleModels: window.__hand.handRigs
            .flatMap((slot) => [slot.right, slot.left])
            .filter((r) => r.group.visible)
            .map((r) => r.url),
          debug: rig.debug,
          rootQ: rig.bones?.[0]?.quaternion.toArray().map((v) => +v.toFixed(2)),
          scale: +(rig.group.scale.x || 0).toFixed(2),
          position: rig.group.position.toArray().map((v) => +v.toFixed(2)),
        };
      }),
    );
    await page.waitForTimeout(700);
  }

  console.log(JSON.stringify(samples, null, 2));
  console.log("--- console ---");
  console.log(
    logs
      .filter((l) => !l.includes("GL Driver"))
      .slice(0, 25)
      .join("\n") || "(none)",
  );
  await page.screenshot({ path: "/tmp/3dgs-hand.png", timeout: 120000 });
  console.log("screenshot: /tmp/3dgs-hand.png");
  await browser.close();
})();
