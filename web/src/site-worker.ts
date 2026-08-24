interface StaticAssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface SiteEnvironment {
  readonly ASSETS: StaticAssetBinding;
}

export function withSocialPreview(
  response: Response,
  request: Request,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    request.method === "HEAD" ||
    !contentType.toLowerCase().includes("text/html")
  ) {
    return Promise.resolve(response);
  }

  return response.text().then((html) => {
    const previewUrl = new URL("/og.png", request.url).href;
    const socialMetadata = [
      '<meta property="og:title" content="Emotion Runner" />',
      '<meta property="og:description" content="表情で駆ける、ローカルAIランナー" />',
      '<meta property="og:type" content="website" />',
      `<meta property="og:image" content="${previewUrl}" />`,
      '<meta name="twitter:card" content="summary_large_image" />',
      '<meta name="twitter:title" content="Emotion Runner" />',
      '<meta name="twitter:description" content="表情で駆ける、ローカルAIランナー" />',
      `<meta name="twitter:image" content="${previewUrl}" />`,
    ].join("\n    ");
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(
      html.replace("</head>", `    ${socialMetadata}\n  </head>`),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  });
}

export default {
  fetch(request: Request, environment: SiteEnvironment): Promise<Response> {
    return environment.ASSETS.fetch(request).then((response) =>
      withSocialPreview(response, request),
    );
  },
};
