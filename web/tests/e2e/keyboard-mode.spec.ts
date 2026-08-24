import { expect, test } from "@playwright/test";

test("keyboard mode starts without requesting the camera and runs every control", async ({ page }) => {
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices !== undefined) {
      const original = mediaDevices.getUserMedia.bind(mediaDevices);
      let requestCount = 0;
      Object.defineProperty(globalThis, "__cameraRequestCount", {
        get: () => requestCount,
        configurable: true,
      });
      mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints) => {
        requestCount += 1;
        return original(constraints);
      };
    }
  });

  const aiRequests: string[] = [];
  page.on("request", (request) => {
    if (/enet_b0|face_landmarker|generated\/(?:mediapipe|ort)/.test(request.url())) {
      aiRequests.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Emotion Runner" })).toBeVisible();
  expect(await page.evaluate(() => {
    const value: unknown = Reflect.get(globalThis, "__cameraRequestCount");
    return typeof value === "number" ? value : 0;
  })).toBe(0);
  await page.getByTestId("keyboard-mode").click();

  const canvas = page.getByTestId("game-canvas");
  await expect(canvas).toHaveAttribute("data-game-state", "playing");
  expect(aiRequests).toEqual([]);

  const initialY = Number(await canvas.getAttribute("data-player-y"));
  await page.keyboard.press("Space");
  await expect.poll(async () => Number(await canvas.getAttribute("data-player-y"))).toBeLessThan(initialY);

  await page.keyboard.press("KeyS");
  await expect(canvas).toHaveAttribute("data-boosting", "true");
  await page.keyboard.press("KeyA");
  await expect(canvas).toHaveAttribute("data-attacking", "true");
  await page.keyboard.press("KeyD");
  await expect(canvas).toHaveAttribute("data-shielded", "true");

  await page.keyboard.press("KeyP");
  await expect(canvas).toHaveAttribute("data-game-state", "paused");
  await page.keyboard.press("KeyP");
  await expect(canvas).toHaveAttribute("data-game-state", "playing");

  await page.keyboard.press("KeyM");
  await expect(page.locator("body")).toHaveAttribute("data-muted", "true");
});

test("high score survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("emotion-runner.web.high-score", JSON.stringify({ version: 1, highScore: 4321 }));
  });
  await page.reload();
  await page.getByTestId("keyboard-mode").click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-high-score", "4321");
});
