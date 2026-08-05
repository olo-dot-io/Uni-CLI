---
title: Pipeline steps
description: Built-in actions available to YAML adapters, with common shapes and the complete current action list.
---

# Pipeline steps

A YAML pipeline passes the output of each action to the next. Uni-CLI currently has <span><!-- STATS:pipeline_step_count -->113<!-- /STATS --></span> built-in actions.

The total includes <span><!-- STATS:pipeline_registered_step_count -->58<!-- /STATS --></span> registered pipeline actions.

It also includes <span><!-- STATS:pipeline_transport_step_count -->55<!-- /STATS --></span> transport-native actions.

## Basic shape

```yaml
pipeline:
  - fetch:
      url: https://api.example.com/items
  - select: data.items
  - map:
      title: ${{ item.title }}
      url: ${{ item.url }}
  - limit: ${{ args.limit }}
```

## HTTP and content

| Action         | Purpose                                          |
| -------------- | ------------------------------------------------ |
| `fetch`        | Request JSON or another structured HTTP response |
| `fetch_text`   | Request raw text or HTML                         |
| `parse_rss`    | Parse RSS or Atom                                |
| `html_to_md`   | Convert HTML to Markdown                         |
| `download`     | Save a remote file                               |
| `oauth2-token` | Request and store an OAuth 2 token               |
| `websocket`    | Exchange messages over WebSocket                 |

```yaml
- fetch:
    url: https://api.example.com/search
    method: GET
    params:
      q: ${{ args.query }}
    headers:
      Accept: application/json
```

## Transform data

| Action       | Purpose                                |
| ------------ | -------------------------------------- |
| `select`     | Read a path from the current value     |
| `select-xml` | Select data from XML                   |
| `extract`    | Extract fields from HTML or DOM        |
| `map`        | Map each item to a new object          |
| `filter`     | Keep matching items                    |
| `sort`       | Sort a list                            |
| `limit`      | Keep the first N items                 |
| `to_entries` | Convert an object to key/value entries |
| `split_text` | Split text into parts                  |
| `set`        | Store a named value                    |
| `append`     | Add a value to a list                  |
| `assert`     | Validate a result condition            |

```yaml
- map:
    title: ${{ item.title }}
    author: ${{ item.by }}
- filter: item.title && !item.deleted
- sort:
    by: score
    order: desc
- limit: 10
```

## Control flow

| Action       | Purpose                               |
| ------------ | ------------------------------------- |
| `if`         | Run a branch when a condition matches |
| `each`       | Run a child pipeline for each item    |
| `parallel`   | Run independent branches concurrently |
| `rate_limit` | Pace work for one domain or resource  |
| `wait`       | Wait for time or a target condition   |

```yaml
- each:
    parallel: 4
    pipeline:
      - fetch:
          url: https://api.example.com/items/${{ item.id }}
```

## Browser

| Action      | Purpose                           |
| ----------- | --------------------------------- |
| `navigate`  | Open a URL                        |
| `evaluate`  | Run page JavaScript               |
| `click`     | Click a selected element          |
| `type`      | Enter text                        |
| `press`     | Send a key                        |
| `scroll`    | Scroll the page                   |
| `snapshot`  | Read a page snapshot and refs     |
| `tap`       | Activate a ref                    |
| `intercept` | Capture matching browser requests |

```yaml
- navigate:
    url: https://example.com
- snapshot:
    interactive: true
- click:
    selector: "#sign-in"
```

## Local and desktop orchestration

| Action       | Purpose                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `exec`       | Start an executable with an argv array                                            |
| `write_temp` | Create a temporary file for a later action                                        |
| `compute_*`  | Route snapshot, input, screenshot, assertion, and session actions through compute |

Common compute actions include `compute_snapshot`, `compute_find`, `compute_click`, `compute_type`, `compute_press`, `compute_scroll`, `compute_screenshot`, `compute_assert`, `compute_session_start`, `compute_session_state`, and `compute_session_end`.

```yaml
- exec:
    command: ffprobe
    args: ["-v", "quiet", "-print_format", "json", ${{ args.file }}]
    parse: json
    timeout: 30000
```

## Registered actions

The current registered action names are:

```text
append, assert, click, compute_apps, compute_assert, compute_cdp_attach,
compute_click, compute_drag, compute_evaluate, compute_find, compute_launch,
compute_observe, compute_point_click, compute_point_scroll, compute_press,
compute_screenshot, compute_scroll, compute_session_end,
compute_session_escalate, compute_session_start, compute_session_state,
compute_snapshot, compute_text, compute_type, compute_wait, compute_windows,
download, each, evaluate, exec, extract, fetch, fetch_text, filter,
html_to_md, if, intercept, limit, map, navigate, oauth2-token, parallel,
parse_rss, press, rate_limit, scroll, select, select-xml, set, snapshot,
sort, split_text, tap, to_entries, type, wait, websocket, write_temp
```

## Transport-native actions

Transport adapters also expose macOS AX, Windows UIA, Linux AT-SPI, clipboard, application, and visual actions. Their names include:

```text
applescript, ax_*, uia_*, atspi_*, clipboard_read, clipboard_write,
focus_window, launch_app, visual_*
```

These actions execute through the selected transport provider and its capability row. `src/engine/step-surface.ts` derives the complete live list from the registered step registry and transport handler tables.

## Templates

The most common values are:

| Expression          | Value                     |
| ------------------- | ------------------------- |
| `${{ args.name }}`  | Command argument          |
| `${{ item.field }}` | Field on the current item |
| `${{ index }}`      | Current list index        |
| `${{ env.NAME }}`   | Environment value         |

Step schemas live with their implementations under `src/engine/steps/`. Run `npm run lint:adapters` after editing a pipeline.
