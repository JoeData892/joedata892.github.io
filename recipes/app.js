import Anthropic from "./vendor/anthropic-sdk.js";
import { toPaprikaYaml, composeNotes, safeFilename } from "./paprika.js";

const MODEL = "claude-opus-5";
// Claude reads images best at up to ~1568px on the long edge.
const READ_MAX_EDGE = 1568;
// Smaller copy embedded in the Paprika file as the recipe photo.
const PHOTO_MAX_EDGE = 1200;

const $ = (id) => document.getElementById(id);

// ---------- Small persistence helpers ----------

const prefs = {
  get(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
};

// IndexedDB holds the in-progress draft (so a page reload after using the
// camera doesn't lose work) and the batch. Falls back to memory if unavailable.
const db = (() => {
  const memory = { kv: new Map(), batch: new Map() };
  let nextId = 1;
  const open = new Promise((resolve) => {
    try {
      const req = indexedDB.open("recipe-capture", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("kv");
        req.result.createObjectStore("batch", { keyPath: "id", autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const run = async (store, mode, fn) => {
    const idb = await open;
    if (!idb) return null;
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : null);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    async getKv(key) {
      const idb = await open;
      return idb ? run("kv", "readonly", (s) => s.get(key)) : memory.kv.get(key);
    },
    async setKv(key, value) {
      const idb = await open;
      if (idb) await run("kv", "readwrite", (s) => s.put(value, key));
      else memory.kv.set(key, value);
    },
    async batchAll() {
      const idb = await open;
      return idb ? (await run("batch", "readonly", (s) => s.getAll())) || [] : [...memory.batch.values()];
    },
    async batchAdd(recipe) {
      const idb = await open;
      if (idb) await run("batch", "readwrite", (s) => s.add(recipe));
      else { const id = nextId++; memory.batch.set(id, { ...recipe, id }); }
    },
    async batchDelete(id) {
      const idb = await open;
      if (idb) await run("batch", "readwrite", (s) => s.delete(id));
      else memory.batch.delete(id);
    },
    async batchClear() {
      const idb = await open;
      if (idb) await run("batch", "readwrite", (s) => s.clear());
      else memory.batch.clear();
    },
  };
})();

// ---------- Images ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not open that image.")); };
    img.src = url;
  });
}

function toJpegBase64(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality).split(",")[1];
}

async function processImage(file) {
  const img = await loadImage(file);
  return {
    read: toJpegBase64(img, READ_MAX_EDGE, 0.85),
    photo: toJpegBase64(img, PHOTO_MAX_EDGE, 0.8),
  };
}

// ---------- Draft state ----------

const FIELDS = {
  myChanges: "myChanges",
  name: "name",
  servings: "servings",
  prepTime: "prepTime",
  cookTime: "cookTime",
  source: "source",
  ingredients: "ingredients",
  directions: "directions",
  recipeNotes: "recipeNotes",
  nutrition: "nutrition",
  categories: "categories",
  rating: "rating",
  difficulty: "difficulty",
};

let pages = []; // [{ read, photo }]
let dish = null; // { read, photo } | null

// Typing is debounced; everything else (photos, Claude's results, leaving
// the page) saves immediately.
let saveTimer = null;
function saveDraft() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraftNow, 300);
}
function saveDraftNow() {
  clearTimeout(saveTimer);
  const fields = {};
  for (const id of Object.keys(FIELDS)) fields[id] = $(id).value;
  fields.favorite = $("favorite").checked;
  db.setKv("draft", { fields, pages, dish }).catch(() => {});
}

async function restoreDraft() {
  let draft = null;
  try { draft = await db.getKv("draft"); } catch { /* ignore */ }
  if (!draft) {
    $("source").value = prefs.get("defaultSource");
    return;
  }
  for (const [id, value] of Object.entries(draft.fields || {})) {
    if (id === "favorite") $("favorite").checked = !!value;
    else if ($(id)) $(id).value = value;
  }
  pages = draft.pages || [];
  dish = draft.dish || null;
  renderThumbs();
}

function renderThumbs() {
  const wrap = $("pageThumbs");
  wrap.replaceChildren(...pages.map((p, i) => thumb(p, `Page ${i + 1}`, () => {
    pages.splice(i, 1);
    renderThumbs();
    saveDraftNow();
  })));
  $("dishThumb").replaceChildren(...(dish ? [thumb(dish, "Dish", () => {
    dish = null;
    renderThumbs();
    saveDraftNow();
  })] : []));
  $("readBtn").disabled = pages.length === 0;
}

function thumb(image, tag, onRemove) {
  const el = document.createElement("div");
  el.className = "thumb";
  const img = document.createElement("img");
  img.src = "data:image/jpeg;base64," + image.photo;
  img.alt = tag;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "×";
  remove.setAttribute("aria-label", `Remove ${tag}`);
  remove.onclick = onRemove;
  const label = document.createElement("span");
  label.className = "tag";
  label.textContent = tag;
  el.append(img, remove, label);
  return el;
}

function showBanner(id, kind, text) {
  const el = $(id);
  if (!text) { el.hidden = true; return; }
  el.className = `banner ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

async function addImages(files, target) {
  const list = [...files];
  if (!list.length) return;
  try {
    for (const file of list) {
      const processed = await processImage(file);
      if (target === "dish") dish = processed;
      else pages.push(processed);
    }
  } catch (err) {
    showBanner("readStatus", "error", err.message);
  }
  renderThumbs();
  saveDraftNow();
}

// ---------- Reading the recipe with Claude ----------

const SYSTEM_PROMPT = `You transcribe recipes from photos of printed or handwritten pages, such as old family and church cookbooks, into structured data for the Paprika recipe app.

Transcribe faithfully. Keep the author's quantities, units, fractions, wording and ingredient order exactly as printed; do not convert, modernize, "fix" or add anything. If several photos are provided they are consecutive pages of the same recipe. If a page shows more than one recipe, transcribe only the main or first complete one.

- ingredients: one ingredient per array item, exactly as written (e.g. "1 1/2 c. flour, sifted"). If the recipe groups ingredients under sub-headings (e.g. "Crust:", "Filling:"), include each sub-heading as its own item.
- directions: one step per array item, without leading step numbers. If the directions are a single paragraph, split it into sensible steps at sentence boundaries without rewording.
- recipe_notes: tips, variations, serving suggestions, the contributor's name (e.g. "Submitted by Mrs. Helen Smith") and any handwritten margin notes (prefix those with "Handwritten: "). Empty string if none.
- servings, prep_time, cook_time, nutritional_info: only if stated on the page; empty string otherwise. Put oven temperature and bake time in the directions, not cook_time, unless the page labels a cook time.
- name: the recipe title as printed, in Title Case. If there is no title, make a short descriptive one.
- categories: 1-3 short suggestions such as "Dessert", "Cookies", "Main Dish", "Soup", "Bread", "Side Dish", "Breakfast", "Appetizer", "Holiday".
- unclear: briefly list any words or quantities you could not read with confidence, and what you guessed. Empty string if everything was legible.`;

const RECIPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "name", "servings", "prep_time", "cook_time", "ingredients", "directions",
    "recipe_notes", "nutritional_info", "categories", "unclear",
  ],
  properties: {
    name: { type: "string" },
    servings: { type: "string" },
    prep_time: { type: "string" },
    cook_time: { type: "string" },
    ingredients: { type: "array", items: { type: "string" } },
    directions: { type: "array", items: { type: "string" } },
    recipe_notes: { type: "string" },
    nutritional_info: { type: "string" },
    categories: { type: "array", items: { type: "string" } },
    unclear: { type: "string" },
  },
};

async function readRecipe() {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) {
    $("settings").open = true;
    $("apiKey").focus();
    showBanner("readStatus", "error", "Add your Anthropic API key in Settings first.");
    return;
  }
  if (!pages.length) return;

  const btn = $("readBtn");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Reading recipe…';
  showBanner("readStatus", "warn", "Reading your photos. This usually takes 15–60 seconds.");

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const content = [
    ...pages.map((p) => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: p.read },
    })),
    {
      type: "text",
      text: pages.length > 1
        ? `These ${pages.length} photos are consecutive pages of one recipe. Transcribe it.`
        : "Transcribe this recipe.",
    },
  ];
  const request = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: RECIPE_SCHEMA } },
    messages: [{ role: "user", content }],
  };

  try {
    let response;
    try {
      // If Claude declines (e.g. a false-positive safety refusal), the API
      // retries on a fallback model within the same call.
      response = await client.beta.messages.create({
        ...request,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      // Retry once with the plain request in case the fallback option is
      // unavailable for this account.
      response = await client.messages.create(request);
    }

    if (response.stop_reason === "refusal") {
      throw new Error("Claude declined to read this image. Try a clearer photo, or type the recipe in by hand.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("The recipe was too long to read in one go. Try fewer pages at a time.");
    }
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const recipe = JSON.parse(text);
    fillFromClaude(recipe);
    showBanner(
      "readStatus",
      recipe.unclear ? "warn" : "ok",
      recipe.unclear
        ? `Done. Double-check these spots:\n${recipe.unclear}`
        : "Done. Review the recipe below, then export it.",
    );
  } catch (err) {
    showBanner("readStatus", "error", describeError(err));
  } finally {
    btn.innerHTML = original;
    btn.disabled = pages.length === 0;
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This API key isn't allowed to use this model. Check your Anthropic console.";
  if (err instanceof Anthropic.RateLimitError) return "Too many requests right now, or your account is out of credit. Wait a minute and try again, or check billing in the Anthropic console.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your internet connection and try again.";
  if (err instanceof Anthropic.InternalServerError) return "Anthropic's service had a problem. Please try again in a moment.";
  if (err instanceof Anthropic.APIError) return `The request failed: ${err.message}`;
  if (err instanceof SyntaxError) return "Claude's answer couldn't be understood. Please try again.";
  return err.message || String(err);
}

function fillFromClaude(r) {
  $("name").value = r.name || "";
  $("servings").value = r.servings || "";
  $("prepTime").value = r.prep_time || "";
  $("cookTime").value = r.cook_time || "";
  $("ingredients").value = (r.ingredients || []).join("\n");
  $("directions").value = (r.directions || []).join("\n\n");
  $("recipeNotes").value = r.recipe_notes || "";
  $("nutrition").value = r.nutritional_info || "";
  if (!$("categories").value.trim()) $("categories").value = (r.categories || []).join(", ");
  saveDraftNow();
}

// ---------- Export ----------

function currentRecipe() {
  return {
    name: $("name").value.trim(),
    servings: $("servings").value,
    source: $("source").value,
    prep_time: $("prepTime").value,
    cook_time: $("cookTime").value,
    on_favorites: $("favorite").checked,
    categories: $("categories").value.split(",").map((c) => c.trim()).filter(Boolean),
    nutritional_info: $("nutrition").value,
    difficulty: $("difficulty").value,
    rating: Number($("rating").value),
    notes: composeNotes($("myChanges").value, $("recipeNotes").value),
    photo: (dish || pages[0])?.photo || "",
    ingredients: $("ingredients").value,
    directions: $("directions").value,
  };
}

function validate(recipe) {
  const missing = [];
  if (!recipe.name) missing.push("a recipe name");
  if (!recipe.ingredients.trim()) missing.push("ingredients");
  if (!recipe.directions.trim()) missing.push("directions");
  return missing.length ? `Paprika needs ${missing.join(", ")} before it can import this recipe.` : "";
}

function downloadYaml(recipes, filename) {
  const blob = new Blob([toPaprikaYaml(recipes)], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadOne() {
  const recipe = currentRecipe();
  const problem = validate(recipe);
  if (problem) return showBanner("exportStatus", "error", problem);
  downloadYaml([recipe], `${safeFilename(recipe.name)}.yml`);
  showBanner("exportStatus", "ok", "Downloaded. Import the .yml file in Paprika (see Settings for how).");
}

async function addToBatch() {
  const recipe = currentRecipe();
  const problem = validate(recipe);
  if (problem) return showBanner("exportStatus", "error", problem);
  try {
    await db.batchAdd(recipe);
  } catch {
    return showBanner("exportStatus", "error", "Couldn't save to the batch. Your device may be out of storage; download this recipe on its own instead.");
  }
  await renderBatch();
  showBanner("exportStatus", "ok", `Added “${recipe.name}” to the batch. Tap “Start new recipe” to capture the next one.`);
}

async function renderBatch() {
  const items = await db.batchAll().catch(() => []);
  const list = $("batchList");
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No recipes in the batch yet.";
    list.replaceChildren(li);
  } else {
    list.replaceChildren(...items.map((r) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = r.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "link";
      remove.textContent = "Remove";
      remove.onclick = async () => { await db.batchDelete(r.id); renderBatch(); };
      li.append(name, remove);
      return li;
    }));
  }
  $("downloadBatch").disabled = !items.length;
  $("clearBatch").disabled = !items.length;
  $("downloadBatch").textContent = items.length ? `⬇️ Download batch (${items.length})` : "⬇️ Download batch";
}

async function downloadBatch() {
  const items = await db.batchAll();
  if (!items.length) return;
  const stamp = new Date().toISOString().slice(0, 10);
  downloadYaml(items.map(({ id, ...r }) => r), `Paprika recipes ${stamp} (${items.length}).yml`);
  showBanner("exportStatus", "ok", `Downloaded ${items.length} recipes in one file. After importing into Paprika, you can clear the batch.`);
}

async function clearBatch() {
  if (!confirm("Remove all recipes from the batch? Download it first if you haven't imported it yet.")) return;
  await db.batchClear();
  renderBatch();
}

function newRecipe() {
  const hasWork = pages.length || $("name").value.trim() || $("myChanges").value.trim();
  if (hasWork && !confirm("Clear this recipe and start a new one? Make sure you've downloaded it or added it to the batch.")) return;
  for (const id of Object.keys(FIELDS)) $(id).value = id === "rating" ? "0" : "";
  $("favorite").checked = false;
  $("source").value = prefs.get("defaultSource");
  pages = [];
  dish = null;
  renderThumbs();
  showBanner("readStatus");
  showBanner("exportStatus");
  saveDraftNow();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- Wire up ----------

$("apiKey").value = prefs.get("anthropicApiKey");
$("apiKey").addEventListener("change", () => prefs.set("anthropicApiKey", $("apiKey").value.trim()));
$("defaultSource").value = prefs.get("defaultSource");
$("defaultSource").addEventListener("change", () => {
  prefs.set("defaultSource", $("defaultSource").value.trim());
  if (!$("source").value.trim()) $("source").value = $("defaultSource").value.trim();
});
if (!prefs.get("anthropicApiKey")) $("settings").open = true;

for (const id of ["cameraInput", "libraryInput", "dishInput"]) {
  $(id).addEventListener("change", async (e) => {
    await addImages(e.target.files, id === "dishInput" ? "dish" : "page");
    e.target.value = "";
  });
}
for (const id of [...Object.keys(FIELDS), "favorite"]) {
  $(id).addEventListener("input", saveDraft);
  $(id).addEventListener("change", saveDraft);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveDraftNow();
});
window.addEventListener("pagehide", saveDraftNow);
$("readBtn").addEventListener("click", readRecipe);
$("downloadOne").addEventListener("click", downloadOne);
$("addToBatch").addEventListener("click", addToBatch);
$("downloadBatch").addEventListener("click", downloadBatch);
$("clearBatch").addEventListener("click", clearBatch);
$("newRecipe").addEventListener("click", newRecipe);

restoreDraft().then(renderThumbs);
renderBatch();
