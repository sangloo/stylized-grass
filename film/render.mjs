import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "out");

const preview = process.argv.includes("--preview");
const benchmark = process.argv.includes("--benchmark");
const clean = process.argv.includes("--clean");
const width = Number(process.env.FILM_WIDTH ?? 1920),
  height = Math.round((width * 9) / 16);
const fps = Number(process.env.FILM_FPS ?? 60);
const { server, url } = await serve();
let browser, encoder;
const errors = [];
try {
  const metal = process.platform === "darwin" || process.argv.includes("--metal");
  browser = await chromium.launch({
    headless: true,
    args: [
      "--ignore-gpu-blocklist",
      ...(metal ? ["--use-angle=metal", "--enable-gpu"] : []),
    ],
  });
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  page.on("console", (m) => {
    if (m.type() === "error") console.error(m.text());
  });
  await page.goto(`${url}/film/?capture${clean ? "&clean" : ""}`);
  await page.waitForFunction(
    () => window.film?.ready,
    {},
    { polling: 100, timeout: 120000 },
  );
  const duration = await page.evaluate(() => window.film.duration);
  const gpu = await page.evaluate(() => {
    const gl = window.film.field.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable";
  });
  const shots = resolve(out, "previews");
  await mkdir(shots, { recursive: true });
  if (benchmark) {
    console.log(
      await page.evaluate(() => {
        const gl = window.film.field.renderer.getContext();
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        return {
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unavailable",
        };
      }),
    );
    const started = performance.now();
    for (let i = 0; i < 10; i++) {
      await page.evaluate((t) => window.film.seek(t), 25 + i / fps);
      await page.screenshot({ type: "jpeg", quality: 95 });
    }
    console.log(
      `10 frames: ${((performance.now() - started) / 1000).toFixed(2)} seconds`,
    );
  } else if (preview) {
    const times = process.env.FILM_TIMES?.split(",").map(Number) ?? [
      0.1, 1.2, 2.6, 4, 6, 9.5, 11, 15, 18.2, 19.2, 20.2, 21.7, 22.4, 24, 25.2, 26.4,
      28.2, 29.4, 31, 33.5,
    ];
    for (const t of times) {
      const state = await page.evaluate((t) => window.film.seek(t), t);
      await page.screenshot({
        path: resolve(
          shots,
          `frame-${t.toFixed(1).padStart(4, "0").replace(".", "-")}.jpg`,
        ),
        type: "jpeg",
        quality: 92,
      });
      console.log(JSON.stringify(state));
    }
  } else {
    const output = resolve(out, clean ? "grass-film-clean.mp4" : "grass-film.mp4");
    encoder = spawn(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-r",
        String(fps),
        "-i",
        "-",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-threads",
        "4",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const done = once(encoder, "close");
    for (let i = 0; i < duration * fps; i++) {
      const state = await page.evaluate((t) => window.film.seek(t), i / fps);
      if (state.ground) throw new Error("Ground must remain hidden");
      const frame = await page.screenshot({ type: "jpeg", quality: 95 });
      if (!encoder.stdin.write(frame)) await once(encoder.stdin, "drain");
      if (i % (fps * 2) === 0)
        console.log(
          `Rendered ${i}/${duration * fps} frames (${(i / fps).toFixed(1)}s)`,
        );
    }
    encoder.stdin.end();
    const [code] = await done;
    if (code !== 0) throw new Error(`Encoder exited ${code}`);
    await writeFile(
      resolve(out, "render-report.json"),
      JSON.stringify(
        {
          output,
          width,
          height,
          fps,
          duration,
          frames: duration * fps,
          gpu,
          errors,
          ground: false,
          flowers: false,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(output);
  }
  if (errors.length) throw new Error(errors.join("\n"));
} finally {
  if (encoder && !encoder.stdin.writableEnded) encoder.kill();
  await browser?.close();
  await new Promise((r) => server.close(r));
}
