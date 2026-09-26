// Builds Paprika-compatible YAML import files.
//
// Paprika's YAML import is a list of recipes. Supported keys: name, servings,
// source, source_url, prep_time, cook_time, on_favorites, categories,
// nutritional_info, difficulty, rating, notes, photo (base64 image), ingredients,
// directions. name, ingredients and directions are required. YAML is strict
// about indentation, so every value is emitted in a form that is always valid:
// single-line values as double-quoted strings, multi-line values as literal
// block scalars ("|").

const INDENT = "    ";

function clean(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    // Strip control characters YAML does not allow (keep \n).
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

// Double-quoted YAML scalar. JSON string escaping is a valid subset of YAML's.
function quoted(text) {
  return JSON.stringify(clean(text).replace(/\n+/g, " "));
}

function block(text) {
  const body = clean(text);
  if (!body) return '""';
  // body is trimmed, so the first line is never indented and "|" is unambiguous.
  const lines = body.split("\n").map((line) => (line ? INDENT + line : ""));
  return "|\n" + lines.join("\n");
}

function recipeToYaml(recipe) {
  const out = [];
  const add = (key, value) => out.push(`  ${key}: ${value}`);

  add("name", quoted(recipe.name || "Untitled recipe"));
  if (clean(recipe.servings)) add("servings", quoted(recipe.servings));
  if (clean(recipe.source)) add("source", quoted(recipe.source));
  if (clean(recipe.source_url)) add("source_url", quoted(recipe.source_url));
  if (clean(recipe.prep_time)) add("prep_time", quoted(recipe.prep_time));
  if (clean(recipe.cook_time)) add("cook_time", quoted(recipe.cook_time));
  add("on_favorites", recipe.on_favorites ? "yes" : "no");

  const categories = (recipe.categories || []).map(clean).filter(Boolean);
  if (categories.length) add("categories", `[${categories.map(quoted).join(", ")}]`);

  if (clean(recipe.nutritional_info)) add("nutritional_info", block(recipe.nutritional_info));
  if (clean(recipe.difficulty)) add("difficulty", quoted(recipe.difficulty));

  const rating = Math.round(Number(recipe.rating) || 0);
  if (rating >= 1 && rating <= 5) add("rating", String(rating));

  if (clean(recipe.notes)) add("notes", block(recipe.notes));
  if (recipe.photo) add("photo", recipe.photo.replace(/[^A-Za-z0-9+/=]/g, ""));

  add("ingredients", block(recipe.ingredients));
  add("directions", block(recipe.directions));

  // First key carries the list marker.
  out[0] = "- " + out[0].slice(2);
  return out.join("\n");
}

export function toPaprikaYaml(recipes) {
  return recipes.map(recipeToYaml).join("\n") + "\n";
}

// Combines the cook's own changes with notes printed/handwritten on the page.
export function composeNotes(myChanges, recipeNotes) {
  const parts = [];
  if (clean(myChanges)) parts.push("MY CHANGES:\n" + clean(myChanges));
  if (clean(recipeNotes)) parts.push("FROM THE ORIGINAL RECIPE:\n" + clean(recipeNotes));
  return parts.join("\n\n");
}

export function safeFilename(name) {
  const base = clean(name).replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").slice(0, 80);
  return base || "recipe";
}
