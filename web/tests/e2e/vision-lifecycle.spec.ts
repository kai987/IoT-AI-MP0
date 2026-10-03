import { expect, test } from "@playwright/test";

for (const viewport of [{ name: "desktop", width: 1280, height: 720 }, { name: "mobile", width: 390, height: 844 }]) {
test.describe(viewport.name, () => {
test.use({ viewport: { width: viewport.width, height: viewport.height } });
test("camera AI suspends in the background and resumes only with fresh inputs and diagnostics", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    let hidden = false;
    let submitted = 0;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(globalThis, "__visionFramesSubmitted", { get: () => submitted });
    Reflect.set(globalThis, "__setTestVisibility", (next: boolean) => {
      hidden = next;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const original: unknown = Reflect.get(Worker.prototype, "postMessage");
    if (typeof original !== "function") throw new Error("Worker postMessage is unavailable");
    Object.defineProperty(Worker.prototype, "postMessage", { value: function (this: Worker, message: unknown, transfer: Transferable[] = []) {
      if (typeof message === "object" && message !== null && Reflect.get(message, "type") === "FRAME") submitted += 1;
      Reflect.apply(original, this, [message, { transfer }]);
    } });
  });
  await page.goto("./");
  expect(await page.title()).toMatch(/Emotion Runner/);
  await page.getByTestId("camera-mode").click();
  const canvas = page.getByTestId("game-canvas");
  await expect(canvas).toHaveAttribute("data-game-state", "playing", { timeout: 45_000 });
  await page.getByText("処理時間・入力遅延", { exact: true }).click();
  await expect(page.getByLabel("表情入力の遅延統計")).toContainText(/P50 \/ P95/);
  await expect(page.locator(".vision-timings dd").nth(1)).toHaveText(/\d+ ms \/ \d+ ms/);
  await page.locator(".vision-timings").scrollIntoViewIfNeeded();
  const panelBox = await page.getByLabel("カメラと表情認識の状態").boundingBox();
  const stageBox = await page.getByLabel("Emotion Runner ゲーム画面").boundingBox();
  expect(panelBox).not.toBeNull();
  expect(stageBox).not.toBeNull();
  expect((panelBox?.y ?? 0) + (panelBox?.height ?? 0)).toBeLessThan((stageBox?.y ?? 0) + (stageBox?.height ?? 0) * 0.85);
  await page.screenshot({ path: testInfo.outputPath("vision-diagnostics.png"), fullPage: true });

  const atPause = await page.evaluate(() => {
    const setVisibility = Reflect.get(globalThis, "__setTestVisibility") as (hidden: boolean) => void;
    setVisibility(true);
    return Reflect.get(globalThis, "__visionFramesSubmitted") as number;
  });
  await expect(canvas).toHaveAttribute("data-game-state", "paused");
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => Reflect.get(globalThis, "__visionFramesSubmitted") as number)).toBe(atPause);
  await page.evaluate(() => {
    const setVisibility = Reflect.get(globalThis, "__setTestVisibility") as (hidden: boolean) => void;
    setVisibility(false);
  });
  await expect.poll(() => page.evaluate(() => Reflect.get(globalThis, "__visionFramesSubmitted") as number)).toBeGreaterThan(atPause);
  await expect(canvas).toHaveAttribute("data-game-state", "paused");
  await page.keyboard.press("KeyP");
  await expect(canvas).toHaveAttribute("data-game-state", "playing");
  await page.getByRole("button", { name: "カメラを停止", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await expect.poll(() => page.workers().length).toBe(0);
  expect(await page.locator("vite-error-overlay").count()).toBe(0);
  expect(errors).toEqual([]);
});
});
}
