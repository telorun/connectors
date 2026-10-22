// Apify schemas → the JSON Schema a Telo `inputType` / `outputType` carries.
//
// An actor input schema (https://docs.apify.com/platform/actors/development/actor-definition/input-schema)
// is JSON Schema plus UI keys (editor, prefill, sectionCaption, …). Only the
// validation keywords survive; the rest is presentation.
//
// INPUT is strict, because it is what `telo check` holds a caller to: objects
// that declare their properties are closed unless the actor marks them open,
// `required` and `default` carry over, and `isSecret` fields are marked
// sensitive so the kernel redacts them.
//
// OUTPUT (a dataset's `fields` schema) is descriptive rather than enforced by
// Apify, and actors routinely return more — or less — than they declare. It is
// kept for typing what IS declared, but every type admits null, nothing is
// required and every object stays open.

/** Strip the HTML Apify descriptions are written in down to plain text. */
export function plainText(html) {
  if (typeof html !== "string") return undefined;
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<a\s[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) =>
      label.trim() && label.trim() !== href ? `${label} (${href})` : href,
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    // One newline per paragraph break: a folded YAML block renders it as one
    // blank line.
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  // `${{` opens Telo's legacy inline expression form; never let upstream prose
  // be read as one.
  return text.replace(/\$\{\{/g, "$ {{") || undefined;
}

const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object", "null"]);

function typeList(t) {
  const list = (Array.isArray(t) ? t : [t]).filter((x) => TYPES.has(x));
  return list.length ? list : undefined;
}

function matchesType(value, types) {
  if (!types) return true;
  return types.some((t) => {
    switch (t) {
      case "string":
        return typeof value === "string";
      case "integer":
        return Number.isInteger(value);
      case "number":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
    }
    return false;
  });
}

const containsLegacyExpr = (v) => JSON.stringify(v ?? null).includes("${{");

function validPattern(p) {
  if (typeof p !== "string") return false;
  try {
    new RegExp(p, "u");
    return true;
  } catch {
    return false;
  }
}

function setType(out, types) {
  if (types) out.type = types.length === 1 ? types[0] : types;
}

/** One property of an actor input schema. */
export function convertInputProperty(p) {
  if (!p || typeof p !== "object") return {};
  const out = {};
  let types = typeList(p.type);
  if (types && p.nullable === true && !types.includes("null")) types = [...types, "null"];
  setType(out, types);

  const title = plainText(p.title);
  const description = plainText(p.description);
  if (title) out.title = title;
  if (description) out.description = description;

  if (Array.isArray(p.enum) && p.enum.length && !containsLegacyExpr(p.enum)) {
    out.enum = types?.includes("null") && !p.enum.includes(null) ? [...p.enum, null] : [...p.enum];
  }

  for (const k of ["minimum", "maximum"]) if (typeof p[k] === "number") out[k] = p[k];
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"]) if (Number.isInteger(p[k]) && p[k] >= 0) out[k] = p[k];
  if (p.uniqueItems === true) out.uniqueItems = true;
  if (validPattern(p.pattern)) out.pattern = p.pattern;

  if (p.items && typeof p.items === "object" && !Array.isArray(p.items)) {
    out.items = convertInputProperty(p.items);
  }
  if (p.properties && typeof p.properties === "object") {
    Object.assign(out, convertInputObject(p));
  } else if (p.additionalProperties === false && types?.includes("object")) {
    out.additionalProperties = false;
  }

  if (p.isSecret === true) out["x-telo-sensitive"] = true;

  const defaultOk =
    "default" in p &&
    p.isSecret !== true &&
    matchesType(p.default, types) &&
    (!out.enum || out.enum.some((e) => JSON.stringify(e) === JSON.stringify(p.default))) &&
    !containsLegacyExpr(p.default);
  if (defaultOk) out.default = p.default;
  return out;
}

/** The `properties` / `required` / `additionalProperties` of an object node. */
function convertInputObject(node) {
  const properties = {};
  for (const [name, prop] of Object.entries(node.properties ?? {})) properties[name] = convertInputProperty(prop);
  const out = {};
  out.additionalProperties = node.additionalProperties === true;
  const required = (Array.isArray(node.required) ? node.required : []).filter((r) => r in properties);
  if (required.length) out.required = [...new Set(required)];
  out.properties = properties;
  return out;
}

/** A whole actor input schema → the generated kinds' `inputType` schema. */
export function convertInputSchema(schema) {
  if (!schema || typeof schema !== "object" || !schema.properties) {
    // No declared input: the actor reads whatever it is given.
    return { type: "object", additionalProperties: true };
  }
  return { type: "object", ...convertInputObject(schema) };
}

/** One node of a dataset `fields` schema, made lenient (see the header). */
export function convertOutputProperty(p) {
  if (!p || typeof p !== "object") return {};
  const out = {};
  // Outputs are validated at dispatch, so a declared type is a promise the
  // actor must keep. `integer` widens to `number` (an actor declaring a count
  // and returning 1.5 is common), and null is always admitted.
  let types = typeList(p.type)?.map((t) => (t === "integer" ? "number" : t));
  if (types) types = [...new Set(types)];
  setType(out, types && !types.includes("null") ? [...types, "null"] : types);
  const title = plainText(p.title);
  const description = plainText(p.description);
  if (title) out.title = title;
  if (description) out.description = description;
  if (p.items && typeof p.items === "object" && !Array.isArray(p.items)) out.items = convertOutputProperty(p.items);
  if (p.properties && typeof p.properties === "object") {
    out.additionalProperties = true;
    out.properties = Object.fromEntries(
      Object.entries(p.properties).map(([k, v]) => [k, convertOutputProperty(v)]),
    );
  }
  return out;
}

/** A build's dataset `fields` schema → the JSON Schema of one dataset item. */
export function convertDatasetItem(fields) {
  const item = { type: "object", additionalProperties: true };
  if (fields && typeof fields === "object" && fields.properties && typeof fields.properties === "object") {
    item.properties = Object.fromEntries(
      Object.entries(fields.properties).map(([k, v]) => [k, convertOutputProperty(v)]),
    );
  }
  return item;
}
