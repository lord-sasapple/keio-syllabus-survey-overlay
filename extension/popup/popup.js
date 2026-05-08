(() => {
  const DEBUG = false;

  function debugLog(label, payload = null) {
    if (!DEBUG) return;
    if (payload == null) {
      console.log(`[KSSO popup] ${label}`);
      return;
    }
    console.log(`[KSSO popup] ${label}`, payload);
  }

  function $(id) {
    const element = document.getElementById(id);
    if (!element) debugLog("missing popup element", { id });
    return element;
  }

  function setText(id, value) {
    const element = $(id);
    if (element) element.textContent = value;
  }

  function setHidden(id, hidden) {
    const element = $(id);
    if (element) element.hidden = hidden;
  }

  function renderKSupportStatus() {
    chrome.runtime.sendMessage({ type: "keioSurvey.ksupportStatus" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setHidden("login-panel", false);
        setHidden("open-ksupport", false);
        return;
      }
      const tabs = Array.isArray(response.tabs) ? response.tabs : [];
      const ready = tabs.some((tab) => tab.ok && tab.hasToken);
      setHidden("login-panel", ready);
      setHidden("open-ksupport", ready);
    });
  }

  $("open-ksupport")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "keioSurvey.openKSupport" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        setText("debug-message", "K-Supportを開けませんでした。");
        return;
      }
      setText("debug-message", "K-Supportを開きました。ログイン後、シラバス一覧を開いてください。");
      window.setTimeout(renderKSupportStatus, 600);
    });
  });

  renderKSupportStatus();
})();
