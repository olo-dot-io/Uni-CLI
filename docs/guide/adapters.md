# Adapters

An adapter maps one site or tool to a set of CLI commands. Uni-CLI supports five adapter types, each optimized for a different integration surface.

## Adapter Types

| Type      | Surface              | Auth                    | Example Sites                |
| --------- | -------------------- | ----------------------- | ---------------------------- |
| `web-api` | HTTP APIs            | None, cookie, or header | hackernews, reddit, bilibili |
| `browser` | Full browser control | Chrome session          | chatgpt, notion, discord     |
| `desktop` | Local subprocess     | None                    | ffmpeg, imagemagick, blender |
| `bridge`  | Existing CLIs        | Passthrough             | gh, docker, vercel, yt-dlp   |
| `service` | WebSocket / HTTP     | API key or none         | ollama, obs-studio, comfyui  |

## YAML Format

Most adapters are ~20 lines of YAML. No imports, no build step, no runtime dependencies.

```yaml
site: example
name: command-name
type: web-api
strategy: public
pipeline:
  - fetch: { url: "https://api.example.com/data" }
  - select: "items"
  - map: { title: "${{ item.title }}", score: "${{ item.score }}" }
columns: [title, score]
```

## web-api — HTTP APIs

The most common type. Fetches data from REST APIs, transforms the response with pipeline steps.

### Public API (no auth)

```yaml
site: hackernews
name: top
description: Top stories from Hacker News
type: web-api
strategy: public
pipeline:
  - fetch:
      url: "https://hacker-news.firebaseio.com/v0/topstories.json"
  - limit: 30
  - each:
      parallel: 10
      pipeline:
        - fetch:
            url: "https://hacker-news.firebaseio.com/v0/item/${{ item }}.json"
  - map:
      title: "${{ item.title }}"
      score: "${{ item.score }}"
      by: "${{ item.by }}"
      url: "${{ item.url }}"
columns: [title, score, by, url]
```

### Cookie-authenticated API

```yaml
site: bilibili
name: feed
description: Personal feed (requires login)
type: web-api
strategy: cookie
pipeline:
  - fetch:
      url: "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd"
      params:
        ps: 20
  - select: "data.item"
  - map:
      title: "${{ item.title }}"
      author: "${{ item.owner.name }}"
      view: "${{ item.stat.view }}"
      url: "https://www.bilibili.com/video/${{ item.bvid }}"
columns: [title, author, view, url]
```

### Header-authenticated API (cookie + CSRF)

```yaml
site: twitter
name: timeline
description: Home timeline
type: web-api
strategy: header
pipeline:
  - fetch:
      url: "https://api.x.com/graphql/timeline"
      method: POST
      body:
        variables:
          count: 20
  - select: "data.home.timeline_items"
  - map:
      text: "${{ item.content.text }}"
      author: "${{ item.core.user.screen_name }}"
      likes: "${{ item.engagement.likes }}"
columns: [author, text, likes]
```

## browser — Full Browser Automation

For sites with no public API or heavy anti-bot protection. Drives Chrome via CDP.

### Intercept mode (capture network requests)

```yaml
site: xiaohongshu
name: trending
description: Trending posts
type: browser
strategy: intercept
pipeline:
  - navigate:
      url: "https://www.xiaohongshu.com/explore"
      waitUntil: networkidle
  - intercept:
      pattern: "**/api/sns/web/v1/homefeed"
      trigger: "scroll:down"
      timeout: 10000
  - select: "data.items"
  - map:
      title: "${{ item.note_card.title }}"
      likes: "${{ item.note_card.interact_info.liked_count }}"
columns: [title, likes]
```

### UI mode (interact with page elements)

```yaml
site: chatgpt
name: ask
description: Send a prompt to ChatGPT
type: browser
strategy: ui
args:
  - name: prompt
    required: true
    positional: true
pipeline:
  - navigate:
      url: "https://chatgpt.com"
  - wait: "#prompt-textarea"
  - click: "#prompt-textarea"
  - type:
      selector: "#prompt-textarea"
      text: "${{ args.prompt }}"
  - press: Enter
  - wait: 5000
  - snapshot: { interactive: false }
```

## desktop — Local Software

Runs local executables via subprocess. No network, no browser.

```yaml
site: ffmpeg
name: info
description: Show media file information
type: desktop
binary: ffmpeg
detect: "ffmpeg -version"
args:
  - name: file
    required: true
    positional: true
pipeline:
  - exec:
      cmd: "ffprobe"
      args:
        [
          "-v",
          "quiet",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          "${{ args.file }}",
        ]
      json: true
  - map:
      format: "${{ item.format.format_long_name }}"
      duration: "${{ item.format.duration }}"
      size: "${{ item.format.size }}"
      streams: "${{ item.streams.length }}"
columns: [format, duration, size, streams]
```

### Using write_temp for scripts

For tools that accept script files (GIMP Script-Fu, Blender Python):

```yaml
site: gimp
name: resize
description: Resize an image
type: desktop
binary: gimp
args:
  - name: file
    required: true
    positional: true
  - name: width
    required: true
    type: int
pipeline:
  - write_temp:
      ext: ".scm"
      content: |
        (let* ((image (car (gimp-file-load RUN-NONINTERACTIVE "${{ args.file }}" "${{ args.file }}")))
               (drawable (car (gimp-image-get-active-drawable image))))
          (gimp-image-scale-full image ${{ args.width }} 0 INTERPOLATION-CUBIC)
          (gimp-file-overwrite RUN-NONINTERACTIVE image drawable "${{ args.file }}" "${{ args.file }}"))
  - exec:
      cmd: "gimp"
      args:
        [
          "-i",
          "-b",
          '(gimp-script-fu-console-run 0 "${{ steps.write_temp.path }}")',
        ]
```

## bridge — CLI Passthrough

Wraps an existing CLI tool, parsing its output into structured data.

```yaml
site: gh
name: repos
description: List GitHub repositories
type: bridge
binary: gh
autoInstall: "brew install gh"
detect: "gh --version"
pipeline:
  - exec:
      cmd: "gh"
      args:
        [
          "repo",
          "list",
          "--json",
          "name,description,stargazerCount,updatedAt",
          "--limit",
          "20",
        ]
      json: true
  - map:
      name: "${{ item.name }}"
      description: "${{ item.description }}"
      stars: "${{ item.stargazerCount }}"
      updated: "${{ item.updatedAt }}"
columns: [name, stars, description, updated]
```

Bridge adapters can declare `autoInstall` — Uni-CLI will suggest the install command if the binary is missing.

## service — WebSocket and HTTP Services

For persistent connections to local or remote services.

```yaml
site: obs-studio
name: scene
description: Get current OBS scene
type: service
health: "http://localhost:4455"
pipeline:
  - websocket:
      url: "ws://localhost:4455"
      auth: obs
      send:
        op: 6
        d:
          requestType: GetCurrentProgramScene
          requestId: "1"
      receive:
        match: { "d.requestId": "1" }
  - select: "d.responseData"
  - map:
      scene: "${{ item.sceneName }}"
      uuid: "${{ item.sceneUuid }}"
columns: [scene, uuid]
```

## TypeScript Adapters

For complex logic that exceeds what YAML can express, use TypeScript:

```typescript
import { cli, Strategy } from "../../registry.js";

cli({
  site: "example",
  name: "search",
  description: "Search with pagination",
  strategy: Strategy.COOKIE,
  args: [
    { name: "query", required: true, positional: true },
    { name: "page", type: "int", default: 1 },
  ],
  func: async (page, kwargs) => {
    const resp = await fetch(
      `https://api.example.com/search?q=${kwargs.query}&p=${kwargs.page}`,
    );
    const data = await resp.json();
    return data.results.map((r: Record<string, unknown>) => ({
      title: r.title,
      url: r.url,
    }));
  },
});
```

TypeScript adapters use the `cli()` helper from the registry. They have full access to the `IPage` interface for browser automation.

## File Locations

| Location                              | Purpose                           |
| ------------------------------------- | --------------------------------- |
| `src/adapters/<site>/`                | Built-in adapters (ship with npm) |
| `~/.unicli/adapters/<site>/`          | User-local overrides              |
| `~/.unicli/adapters/<site>/<cmd>.yml` | Single command override           |

User-local adapters take precedence over built-in ones. This is how self-repair works — an agent edits the YAML in `~/.unicli/adapters/`, and the fix survives `npm update`.

## Arguments

Adapters declare arguments in the `args` field:

```yaml
args:
  - name: query
    required: true
    positional: true # unicli site cmd "my query"
    description: Search term
  - name: limit
    type: int
    default: 20
    description: Max results
  - name: sort
    choices: [hot, new, top]
    default: hot
```

| Field         | Type     | Description                      |
| ------------- | -------- | -------------------------------- |
| `name`        | string   | Argument name (becomes `--name`) |
| `type`        | string   | `str`, `int`, `float`, or `bool` |
| `required`    | boolean  | Fail if missing                  |
| `positional`  | boolean  | Can be passed without `--name`   |
| `default`     | any      | Default value                    |
| `choices`     | string[] | Allowed values                   |
| `description` | string   | Help text                        |
