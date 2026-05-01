const KSUPPORT_SEARCH_URL = "https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch";
const KSUPPORT_TAB_PATTERN = "https://keiouniversity.my.site.com/students/*";

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
