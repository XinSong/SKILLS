const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

const RECURSIVE_HOSTS = new Set([
  "recursive.com",
  "www.recursive.com",
]);

const LANGCHAIN_HOSTS = new Set([
  "langchain.com",
  "www.langchain.com",
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
  recursive: {
    id: "generic-article",
    rootSelectors: [
      ".richtext",
    ],
    tryCardExpansion: false,
  },
  langchainBlog: {
    id: "generic-article",
    key: "langchain-blog",
    rootSelectors: [
      ".blog-post-content .w-richtext",
      ".text-rich-text-v2-blog-post.w-richtext",
    ],
    tryCardExpansion: false,
  },
};

export function resolveSiteAdapter(rawUrl, overrideId = null) {
  if (overrideId) {
    const adapter = Object.values(ADAPTERS).find(
      (candidate) => candidate.id === overrideId || candidate.key === overrideId,
    );
    if (!adapter) {
      throw new Error(`Unknown site adapter: ${overrideId}`);
    }
    return adapter;
  }

  const hostname = new URL(rawUrl).hostname.toLowerCase();
  if (X_HOSTS.has(hostname)) return ADAPTERS.x;
  if (LANGCHAIN_HOSTS.has(hostname)) return ADAPTERS.langchainBlog;
  if (RECURSIVE_HOSTS.has(hostname)) return ADAPTERS.recursive;
  return ADAPTERS.generic;
}
