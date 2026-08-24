import { expect, test } from "@playwright/test";

test("camera denial is recoverable and keyboard mode remains available", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: () => Promise.resolve([]),
        getUserMedia: () => Promise.reject(
          new DOMException("Permission denied for test", "NotAllowedError"),
        ),
      },
    });
  });
  await page.goto("/");
  await page.getByTestId("camera-mode").click();
  await expect(page.getByRole("alert")).toContainText("カメラ");
  await page.getByRole("button", { name: "キーボードで続ける" }).click();
  await expect(page.getByTestId("game-canvas")).toHaveAttribute("data-game-state", "playing");
});
