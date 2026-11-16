# Live-update options for Notifications in Cadence

Research for [#5](https://github.com/inigocrespo/cohort-005-project/issues/5), part of the Notification inbox map ([#2](https://github.com/inigocrespo/cohort-005-project/issues/2)). This note sets out the options and what each one costs. It does not pick one. The freshness choice is still open on the map.

Researched 2026-11-16.

## The stack as it stands

- `react-router`, `@react-router/node`, `@react-router/serve` and `@react-router/dev` are all pinned at **8.3.0** (`package.json`). The current docs are 8.5.1. The pages cited below apply to v8.
- Framework mode with SSR: `ssr: true` in `react-router.config.ts`. `vite.config.ts` contains only the stock `reactRouter()` plugin, with no custom server.
- Production runs `react-router-serve ./build/server/index.js`, the built-in App Server. Dev runs `react-router dev`, the Vite dev server.
- Data lives in one SQLite file through `better-sqlite3` and Drizzle. The app runs as **one server process** and "cannot run on more than one machine against the same data" (`docs/adr/0006-one-sqlite-file-through-drizzle.md`).

## What React Router recommends

- **Revalidation is the default way to keep the UI fresh.** "In framework mode with SSR, route loaders are automatically revalidated after all navigations and form submissions." ([Route Module, `shouldRevalidate`](https://reactrouter.com/start/framework/route-module)) The state-management explainer describes "automatic synchronization through revalidation" and says the client is mostly a cache of server state ([State Management](https://reactrouter.com/explanation/state-management)).
- **`useRevalidator` is the hook for refreshes nobody triggered by acting.** The docs say it exists to "Revalidate the data on the page for reasons outside of normal data mutations like `Window` focus or polling on an interval." They also say it should not stand in for `Form`, `useFetcher` or `useSubmit` on normal mutations ([useRevalidator](https://reactrouter.com/api/hooks/useRevalidator)).
- **For SSE or WebSockets the docs give no guidance.** The resource-routes, state-management, App Server and adapter pages never mention either one. Resource routes may return any `Response`, so a streamed body is allowed ([Resource Routes](https://reactrouter.com/how-to/resource-routes)).

So polling is the only live-update technique the docs name, through `useRevalidator`. Anything past that, the docs leave to the app.

## Options

### 1. Page-load revalidation (the default)

The unread count and inbox come from a loader, for example the `layout.app.tsx` loader. Every navigation and form submission re-runs it automatically ([Route Module](https://reactrouter.com/start/framework/route-module)).

- **Complexity:** almost none. It is an ordinary loader that runs a synchronous Drizzle query.
- **Hosting:** none beyond what runs today.
- **Freshness:** a Notification shows up on the next navigation or action. A page left idle never updates.

### 2. Polling: `useRevalidator` or a fetcher on an interval

- **`useRevalidator().revalidate()`** on a `setInterval`, on window focus, or on `visibilitychange`. The docs name exactly these cases ([useRevalidator](https://reactrouter.com/api/hooks/useRevalidator)). Each call re-runs **all** active loaders on the page, not just the notification query. To keep a poll cheap, the other routes can opt out with `shouldRevalidate` ([Route Module](https://reactrouter.com/start/framework/route-module)).
- **`useFetcher().load("/notifications/unread")`** on an interval, against a resource route. This calls only that one loader, with no navigation ([useFetcher](https://reactrouter.com/api/hooks/useFetcher), [Resource Routes](https://reactrouter.com/how-to/resource-routes)).
- **Complexity:** low. It is a client effect plus, for the fetcher variant, one resource route. Nothing changes on the server.
- **Hosting:** none. Each poll is a normal short request, so it works under `react-router-serve` and any proxy or host.
- **Cost:** latency is bounded by the interval. Every open tab sends one request per interval. Each request is a cheap synchronous SQLite read, with no network round trip to a database (ADR 0006).

### 3. Server-Sent Events from a resource route

A resource-route `loader` returns a `Response` whose body is a `ReadableStream` with `Content-Type: text/event-stream`. The browser reads it with `EventSource`.

- **Protocol facts ([MDN, Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)):**
  - It is one-way, server to client. Marking a Notification read still goes through a normal action.
  - The browser reconnects on its own. The server can set `retry:`, and `id:` lets a reconnecting client resume from the last event.
  - Comment lines (`: keep-alive`) stop idle connections from timing out.
  - Over HTTP/1.1, browsers allow only **6 connections per browser and domain**, shared across all tabs. HTTP/2 negotiates about 100 streams.
- **Library option: `remix-utils` v10.0.1.** Its peer dependency is `react-router ^8.0.0`. It provides `eventStream(request.signal, setup)` for the resource route and `useEventSource(url, { event })` for components. The hook shares one connection per URL across components, because of the connection limit. Its README warns: "your server must support HTTP streaming" ([remix-utils README](https://github.com/sergiodxa/remix-utils#server-sent-events), [package.json](https://github.com/sergiodxa/remix-utils/blob/main/package.json)). `eventStream` forces `Cache-Control: no-cache` and `Connection: keep-alive` ([source](https://github.com/sergiodxa/remix-utils/blob/main/src/server/event-stream.ts)).
- **Does it work on the current server?** The code says yes. `react-router-serve` is Express with `compression()` enabled ([App Server docs](https://reactrouter.com/api/other-api/serve); `node_modules/@react-router/serve/dist/cli.js`). The `compression` README warns that it buffers SSE unless `res.flush()` is called ([compression README](https://github.com/expressjs/compression#server-sent-events)). In 8.3.0, though, the Express adapter handles both halves:
  - It calls `res.flushHeaders()` for `text/event-stream` responses (`node_modules/@react-router/express/dist/index.js`).
  - `writeReadableStreamToWritable` calls `flush()` after every chunk (`node_modules/@react-router/node/dist/index.js`).

  So no custom server is needed. This was verified by reading the source, not by a running test. One check is still worth doing in a prototype: that events arrive straight away under `react-router dev` and behind whatever proxy or host Cadence uses.
- **Fan-out:** SQLite has no LISTEN/NOTIFY. `sqlite3_update_hook` only fires on the [same connection](https://www.sqlite.org/c3ref/update_hook.html), and `better-sqlite3` does not expose it ([API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)). The stream therefore needs one of two triggers:
  - an in-process emitter that the code creating a Notification calls. This works only because ADR 0006 keeps Cadence to one process.
  - the stream polling SQLite on the server, which moves the polling onto the server but still sends updates straight away.
- **Complexity:** medium.
  - The server must hold long-lived connections and clean up on `request.signal` abort.
  - It needs keep-alives and resume or catch-up logic on reconnect.
  - Every open page holds one open connection.
  - `react-router-serve` purges the require cache per request when not in production, so module-scope emitters reset in that mode ([App Server docs](https://reactrouter.com/api/other-api/serve)).
- **Hosting:**
  - It needs HTTP streaming end to end, so proxies must not buffer it.
  - It ties fan-out to a single process. ADR 0006 already accepts that limit.
  - HTTP/2 at the edge avoids the 6-connection cap.

### 4. WebSockets

- **Hosting/complexity:** this is the highest-cost option.
  - `react-router-serve` calls `app.listen` and exposes nothing for an HTTP `upgrade`. The docs say it has no customization options "by design". Anyone who needs that must migrate to `@react-router/express` with their own `server.js` ([App Server docs](https://reactrouter.com/api/other-api/serve); [Adapter docs, migrating](https://reactrouter.com/8.3.0/api/other-api/adapter)).
  - That migration changes the `dev` and `start` scripts and `vite.config.ts`, and adds `express`, `compression` and `morgan`. A WebSocket library such as `ws` would then attach to the server, and dev mode needs the same handling.
  - Proxies and hosts must allow upgrades, and fan-out is still in-process.
- **What it buys:** a two-way channel. An inbox does not need it, because reading and dismissing a Notification are ordinary actions and SSE already covers server-to-client (MDN, above).

## Summary

| Option | Freshness | Complexity | Hosting constraints | Docs stance |
| --- | --- | --- | --- | --- |
| Page-load revalidation | Next navigation or action | None | None | The default, "automatic synchronization" |
| Polling (`useRevalidator` / fetcher) | Interval (for example 15–60 s), or on focus | Low | None | Named use case for `useRevalidator` |
| SSE (resource route, optionally `remix-utils`) | Near-instant | Medium | Streaming end to end; one process for fan-out (already true); HTTP/2 is better | Not covered; allowed through resource-route `Response` |
| WebSockets | Near-instant, two-way | High | Custom Express server (leave `react-router-serve`), upgrade-capable proxy | Not covered |

The options can be combined. For example, a page-load count plus revalidation on focus, with polling or SSE added later behind the same loader or resource route.

## Open questions for the freshness decision

- How stale can an unread count be before it matters for each kind of Notification, for example a Refund Request decided?
- Where Cadence is hosted. The answer settles whether streaming and HTTP/2 are available.
- Whether a prototype should confirm that SSE flushes under `react-router dev` and behind the production proxy.
