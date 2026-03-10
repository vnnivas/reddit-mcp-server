# Reddit MCP Server

An MCP server that connects to the Reddit API, letting Claude search posts, monitor subreddits, read comments, and scan multiple communities for keyword matches — all through structured tools.

## Setup (5 minutes)

### Step 1: Create a Reddit App

1. Go to [https://www.reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Click **"create another app..."** at the bottom
3. Fill in:
   - **name:** `framez-mcp` (or whatever you like)
   - **type:** Select **"script"**
   - **redirect uri:** `http://localhost:8080` (required but not used)
4. Click **Create app**
5. Note your **client ID** (the string under the app name) and **secret**

### Step 2: Add to Claude Desktop

Add this to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "reddit": {
      "command": "node",
      "args": ["/path/to/reddit-mcp-server/dist/index.js"],
      "env": {
        "REDDIT_CLIENT_ID": "your_client_id_here",
        "REDDIT_CLIENT_SECRET": "your_secret_here",
        "REDDIT_USERNAME": "your_reddit_username",
        "REDDIT_PASSWORD": "your_reddit_password"
      }
    }
  }
}
```

Replace `/path/to/reddit-mcp-server` with the actual path where you saved this folder.

### Step 3: Restart Claude Desktop

Close and reopen Claude Desktop. The Reddit tools should appear.

## Available Tools

| Tool | What it does |
|------|-------------|
| `reddit_get_posts` | Fetch posts from a subreddit (hot/new/top/rising) |
| `reddit_search_posts` | Search posts by keyword, optionally within a subreddit |
| `reddit_get_comments` | Read comments on a specific post |
| `reddit_monitor_subreddits` | Scan multiple subreddits for posts matching keywords |

## Usage Examples

**Weekly Framez digest:**
```
reddit_monitor_subreddits({
  subreddits: ["nursing", "instructionaldesign", "humanresources", "compliance", "healthIT", "elearning", "govtech"],
  keywords: ["compliance", "training", "onboarding", "policy", "video", "outdated", "audit", "LMS", "content update"],
  time: "week",
  limit_per_sub: 50
})
```

**Search for competitor mentions:**
```
reddit_search_posts({
  query: "Panopto OR Cornerstone OR Gong compliance training",
  time: "month",
  sort: "relevance"
})
```

**Read a specific discussion:**
```
reddit_get_comments({
  subreddit: "nursing",
  post_id: "1j8k3f2",
  sort: "best",
  limit: 30
})
```

## Rate Limits

Reddit allows 60 requests per minute for OAuth2 script apps. The monitor tool makes 1 request per subreddit, so scanning 7 subreddits uses 7 of your 60 requests.
# reddit-mcp-server