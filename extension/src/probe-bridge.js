(() => {
  if (window.__keioSurveyProbeBridgeInstalled) return;
  window.__keioSurveyProbeBridgeInstalled = true;

  const { STORAGE_KEYS, storageGet, storageSet } = window.KeioSurveyShared;
  const SOURCE = "keio-survey-page-probe";
  const MAX_EVENTS = 500;

  function injectProbe() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/page-probe.js");
    script.async = false;
    (document.documentElement || document.head).appendChild(script);
    script.remove();
  }

  async function appendEvent(event) {
    if (event?.kind === "ksupport.auraSession") {
      await storageSet({
        [STORAGE_KEYS.ksupportSession]: {
          context: event.context,
          token: event.token,
          pageURI: event.pageURI || "",
          origin: event.origin || location.origin,
          capturedAt: event.capturedAt || Date.now(),
          updatedAt: event.at || new Date().toISOString()
        },
        [STORAGE_KEYS.lastSeen]: {
          url: location.href,
          title: document.title,
          at: new Date().toISOString()
        }
      });
      return;
    }

    const current = await storageGet({ [STORAGE_KEYS.networkEvents]: [] });
    const events = Array.isArray(current[STORAGE_KEYS.networkEvents])
      ? current[STORAGE_KEYS.networkEvents]
      : [];
    events.push({
      pageUrl: location.href,
      pageTitle: document.title,
      ...event
    });
    await storageSet({
      [STORAGE_KEYS.networkEvents]: events.slice(-MAX_EVENTS),
      [STORAGE_KEYS.lastSeen]: {
        url: location.href,
        title: document.title,
        at: new Date().toISOString()
      }
    });
  }

  window.addEventListener("message", (messageEvent) => {
    if (messageEvent.source !== window) return;
    if (messageEvent.origin !== window.location.origin) return;
    const data = messageEvent.data;
    if (!data || data.source !== SOURCE || !data.event) return;
    void appendEvent(data.event);
  });

  injectProbe();
})();
