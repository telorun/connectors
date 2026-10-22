// Rendering of one generated actor module: telo.yaml, docs/README.md and the
// CHANGELOG entry. Pure functions of the actor + build objects Apify returns,
// so a re-run over an unchanged build produces byte-identical files.

import YAML from "yaml";

import { convertDatasetItem, convertInputSchema, plainText } from "./convert.mjs";
import { moduleDirName, moduleName } from "./lib.mjs";

// The `run` module the Start kind's poll loop is built from. Bump with
// `telo upgrade` on the sample fixture, then copy the pinned line here.
export const RUN_IMPORT =
  "oci://ghcr.io/telorun/run@0.28.0#sha256-CoPkA-u8-m4kjQAOTDr_TmsfA72HDpnoZI-hHz8N7kE";

const TERMINAL = ["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"];

// Placeholders resolved into tagged scalars by `toYaml`.
const cel = (expr) => ({ __tag: "!cel", value: expr });
const ref = (name) => ({ __tag: "!ref", value: name });

/** Build a YAML document from plain data, turning `cel()` / `ref()` placeholders into tagged scalars. */
function toYaml(data) {
  const doc = new YAML.Document(data);
  YAML.visit(doc, {
    Map(_, node) {
      const tag = node.items.find((p) => p.key?.value === "__tag");
      if (!tag) return undefined;
      const value = node.items.find((p) => p.key?.value === "value").value.value;
      const scalar = doc.createNode(value);
      scalar.tag = tag.value.value;
      // A long expression goes in a folded block rather than a wrapped
      // double-quoted string; none of the generated expressions holds a
      // backslash, which a folded block would also keep intact.
      scalar.type = tag.value.value === "!ref" ? "PLAIN" : value.length > 80 ? "BLOCK_FOLDED" : "QUOTE_DOUBLE";
      return scalar;
    },
    Scalar(_, node, path) {
      if (node.tag || typeof node.value !== "string") return;
      const key = path.at(-1)?.key?.value;
      const prose = key === "description" || key === "title";
      if (node.value.includes("\n")) node.type = prose ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
      else if (node.value.length > 90) node.type = "BLOCK_FOLDED";
    },
  });
  return doc.toString({ lineWidth: 100, minContentWidth: 40 });
}

/** The current entry of an actor's pricing history (the latest that has started). */
export function currentPricing(act, now = new Date()) {
  const infos = (act.pricingInfos ?? []).filter((p) => !p.startedAt || new Date(p.startedAt) <= now);
  return infos.at(-1) ?? null;
}

/** One-line pricing summary for docs. */
export function pricingSummary(pricing) {
  if (!pricing || pricing.pricingModel === "FREE") {
    return "Free — you pay only for the Apify platform usage (compute units) of the run.";
  }
  switch (pricing.pricingModel) {
    case "FLAT_PRICE_PER_MONTH":
      return (
        `Rental — $${pricing.pricePerUnitUsd} per month after a ` +
        `${Math.round((pricing.trialMinutes ?? 0) / 1440)}-day trial, plus platform usage. ` +
        "The actor must be rented in the Apify Console before it can run."
      );
    case "PRICE_PER_DATASET_ITEM":
      return `Pay per result — $${pricing.pricePerUnitUsd} per ${pricing.unitName ?? "result"}. Cap it with \`maxItems\`.`;
    case "PAY_PER_EVENT": {
      const events = Object.values(pricing.pricingPerEvent?.actorChargeEvents ?? {});
      const parts = events.map((e) => {
        const price = e.eventPriceUsd ?? e.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd;
        return `${e.eventTitle}${price !== undefined ? ` $${price}` : ""}`;
      });
      return (
        `Pay per event — ${parts.join(", ") || "see the Store page"} (Free-plan prices; ` +
        "paid plans pay less). Cap the spend with `maxTotalChargeUsd`."
      );
    }
    default:
      return `${pricing.pricingModel} — see the Store page.`;
  }
}

/** The static run options both kinds accept, forwarded to every run. */
const RUN_OPTIONS = {
  timeout: {
    type: "integer",
    minimum: 0,
    description: "Run timeout in seconds. Defaults to the actor's own setting.",
  },
  memory: {
    type: "integer",
    minimum: 128,
    description: "Memory limit in megabytes (a power of 2). Defaults to the actor's own setting.",
  },
  maxItems: {
    type: "integer",
    minimum: 1,
    description: "Maximum number of dataset items the run may produce (and, for pay-per-result actors, be charged for).",
  },
  maxTotalChargeUsd: {
    type: "number",
    minimum: 0,
    description: "Spending cap in USD for pay-per-event actors.",
  },
};
const RUN_OPTION_NAMES = Object.keys(RUN_OPTIONS);

function kindSchema() {
  return {
    type: "object",
    required: ["client"],
    properties: {
      client: {
        "x-telo-ref": { kind: "Apify.ApifyClient", use: "dependency" },
        description: "The ApifyClient holding the API token the run is charged to.",
      },
      ...RUN_OPTIONS,
    },
  };
}

/**
 * The module's telo.yaml.
 * @param {object} o
 * @param {string} o.id        `user/name`
 * @param {object} o.act       GET /v2/acts/{id} → data
 * @param {object} o.build     GET /v2/acts/{id}/builds/default → data
 * @param {string} o.coreImport relative import of the core module
 */
export function renderManifest({ id, act, build, coreImport = "../apify" }) {
  const version = build.buildNumber;
  const title = plainText(act.title) ?? id;
  const inputSchema = convertInputSchema(
    typeof build.inputSchema === "string" ? JSON.parse(build.inputSchema) : build.inputSchema,
  );
  const item = convertDatasetItem(build.actorDefinition?.storages?.dataset?.fields);
  const about = plainText(act.description);

  const library = {
    kind: "Telo.Library",
    metadata: {
      name: moduleName(id),
      version,
      description:
        `${title}: the Apify actor ${id} (build ${version}) as typed Telo kinds. ` +
        "`Run` runs it and waits for its results (Apify allows up to 5 minutes); `Start` runs it in " +
        "the background and polls until it finishes, for runs of any length. Both take an " +
        "ApifyClient and the actor's own input, type-checked against the actor's input schema." +
        (about ? `\n${about}` : ""),
      repository: "https://github.com/telorun/connectors",
      license: "MIT",
    },
    imports: {
      Apify: coreImport,
      Flow: RUN_IMPORT,
    },
    exports: {
      kinds: ["Run", "Start", "Apify.ApifyClient"],
    },
  };

  // Declared once and referenced by both kinds — an actor schema can run to
  // hundreds of kilobytes (enums of every country, industry, …).
  const inputShape = {
    kind: "Telo.JsonSchema",
    metadata: { name: "Input", description: `The input of ${id}, from its build ${version} input schema.` },
    schema: inputSchema,
  };
  const itemShape = {
    kind: "Telo.JsonSchema",
    metadata: { name: "Item", description: `One dataset item ${id} produces.` },
    schema: item,
  };
  const inputType = ref("Input");
  const itemsSchema = { type: "array", description: "The run's dataset items.", items: ref("Item") };
  const forward = (scope) =>
    Object.fromEntries(RUN_OPTION_NAMES.map((k) => [k, cel(`${scope}.?${k}.orValue(null)`)]));

  const run = {
    kind: "Telo.Definition",
    metadata: {
      name: "Run",
      description: `Run ${title} and wait for its dataset items (runs of up to 5 minutes).`,
    },
    capability: "Telo.Invocable",
    schema: kindSchema(),
    inputType,
    outputType: {
      kind: "Telo.JsonSchema",
      schema: { type: "object", required: ["items"], properties: { items: itemsSchema } },
    },
    resources: [{ kind: "Apify.RunActorSync", metadata: { name: "run" }, client: cel("self.client") }],
    invoke: ref("run"),
    inputs: { actorId: id, build: version, input: cel("inputs"), ...forward("self") },
    result: { items: cel("result.body") },
  };

  const nullable = (t) => ({ type: [t, "null"] });
  const start = {
    kind: "Telo.Definition",
    metadata: {
      name: "Start",
      description:
        `Run ${title} in the background, poll until the run finishes, and return the run and its ` +
        "dataset items. Raises APIFY_RUN_NOT_SUCCEEDED when the run ends FAILED, TIMED-OUT or ABORTED.",
    },
    capability: "Telo.Invocable",
    throws: {
      codes: {
        APIFY_RUN_NOT_SUCCEEDED: {
          description: "The run finished without succeeding. `data` is the Apify run object (id, status, statusMessage, …).",
        },
      },
    },
    schema: kindSchema(),
    inputType,
    outputType: {
      kind: "Telo.JsonSchema",
      schema: {
        type: "object",
        required: ["run", "items"],
        properties: {
          run: {
            type: "object",
            additionalProperties: true,
            description: "The finished Apify run: id, status, defaultDatasetId, stats, usageTotalUsd, …",
          },
          items: itemsSchema,
        },
      },
    },
    resources: [
      { kind: "Apify.RunActor", metadata: { name: "start" }, client: cel("self.client") },
      { kind: "Apify.GetRun", metadata: { name: "getRun" }, client: cel("self.client") },
      { kind: "Apify.GetDatasetItems", metadata: { name: "getItems" }, client: cel("self.client") },
      {
        // Apify's long-poll holds each GET for up to 60 s, so this loop waits
        // rather than spins.
        kind: "Flow.Loop",
        metadata: { name: "wait" },
        inputType: {
          kind: "Telo.JsonSchema",
          schema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } } },
        },
        condition: cel(
          `previous == null || !(previous.poll.result.body.data.status in [${TERMINAL.map((s) => `'${s}'`).join(", ")}])`,
        ),
        steps: [{ name: "poll", invoke: ref("getRun"), inputs: { runId: cel("inputs.runId"), waitForFinish: 60 } }],
        outputs: { run: cel("steps.poll.result.body.data") },
      },
      {
        kind: "Flow.Sequence",
        metadata: { name: "seq" },
        inputType: {
          kind: "Telo.JsonSchema",
          schema: {
            type: "object",
            required: ["input"],
            properties: {
              input: { type: "object" },
              timeout: nullable("integer"),
              memory: nullable("integer"),
              maxItems: nullable("integer"),
              maxTotalChargeUsd: nullable("number"),
            },
          },
        },
        steps: [
          {
            name: "start",
            invoke: ref("start"),
            inputs: { actorId: id, build: version, input: cel("inputs.input"), ...forward("inputs") },
          },
          { name: "wait", invoke: ref("wait"), inputs: { runId: cel("steps.start.result.body.data.id") } },
          {
            name: "check",
            if: cel("steps.wait.result.run.status != 'SUCCEEDED'"),
            then: [
              {
                name: "fail",
                throw: {
                  code: "APIFY_RUN_NOT_SUCCEEDED",
                  message: cel(
                    "'Apify run ' + steps.wait.result.run.id + ' finished with status ' + steps.wait.result.run.status",
                  ),
                  data: cel("steps.wait.result.run"),
                },
              },
            ],
          },
          { name: "items", invoke: ref("getItems"), inputs: { datasetId: cel("steps.wait.result.run.defaultDatasetId") } },
        ],
        outputs: { run: cel("steps.wait.result.run"), items: cel("steps.items.result.body") },
      },
    ],
    invoke: ref("seq"),
    inputs: { input: cel("inputs"), ...forward("self") },
  };

  const header =
    `# GENERATED by scripts/apify/generate.mjs from build ${version} of the Apify actor ${id}.\n` +
    "# Do not edit: the module's version IS that build, so a hand edit can never be\n" +
    "# published. Change the generator instead.\n";
  return header + [library, inputShape, itemShape, run, start].map(toYaml).join("---\n");
}

// ---------------------------------------------------------------------------
// docs/README.md
// ---------------------------------------------------------------------------

const md = (s) => (s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
const typeLabel = (p) => {
  const t = Array.isArray(p.type) ? p.type.join(" \\| ") : (p.type ?? "any");
  return t === "array" && p.items?.type ? `${p.items.type}[]` : t;
};

export function renderDocs({ id, act, build, deprecated }) {
  const version = build.buildNumber;
  const title = plainText(act.title) ?? id;
  const dir = moduleDirName(id);
  const input = convertInputSchema(
    typeof build.inputSchema === "string" ? JSON.parse(build.inputSchema) : build.inputSchema,
  );
  const item = convertDatasetItem(build.actorDefinition?.storages?.dataset?.fields);
  const required = new Set(input.required ?? []);
  const props = Object.entries(input.properties ?? {});
  const firstRequired = props.find(([k]) => required.has(k));
  const example = firstRequired
    ? `    inputs:\n      ${firstRequired[0]}: ${JSON.stringify(firstRequired[1].default ?? exampleValue(firstRequired[1]))}`
    : "    inputs: {}";

  const lines = [];
  lines.push(`<!-- GENERATED by scripts/apify/generate.mjs — do not edit. -->`, "");
  lines.push(`# ${title}`, "");
  if (deprecated) {
    lines.push(`> **Deprecated** — ${deprecated}. This module is no longer updated.`, "");
  }
  lines.push(
    `The Apify actor [\`${id}\`](https://apify.com/${id}) as typed Telo kinds, generated from its build ` +
      `**${version}**. The module's version is that build number, and every run it starts is pinned to ` +
      "exactly that build, so the input types below are the ones the actor really runs with.",
    "",
  );
  const about = plainText(act.description);
  if (about) lines.push(about, "");

  lines.push("## Pricing", "", pricingSummary(currentPricing(act)), "");
  lines.push(
    "Runs are charged to the Apify account whose token the `ApifyClient` holds. " +
      `See the [Store page](https://apify.com/${id}) for current prices.`,
    "",
  );

  lines.push(
    "## Import",
    "",
    "```yaml",
    "imports:",
    `  Actor: oci://ghcr.io/telorun/apify/${dir}@${version}#sha256-…`,
    "```",
    "",
    "Pin the digest with `telo upgrade`. The module re-exports `ApifyClient`, so it is the only import needed.",
    "",
  );

  lines.push(
    "## Usage",
    "",
    "```yaml",
    "kind: Actor.ApifyClient",
    "metadata: { name: apify }",
    'token: !cel "secrets.apifyToken"',
    "---",
    "kind: Actor.Run          # or Actor.Start for runs longer than 5 minutes",
    "metadata: { name: scrape }",
    "client: !ref apify",
    "maxTotalChargeUsd: 1     # optional: timeout, memory, maxItems, maxTotalChargeUsd",
    "---",
    "kind: Run.Sequence",
    "metadata: { name: main }",
    "steps:",
    "  - name: scrape",
    "    invoke: !ref scrape",
    example,
    "```",
    "",
    "- **`Run`** calls Apify's synchronous endpoint and returns `{ items }`. Apify holds the request open for " +
      "at most 300 seconds; a longer run fails with HTTP 408.",
    "- **`Start`** starts the run, long-polls it until it finishes, and returns `{ run, items }`. A run that " +
      "ends `FAILED`, `TIMED-OUT` or `ABORTED` raises `APIFY_RUN_NOT_SUCCEEDED` with the run as `data`.",
    "",
  );

  lines.push("## Input", "");
  if (!props.length) {
    lines.push("The actor declares no input schema, so any object is accepted.", "");
  } else {
    lines.push(
      input.additionalProperties
        ? "The actor accepts fields beyond these."
        : "Only these fields are accepted — `telo check` rejects any other.",
      "",
      "| Field | Type | Required | Default | Description |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const [name, p] of props) {
      const def = p.default === undefined ? "" : `\`${md(JSON.stringify(p.default)).slice(0, 60)}\``;
      const desc = [p.title, p.description].filter(Boolean).join(" — ");
      lines.push(
        `| \`${name}\` | ${typeLabel(p)} | ${required.has(name) ? "yes" : ""} | ${def} | ${md(desc).slice(0, 300)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Output", "");
  const fields = Object.entries(item.properties ?? {});
  if (!fields.length) {
    lines.push("The actor publishes no dataset schema, so `items` are untyped objects.", "");
  } else {
    lines.push(
      "Each dataset item is typed from the actor's published dataset schema. Every field may be null, and " +
        "items may carry fields beyond these.",
      "",
      "| Field | Type | Description |",
      "| --- | --- | --- |",
    );
    for (const [name, p] of fields) {
      lines.push(`| \`${name}\` | ${typeLabel(p)} | ${md(p.description ?? p.title).slice(0, 300)} |`);
    }
    lines.push("");
  }
  lines.push(
    "## About this module",
    "",
    "Generated by `scripts/apify/generate.mjs` and refreshed weekly. How the types are derived, why the " +
      "version is the actor build, and how actors are chosen: " +
      "[generated-actors.md](../../apify/docs/generated-actors.md).",
    "",
  );
  return lines.join("\n");
}

function exampleValue(p) {
  const t = Array.isArray(p.type) ? p.type[0] : p.type;
  if (p.enum?.length) return p.enum[0];
  return { string: "…", integer: 1, number: 1, boolean: true, array: [], object: {} }[t] ?? null;
}

/** The CHANGELOG entry for a newly generated build. */
export function renderChangelogEntry({ id, build, previous, date }) {
  return previous
    ? `## ${build.buildNumber} - ${date}\n### Changed\n* Updated from build ${previous} to build ${build.buildNumber} of the Apify actor \`${id}\`.\n`
    : `## ${build.buildNumber} - ${date}\n### Added\n* Generated from build ${build.buildNumber} of the Apify actor \`${id}\`.\n`;
}
