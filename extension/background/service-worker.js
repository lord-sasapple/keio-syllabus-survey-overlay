const KSUPPORT_SEARCH_URL = "https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch";
const KSUPPORT_TAB_PATTERN = "https://keiouniversity.my.site.com/students/*";
const KEIO_FACULTY_SEARCH_URL = "https://www.keio.ac.jp/ja/faculty/";
const FACULTY_PROFILE_CACHE_KEY = "keioSurvey.facultyProfiles";
const FACULTY_PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DB_NAME = "keioSurveyCache";
const DB_VERSION = 1;

function dbOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("courses")) db.createObjectStore("courses", { keyPath: "recordId" });
      if (!db.objectStoreNames.contains("evaluations")) db.createObjectStore("evaluations", { keyPath: "recordId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbStore(mode, storeName, callback) {
  const db = await dbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try {
      result = callback(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}

async function handleCacheMessage(message) {
  const op = message?.op;
  const storeName = message?.storeName;
  if (!["courses", "evaluations", "meta"].includes(storeName)) {
    return { ok: false, code: "CACHE_BAD_STORE", message: "Unknown cache store." };
  }
  if (op === "put") {
    const value = message.value;
    if (!value?.recordId && storeName !== "meta") return { ok: true, skipped: true };
    await dbStore("readwrite", storeName, (store) => store.put(value));
    return { ok: true };
  }
  if (op === "putMany") {
    const values = Array.isArray(message.values) ? message.values.filter((value) => value?.recordId || storeName === "meta") : [];
    if (!values.length) return { ok: true, count: 0 };
    await dbStore("readwrite", storeName, (store) => {
      for (const value of values) store.put(value);
    });
    return { ok: true, count: values.length };
  }
  if (op === "getAll") {
    const values = await dbStore("readonly", storeName, (store) => dbRequest(store.getAll()));
    return { ok: true, values: values || [] };
  }
  if (op === "setMeta") {
    await dbStore("readwrite", "meta", (store) => store.put({
      key: message.key,
      value: message.value,
      updatedAt: new Date().toISOString()
    }));
    return { ok: true };
  }
  if (op === "getMeta") {
    const value = await dbStore("readonly", "meta", (store) => dbRequest(store.get(message.key)));
    return { ok: true, value };
  }
  return { ok: false, code: "CACHE_BAD_OP", message: "Unknown cache operation." };
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          code: "TAB_MESSAGE_FAILED",
          message: chrome.runtime.lastError.message
        });
        return;
      }
      resolve(response || { ok: false, code: "EMPTY_TAB_RESPONSE" });
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

function createTab(createProperties) {
  return new Promise((resolve) => chrome.tabs.create(createProperties, resolve));
}

function storageGet(defaults) {
  return chrome.storage.local.get(defaults);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePerson(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#34;/g, "\"");
}

function textFromHtml(value) {
  return normalizeText(decodeHtml(stripTags(value)));
}

function absoluteKeioUrl(value) {
  if (!value) return "";
  return new URL(value, "https://www.keio.ac.jp").toString();
}

function cacheKeyForInstructor(name, faculty) {
  return `${normalizePerson(name)}|${normalizeText(faculty)}`;
}

function facultyTokens(value) {
  const text = normalizeText(value);
  const compact = text.replace(/\s+/g, "");
  const tokens = new Set();
  const known = [
    "文学部",
    "経済学部",
    "法学部",
    "商学部",
    "医学部",
    "理工学部",
    "総合政策学部",
    "環境情報学部",
    "看護医療学部",
    "薬学部",
    "政策・メディア研究科",
    "政策メディア研究科",
    "理工学研究科",
    "文学研究科",
    "経済学研究科",
    "法学研究科",
    "社会学研究科",
    "商学研究科",
    "医学研究科",
    "健康マネジメント研究科",
    "薬学研究科"
  ];
  for (const token of known) {
    if (compact.includes(token.replace(/\s+/g, ""))) tokens.add(token);
  }
  if (compact.includes("総合政策") && compact.includes("学部")) tokens.add("総合政策学部");
  if (compact.includes("環境情報") && compact.includes("学部")) tokens.add("環境情報学部");
  if (compact.includes("政策") && compact.includes("メディア") && compact.includes("研究科")) tokens.add("政策・メディア研究科");
  return [...tokens];
}

function affiliationMatches(candidateAffiliation, expectedFaculty) {
  const expectedTokens = facultyTokens(expectedFaculty);
  if (!expectedTokens.length) return true;
  const candidate = normalizeText(candidateAffiliation).replace(/\s+/g, "");
  return expectedTokens.some((token) => candidate.includes(token.replace(/\s+/g, "")));
}

function parseFacultyResults(html, instructorName) {
  const cards = [];
  const linkPattern = /<a\b[^>]*href="([^"]*\/ja\/faculty\/[^"]+|\/ja\/faculty\/[^"]+)"[^>]*>([\s\S]*?)(?=<\/a>)/g;
  for (const match of html.matchAll(linkPattern)) {
    const href = decodeHtml(match[1]);
    const body = match[2] || "";
    const name = textFromHtml(body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1] || "");
    const imagePath = decodeHtml(body.match(/<img\b[^>]*\bsrc="([^"]+)"/)?.[1] || "");
    const affiliations = textFromHtml(body.match(/<div\b[^>]*class="[^"]*affiliations[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
    const fields = textFromHtml(body.match(/<div\b[^>]*class="[^"]*fields[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "");
    if (!name || normalizePerson(name) !== normalizePerson(instructorName)) continue;
    cards.push({
      name,
      profileUrl: absoluteKeioUrl(href),
      imageUrl: absoluteKeioUrl(imagePath),
      affiliations,
      fields
    });
  }
  return cards;
}

function chooseFacultyProfile(candidates, expectedFaculty) {
  const matched = candidates.filter((candidate) => affiliationMatches(candidate.affiliations, expectedFaculty));
  if (matched.length === 1) return { ...matched[0], confidence: "high" };
  if (matched.length > 1) return null;
  if (!normalizeText(expectedFaculty) && candidates.length === 1) return { ...candidates[0], confidence: "medium" };
  return null;
}

async function fetchKeioFacultyProfile({ instructorName, faculty }) {
  const name = normalizeText(instructorName);
  if (!name) return { ok: false, code: "INSTRUCTOR_NAME_MISSING" };

  const key = cacheKeyForInstructor(name, faculty);
  const now = Date.now();
  const state = await storageGet({ [FACULTY_PROFILE_CACHE_KEY]: {} });
  const cache = state[FACULTY_PROFILE_CACHE_KEY] || {};
  const cached = cache[key];
  if (cached && now - Number(cached.cachedAt || 0) < FACULTY_PROFILE_CACHE_TTL_MS) {
    return { ok: true, cached: true, profile: cached.profile || null };
  }

  const url = new URL(KEIO_FACULTY_SEARCH_URL);
  url.searchParams.set("keyword", name);
  const response = await fetch(url.toString(), { credentials: "omit" });
  if (!response.ok) {
    return {
      ok: false,
      code: "KEIO_FACULTY_SEARCH_FAILED",
      status: response.status
    };
  }

  const html = await response.text();
  const candidates = parseFacultyResults(html, name);
  const profile = chooseFacultyProfile(candidates, faculty);
  cache[key] = {
    cachedAt: now,
    profile,
    candidateCount: candidates.length
  };
  await storageSet({ [FACULTY_PROFILE_CACHE_KEY]: cache });
  return {
    ok: true,
    cached: false,
    profile,
    candidateCount: candidates.length
  };
}

async function injectKSupportScripts(tabId) {
  if (!chrome.scripting?.executeScript) {
    return {
      ok: false,
      code: "SCRIPTING_UNAVAILABLE",
      message: "K-Support タブへ再接続する権限がありません。"
    };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/shared.js", "src/probe-bridge.js", "src/ksupport-content.js"]
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "KSUPPORT_REINJECT_FAILED",
      message: String(error?.message || error).slice(0, 500)
    };
  }
}

function shouldRetryAfterInjection(response) {
  const message = response?.message || "";
  return response?.code === "TAB_MESSAGE_FAILED"
    && /Receiving end does not exist|Could not establish connection/i.test(message);
}

async function sendKSupportTabMessage(tab, message) {
  let response = await sendTabMessage(tab.id, message);
  if (!shouldRetryAfterInjection(response)) return response;

  const injection = await injectKSupportScripts(tab.id);
  if (!injection.ok) return injection;

  // Give the bridge a moment to inject the page probe before asking it for data.
  await new Promise((resolve) => setTimeout(resolve, 250));
  response = await sendTabMessage(tab.id, message);
  return response;
}

async function ksupportTabs() {
  const tabs = await queryTabs({ url: KSUPPORT_TAB_PATTERN });
  return tabs
    .filter((tab) => tab.id && tab.url && tab.url.startsWith("https://keiouniversity.my.site.com/students/"))
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
}

async function fetchViaKSupportTab(syllabus) {
  const tabs = await ksupportTabs();
  if (!tabs.length) {
    return {
      ok: false,
      code: "KSUPPORT_TAB_NOT_FOUND",
      message: "ログイン済みの K-Support タブが見つかりません。"
    };
  }

  const failures = [];
  for (const tab of tabs) {
    const response = await sendKSupportTabMessage(tab, {
      type: "keioSurvey.fetchEvaluationForSyllabus",
      syllabus
    });
    if (response?.ok || response?.code === "NO_MATCH") {
      return {
        ...response,
        ksupportTabId: tab.id
      };
    }
    failures.push({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      code: response?.code,
      message: response?.message
    });
  }

  return {
    ok: false,
    code: failures[0]?.code || "KSUPPORT_TABS_UNAVAILABLE",
    message: failures[0]?.message || "K-Support タブへ接続できませんでした。",
    failures
  };
}

async function syncAllViaKSupportTab(options = {}) {
  const tabs = await ksupportTabs();
  if (!tabs.length) {
    return {
      ok: false,
      code: "KSUPPORT_TAB_NOT_FOUND",
      message: "ログイン済みの K-Support タブが見つかりません。"
    };
  }
  const failures = [];
  for (const tab of tabs) {
    const response = await sendKSupportTabMessage(tab, {
      type: "keioSurvey.syncAllEvaluations",
      options
    });
    if (response?.ok) return { ...response, ksupportTabId: tab.id };
    failures.push({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      code: response?.code,
      message: response?.message
    });
  }
  return {
    ok: false,
    code: failures[0]?.code || "KSUPPORT_TABS_UNAVAILABLE",
    message: failures[0]?.message || "K-Support タブへ接続できませんでした。",
    failures
  };
}

async function ksupportStatus() {
  const tabs = await ksupportTabs();
  const statuses = [];
  for (const tab of tabs) {
    const response = await sendKSupportTabMessage(tab, { type: "keioSurvey.ksupportStatus" });
    statuses.push({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      ...response
    });
  }
  return {
    ok: true,
    tabs: statuses
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "keioSurvey.cache") {
    handleCacheMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        code: "CACHE_ERROR",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  }

  if (message?.type === "keioSurvey.fetchEvaluationForSyllabus") {
    fetchViaKSupportTab(message.syllabus || {})
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        code: "BACKGROUND_FETCH_ERROR",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  }

  if (message?.type === "keioSurvey.syncAllEvaluations") {
    syncAllViaKSupportTab(message.options || {})
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        code: "BACKGROUND_SYNC_ERROR",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  }

  if (message?.type === "keioSurvey.openKSupport") {
    createTab({ url: KSUPPORT_SEARCH_URL, active: true })
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((error) => sendResponse({
        ok: false,
        code: "OPEN_KSUPPORT_FAILED",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  }

  if (message?.type === "keioSurvey.ksupportStatus") {
    ksupportStatus()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        code: "BACKGROUND_STATUS_ERROR",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  }

  if (message?.type === "keioSurvey.fetchFacultyProfile") {
    fetchKeioFacultyProfile(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        code: "FACULTY_PROFILE_ERROR",
        message: String(error?.message || error).slice(0, 500)
      }));
    return true;
  }

  return false;
});
