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
        setText("status-title", "K-Supportを開いてください");
        setText("status-note", "ログイン後にシラバス一覧を開くと、表示範囲の授業評価を自動で確認します。");
        return;
      }
      const tabs = Array.isArray(response.tabs) ? response.tabs : [];
      const ready = tabs.some((tab) => tab.ok && tab.hasToken);
      setHidden("login-panel", ready);
      setHidden("open-ksupport", ready);
      setText("status-title", ready ? "シラバス上で自動表示します" : "K-Supportを開いてください");
      setText("status-note", ready
        ? "シラバス一覧をスクロールすると、近くの授業評価を順番に保存して表示します。"
        : "ログイン後にシラバス一覧を開くと、表示範囲の授業評価を自動で確認します。"
      );
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
