const KSUPPORT_SEARCH_URL = "https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch";
const KSUPPORT_TAB_PATTERN = "https://keiouniversity.my.site.com/students/*";
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
    const response = await sendTabMessage(tab.id, {
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
    const response = await sendTabMessage(tab.id, {
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
    const response = await sendTabMessage(tab.id, { type: "keioSurvey.ksupportStatus" });
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

  return false;
});
