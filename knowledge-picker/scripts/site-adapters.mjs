const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

const ADAPTERS = {
  generic: {
    id: "generic-article",
    rootSelectors: [
      '[itemprop="articleBody"]',
      "main article",
      "article",
      'main [role="article"]',
      "main",
    ],
    tryCardExpansion: false,
  },
  x: {
    id: "x-article",
    rootSelectors: [
      'main [data-testid="twitterArticleReadView"]',
      'main [data-testid="article-content"]',
      "main article",
    ],
    tryCardExpansion: true,
  },
};

export function resolveSiteAdapter(rawUrl, overrideId = null) {
  if (overrideId) {
    const adapter = Object.values(ADAPTERS).find(
      (candidate) => candidate.id === overrideId,
    );
    if (!adapter) {
      throw new Error(`Unknown site adapter: ${overrideId}`);
    }
    return adapter;
  }

  const hostname = new URL(rawUrl).hostname.toLowerCase();
  return X_HOSTS.has(hostname) ? ADAPTERS.x : ADAPTERS.generic;
}
