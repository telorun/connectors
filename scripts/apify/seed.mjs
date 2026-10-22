#!/usr/bin/env node
// Update apify/actors.yaml from the Apify Store.
//
// Candidates are the top 100 Store actors by total users plus every actor
// published by Apify itself (username `apify`). New candidates are added with
// `seeded: true`. Nothing is ever removed: a seeded entry that no longer
// qualifies is listed under "Dropped out" in the report so a human decides,
// and hand-added entries (no `seeded`) are never reported.
//
// The Store API cannot sort by total users, so the top 1000 by Store
// popularity are read and ranked locally.
//
// Usage: node scripts/apify/seed.mjs [--report <file>]
// Env:   APIFY_TOKEN (optional), APIFY_API_URL (optional)

import { apifyGet, emitReport, readActors, writeActors } from "./lib.mjs";

const TOP = 100;
const POOL = 1000;
const PAGE = 200;

const pool = new Map();
for (let offset = 0; offset < POOL; offset += PAGE) {
  const { items } = (await apifyGet(`/store?sortBy=popularity&limit=${PAGE}&offset=${offset}`)).data;
  for (const i of items) pool.set(`${i.username}/${i.name}`, i.stats?.totalUsers ?? 0);
  if (items.length < PAGE) break;
}
const top = [...pool.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, TOP)
  .map(([id]) => id);

const official = [];
for (let offset = 0; ; offset += PAGE) {
  const { items, total } = (await apifyGet(`/store?username=apify&limit=${PAGE}&offset=${offset}`)).data;
  official.push(...items.map((i) => `${i.username}/${i.name}`));
  if (items.length < PAGE || offset + PAGE >= total) break;
}

if (top.length < TOP || official.length === 0) {
  // A thin answer means the Store API misbehaved, not that every actor dropped out.
  throw new Error(`Store returned ${top.length} ranked and ${official.length} official actors — refusing to seed from that`);
}

const why = new Map();
for (const id of top) why.set(id, "top 100 by users");
for (const id of official) why.set(id, why.has(id) ? `${why.get(id)}, by Apify` : "by Apify");

const actors = readActors();
const added = [];
for (const id of [...why.keys()].sort()) {
  if (!(id in actors)) {
    actors[id] = { seeded: true };
    added.push(id);
  }
}
const droppedOut = Object.keys(actors)
  .filter((id) => actors[id].seeded && !why.has(id) && !actors[id].deprecated)
  .sort();

writeActors(actors);

const out = ["## Apify actor list", ""];
if (added.length) out.push(`### Added (${added.length})`, "", ...added.map((id) => `- \`${id}\` — ${why.get(id)}`), "");
if (droppedOut.length) {
  out.push(
    `### Dropped out (${droppedOut.length})`,
    "",
    "No longer in the top 100 and not published by Apify. Still generated — delete the entry from " +
      "`apify/actors.yaml` to stop, or remove `seeded: true` to keep it and stop this notice.",
    "",
    ...droppedOut.map((id) => `- \`${id}\``),
    "",
  );
}
out.push(`${Object.keys(actors).length} actor(s) listed.`, "");
emitReport(process.argv.slice(2), out.join("\n"));
