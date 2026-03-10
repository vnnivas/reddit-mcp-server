#!/usr/bin/env node
/**
 * Reddit MCP Server
 *
 * Provides tools to search Reddit posts, monitor subreddits, and track
 * discussions relevant to target communities. Designed for sales intelligence,
 * content monitoring, and community engagement workflows.
 *
 * Authentication: Uses Reddit OAuth2 "script" app type (no user interaction).
 * Requires: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosError } from "axios";

// ─── Constants ───────────────────────────────────────────────────────────────

const REDDIT_AUTH_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";
const USER_AGENT = "reddit-mcp-server/1.0.0 (MCP integration)";
const CHARACTER_LIMIT = 25000;

// ─── Auth State ──────────────────────────────────────────────────────────────

let accessToken: string | null = null;
let tokenExpiry: number = 0;

// ─── Reddit OAuth2 ──────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (accessToken && now < tokenExpiry) {
    return accessToken;
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error(
      "Missing Reddit credentials. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, and REDDIT_PASSWORD environment variables."
    );
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await axios.post(
    REDDIT_AUTH_URL,
    new URLSearchParams({
      grant_type: "password",
      username,
      password,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      timeout: 15000,
    }
  );

  accessToken = response.data.access_token;
  // Expire 60 seconds early to avoid edge cases
  tokenExpiry = now + (response.data.expires_in - 60) * 1000;
  return accessToken as string;
}

// ─── Reddit API Client ──────────────────────────────────────────────────────

async function redditGet<T>(
  endpoint: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const token = await getAccessToken();

  // Filter out undefined params
  const cleanParams: Record<string, string | number> = {};
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        cleanParams[key] = value;
      }
    }
  }

  const response = await axios.get(`${REDDIT_API_BASE}${endpoint}`, {
    params: cleanParams,
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
    timeout: 30000,
  });
  return response.data;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface RedditPost {
  kind: string;
  data: {
    id: string;
    title: string;
    selftext: string;
    author: string;
    subreddit: string;
    subreddit_name_prefixed: string;
    score: number;
    upvote_ratio: number;
    num_comments: number;
    created_utc: number;
    permalink: string;
    url: string;
    link_flair_text: string | null;
    is_self: boolean;
    over_18: boolean;
  };
}

interface RedditListing {
  kind: string;
  data: {
    children: RedditPost[];
    after: string | null;
    before: string | null;
    dist: number;
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(utc: number): string {
  return new Date(utc * 1000).toISOString().split("T")[0];
}

function timeAgo(utc: number): string {
  const now = Date.now() / 1000;
  const diff = now - utc;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function postToMarkdown(post: RedditPost["data"]): string {
  const lines: string[] = [];
  lines.push(`### ${post.title}`);
  lines.push(
    `📍 r/${post.subreddit} | ⬆️ ${post.score} | 💬 ${post.num_comments} comments | ${timeAgo(post.created_utc)}`
  );
  lines.push(`🔗 https://reddit.com${post.permalink}`);
  if (post.link_flair_text) {
    lines.push(`🏷️ Flair: ${post.link_flair_text}`);
  }
  if (post.selftext) {
    const truncated =
      post.selftext.length > 300
        ? post.selftext.slice(0, 300) + "..."
        : post.selftext;
    lines.push(`\n> ${truncated.replace(/\n/g, "\n> ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

function postToJson(post: RedditPost["data"]): Record<string, unknown> {
  return {
    id: post.id,
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    score: post.score,
    upvote_ratio: post.upvote_ratio,
    num_comments: post.num_comments,
    created_utc: post.created_utc,
    created_date: formatTimestamp(post.created_utc),
    time_ago: timeAgo(post.created_utc),
    permalink: `https://reddit.com${post.permalink}`,
    url: post.url,
    flair: post.link_flair_text,
    is_self: post.is_self,
    selftext_preview:
      post.selftext.length > 500
        ? post.selftext.slice(0, 500) + "..."
        : post.selftext,
  };
}

function handleApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      switch (error.response.status) {
        case 401:
          return "Error: Reddit authentication failed. Check your REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, and REDDIT_PASSWORD.";
        case 403:
          return "Error: Forbidden. Your Reddit app may not have the required scope, or the subreddit may be private.";
        case 404:
          return "Error: Subreddit not found. Check the spelling (no r/ prefix needed).";
        case 429:
          return "Error: Reddit rate limit exceeded. Wait a minute and try again.";
        default:
          return `Error: Reddit API returned status ${error.response.status}: ${JSON.stringify(error.response.data)}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request to Reddit timed out. Try again.";
    }
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

// ─── Enums ───────────────────────────────────────────────────────────────────

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

enum SortOption {
  HOT = "hot",
  NEW = "new",
  TOP = "top",
  RISING = "rising",
}

enum TimeFilter {
  HOUR = "hour",
  DAY = "day",
  WEEK = "week",
  MONTH = "month",
  YEAR = "year",
  ALL = "all",
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "reddit-mcp-server",
  version: "1.0.0",
});

// ─── Tool: reddit_get_posts ─────────────────────────────────────────────────

const GetPostsInputSchema = z
  .object({
    subreddit: z
      .string()
      .min(1)
      .max(50)
      .describe("Subreddit name without the r/ prefix (e.g., 'nursing')"),
    sort: z
      .nativeEnum(SortOption)
      .default(SortOption.HOT)
      .describe("Sort order: hot, new, top, rising"),
    time: z
      .nativeEnum(TimeFilter)
      .default(TimeFilter.WEEK)
      .describe(
        "Time filter for 'top' sort: hour, day, week, month, year, all"
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Number of posts to return (max 100)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: markdown or json"),
  })
  .strict();

type GetPostsInput = z.infer<typeof GetPostsInputSchema>;

server.registerTool(
  "reddit_get_posts",
  {
    title: "Get Subreddit Posts",
    description: `Fetch posts from a specific subreddit sorted by hot, new, top, or rising.

Use this to monitor target communities for recent discussions, pain points, and engagement opportunities.

Args:
  - subreddit (string): Subreddit name without r/ prefix (e.g., "nursing", "instructionaldesign")
  - sort (string): Sort order — "hot", "new", "top", "rising" (default: "hot")
  - time (string): Time filter for "top" sort — "hour", "day", "week", "month", "year", "all" (default: "week")
  - limit (number): Number of posts (1-100, default: 25)
  - response_format (string): "markdown" or "json" (default: "markdown")

Returns: List of posts with titles, scores, comment counts, permalinks, and text previews.`,
    inputSchema: GetPostsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: GetPostsInput) => {
    try {
      const endpoint =
        params.sort === SortOption.TOP
          ? `/r/${params.subreddit}/top`
          : `/r/${params.subreddit}/${params.sort}`;

      const listing = await redditGet<RedditListing>(endpoint, {
        limit: params.limit,
        t: params.sort === SortOption.TOP ? params.time : undefined,
      });

      const posts = listing.data.children;

      if (!posts.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No posts found in r/${params.subreddit} with sort=${params.sort}.`,
            },
          ],
        };
      }

      if (params.response_format === ResponseFormat.JSON) {
        const output = {
          subreddit: params.subreddit,
          sort: params.sort,
          time: params.time,
          count: posts.length,
          posts: posts.map((p) => postToJson(p.data)),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
      }

      const lines = [
        `# r/${params.subreddit} — ${params.sort} posts (${params.sort === "top" ? `past ${params.time}` : "current"})`,
        `*${posts.length} posts*\n`,
      ];
      for (const post of posts) {
        lines.push(postToMarkdown(post.data));
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n*[Output truncated]*";
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
      };
    }
  }
);

// ─── Tool: reddit_search_posts ──────────────────────────────────────────────

const SearchPostsInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(512)
      .describe("Search query (supports Reddit search syntax)"),
    subreddit: z
      .string()
      .max(50)
      .optional()
      .describe(
        "Limit search to a specific subreddit (without r/ prefix). Omit to search all of Reddit."
      ),
    sort: z
      .enum(["relevance", "new", "hot", "top", "comments"])
      .default("relevance")
      .describe("Sort results by: relevance, new, hot, top, comments"),
    time: z
      .nativeEnum(TimeFilter)
      .default(TimeFilter.WEEK)
      .describe("Time filter: hour, day, week, month, year, all"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Number of results (max 100)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: markdown or json"),
  })
  .strict();

type SearchPostsInput = z.infer<typeof SearchPostsInputSchema>;

server.registerTool(
  "reddit_search_posts",
  {
    title: "Search Reddit Posts",
    description: `Search Reddit posts by keyword, optionally limited to a specific subreddit.

Use this to find discussions about specific topics, pain points, competitors, or industry signals across target communities.

Args:
  - query (string): Search terms (e.g., "compliance training outdated", "LMS video content")
  - subreddit (string, optional): Limit to one subreddit (e.g., "nursing"). Omit for all of Reddit.
  - sort (string): Sort by "relevance", "new", "hot", "top", "comments" (default: "relevance")
  - time (string): Time filter — "hour", "day", "week", "month", "year", "all" (default: "week")
  - limit (number): Max results 1-100 (default: 25)
  - response_format (string): "markdown" or "json" (default: "markdown")

Returns: Matching posts with titles, scores, comment counts, permalinks, and text previews.`,
    inputSchema: SearchPostsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: SearchPostsInput) => {
    try {
      const endpoint = params.subreddit
        ? `/r/${params.subreddit}/search`
        : `/search`;

      const listing = await redditGet<RedditListing>(endpoint, {
        q: params.query,
        sort: params.sort,
        t: params.time,
        limit: params.limit,
        restrict_sr: params.subreddit ? "true" : undefined,
        type: "link",
      });

      const posts = listing.data.children;

      if (!posts.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No posts found for "${params.query}"${params.subreddit ? ` in r/${params.subreddit}` : ""}.`,
            },
          ],
        };
      }

      if (params.response_format === ResponseFormat.JSON) {
        const output = {
          query: params.query,
          subreddit: params.subreddit || "all",
          sort: params.sort,
          time: params.time,
          count: posts.length,
          posts: posts.map((p) => postToJson(p.data)),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
      }

      const lines = [
        `# Reddit Search: "${params.query}"${params.subreddit ? ` in r/${params.subreddit}` : ""}`,
        `*${posts.length} results | sort: ${params.sort} | time: ${params.time}*\n`,
      ];
      for (const post of posts) {
        lines.push(postToMarkdown(post.data));
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n*[Output truncated]*";
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
      };
    }
  }
);

// ─── Tool: reddit_get_comments ──────────────────────────────────────────────

const GetCommentsInputSchema = z
  .object({
    subreddit: z
      .string()
      .min(1)
      .max(50)
      .describe("Subreddit name without r/ prefix"),
    post_id: z
      .string()
      .min(1)
      .describe(
        "The post ID (the alphanumeric string from the post URL, e.g., '1j8k3f2')"
      ),
    sort: z
      .enum(["best", "top", "new", "controversial", "old"])
      .default("best")
      .describe("Comment sort order"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe("Number of top-level comments to return"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: markdown or json"),
  })
  .strict();

type GetCommentsInput = z.infer<typeof GetCommentsInputSchema>;

interface RedditComment {
  kind: string;
  data: {
    id: string;
    author: string;
    body: string;
    score: number;
    created_utc: number;
    permalink: string;
    is_submitter: boolean;
    depth: number;
    replies: RedditCommentListing | string;
  };
}

interface RedditCommentListing {
  kind: string;
  data: {
    children: RedditComment[];
  };
}

server.registerTool(
  "reddit_get_comments",
  {
    title: "Get Post Comments",
    description: `Fetch top-level comments from a specific Reddit post.

Use this to read the full discussion in a thread — understand community sentiment, find buyer language, or identify engagement opportunities.

Args:
  - subreddit (string): Subreddit name without r/ prefix
  - post_id (string): Post ID from the URL (e.g., for reddit.com/r/nursing/comments/1j8k3f2/..., the ID is "1j8k3f2")
  - sort (string): "best", "top", "new", "controversial", "old" (default: "best")
  - limit (number): Top-level comments to return, 1-50 (default: 20)
  - response_format (string): "markdown" or "json" (default: "markdown")

Returns: Top-level comments with author, score, body text, and timestamps.`,
    inputSchema: GetCommentsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: GetCommentsInput) => {
    try {
      const data = await redditGet<[RedditListing, RedditCommentListing]>(
        `/r/${params.subreddit}/comments/${params.post_id}`,
        {
          sort: params.sort,
          limit: params.limit,
        }
      );

      const postData = data[0]?.data?.children?.[0]?.data;
      const comments = data[1]?.data?.children?.filter(
        (c) => c.kind === "t1"
      );

      if (!comments || !comments.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No comments found on this post.",
            },
          ],
        };
      }

      if (params.response_format === ResponseFormat.JSON) {
        const output = {
          post_id: params.post_id,
          post_title: postData?.title || "Unknown",
          subreddit: params.subreddit,
          comment_count: comments.length,
          comments: comments.map((c) => ({
            id: c.data.id,
            author: c.data.author,
            score: c.data.score,
            created_utc: c.data.created_utc,
            created_date: formatTimestamp(c.data.created_utc),
            time_ago: timeAgo(c.data.created_utc),
            is_submitter: c.data.is_submitter,
            body:
              c.data.body.length > 500
                ? c.data.body.slice(0, 500) + "..."
                : c.data.body,
            permalink: `https://reddit.com${c.data.permalink}`,
          })),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
      }

      const lines = [
        `# Comments on: ${postData?.title || "Post " + params.post_id}`,
        `📍 r/${params.subreddit} | ${comments.length} top-level comments\n`,
      ];

      for (const c of comments) {
        const op = c.data.is_submitter ? " (OP)" : "";
        lines.push(
          `**u/${c.data.author}${op}** | ⬆️ ${c.data.score} | ${timeAgo(c.data.created_utc)}`
        );
        const body =
          c.data.body.length > 400
            ? c.data.body.slice(0, 400) + "..."
            : c.data.body;
        lines.push(`> ${body.replace(/\n/g, "\n> ")}`);
        lines.push("");
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n*[Output truncated]*";
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
      };
    }
  }
);

// ─── Tool: reddit_monitor_subreddits ────────────────────────────────────────

const MonitorInputSchema = z
  .object({
    subreddits: z
      .array(z.string().min(1).max(50))
      .min(1)
      .max(20)
      .describe(
        'List of subreddit names to scan (without r/ prefix, e.g., ["nursing", "instructionaldesign"])'
      ),
    keywords: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(20)
      .describe(
        'Keywords to filter for in post titles and body text (e.g., ["compliance", "training", "onboarding"])'
      ),
    time: z
      .nativeEnum(TimeFilter)
      .default(TimeFilter.WEEK)
      .describe("Time window to scan: hour, day, week, month"),
    limit_per_sub: z
      .number()
      .int()
      .min(5)
      .max(100)
      .default(50)
      .describe("Posts to scan per subreddit (default: 50)"),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe("Output format: markdown or json"),
  })
  .strict();

type MonitorInput = z.infer<typeof MonitorInputSchema>;

server.registerTool(
  "reddit_monitor_subreddits",
  {
    title: "Monitor Multiple Subreddits",
    description: `Scan multiple subreddits for posts matching specific keywords. Returns only posts whose title or body contain at least one keyword.

This is the primary tool for weekly Reddit intelligence digests — it scans target communities and filters for relevant discussions.

Args:
  - subreddits (string[]): List of subreddits to scan (e.g., ["nursing", "instructionaldesign", "humanresources"])
  - keywords (string[]): Keywords to match in post titles/body (e.g., ["compliance", "training", "onboarding", "policy", "video"])
  - time (string): Time window — "hour", "day", "week", "month" (default: "week")
  - limit_per_sub (number): Posts to fetch per subreddit, 5-100 (default: 50)
  - response_format (string): "markdown" or "json" (default: "markdown")

Returns: Filtered, keyword-matched posts grouped by subreddit with scores, comment counts, and links.`,
    inputSchema: MonitorInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: MonitorInput) => {
    try {
      const keywordsLower = params.keywords.map((k) => k.toLowerCase());
      const allMatches: Array<{
        subreddit: string;
        post: RedditPost["data"];
        matched_keywords: string[];
      }> = [];

      for (const sub of params.subreddits) {
        try {
          const listing = await redditGet<RedditListing>(`/r/${sub}/new`, {
            limit: params.limit_per_sub,
            t: params.time,
          });

          for (const post of listing.data.children) {
            const text = `${post.data.title} ${post.data.selftext}`.toLowerCase();
            const matched = keywordsLower.filter((kw) => text.includes(kw));
            if (matched.length > 0) {
              allMatches.push({
                subreddit: sub,
                post: post.data,
                matched_keywords: matched,
              });
            }
          }
        } catch {
          // Skip inaccessible subreddits silently
        }
      }

      // Sort by score descending
      allMatches.sort((a, b) => b.post.score - a.post.score);

      if (!allMatches.length) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No posts matching keywords [${params.keywords.join(", ")}] found in [${params.subreddits.map((s) => "r/" + s).join(", ")}] for the past ${params.time}.`,
            },
          ],
        };
      }

      if (params.response_format === ResponseFormat.JSON) {
        const output = {
          subreddits_scanned: params.subreddits,
          keywords: params.keywords,
          time: params.time,
          total_matches: allMatches.length,
          matches: allMatches.map((m) => ({
            ...postToJson(m.post),
            matched_keywords: m.matched_keywords,
          })),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
      }

      const lines = [
        `# Reddit Monitor: ${params.subreddits.length} subreddits × ${params.keywords.length} keywords`,
        `*${allMatches.length} matching posts | time: past ${params.time}*\n`,
      ];

      // Group by subreddit
      const bySub = new Map<string, typeof allMatches>();
      for (const match of allMatches) {
        const existing = bySub.get(match.subreddit) || [];
        existing.push(match);
        bySub.set(match.subreddit, existing);
      }

      for (const [sub, matches] of bySub) {
        lines.push(`## r/${sub} (${matches.length} matches)\n`);
        for (const m of matches) {
          lines.push(postToMarkdown(m.post));
          lines.push(
            `🔑 Matched keywords: ${m.matched_keywords.join(", ")}\n`
          );
        }
      }

      let text = lines.join("\n");
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + "\n\n*[Output truncated]*";
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: handleApiError(error) }],
      };
    }
  }
);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Reddit MCP server running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

