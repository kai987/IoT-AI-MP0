// @vitest-environment node

import { describe, expect, it } from "vitest";

import { withSocialPreview } from "./site-worker";

describe("Sites worker social metadata", () => {
  it("injects an absolute social preview URL from the trusted request origin", async () => {
    const response = new Response("<html><head></head><body></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const request = new Request("https://emotion-runner.example/game");

    const result = await withSocialPreview(response, request);
    const html = await result.text();

    expect(html).toContain(
      '<meta property="og:image" content="https://emotion-runner.example/og.png" />',
    );
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
  });

  it("passes non-HTML assets through without modification", async () => {
    const response = new Response("body{}", {
      headers: { "content-type": "text/css" },
    });
    const request = new Request("https://emotion-runner.example/app.css");

    await expect(withSocialPreview(response, request)).resolves.toBe(response);
  });
});
