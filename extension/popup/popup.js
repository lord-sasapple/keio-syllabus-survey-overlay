(() => {
  const { STORAGE_KEYS, storageGet } = window.KeioSurveyShared;

  function countValues(value) {
    if (!value || typeof value !== "object") return 0;
    return new Set(
      Object.values(value)
        .map((entry) => entry?.recordId || JSON.stringify(entry))
        .filter(Boolean)
    ).size;
  }

  function formatLastSeen(lastSeen) {
    if (!lastSeen?.at) return "-";
    const date = new Date(lastSeen.at);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function main() {
    const state = await storageGet({
      [STORAGE_KEYS.courses]: {},
      [STORAGE_KEYS.evaluations]: {},
      [STORAGE_KEYS.lastSeen]: null
    });
    document.getElementById("course-count").textContent = String(countValues(state[STORAGE_KEYS.courses]));
    document.getElementById("evaluation-count").textContent = String(countValues(state[STORAGE_KEYS.evaluations]));
    document.getElementById("last-seen").textContent = formatLastSeen(state[STORAGE_KEYS.lastSeen]);

    chrome.runtime.sendMessage({ type: "keioSurvey.ksupportStatus" }, (response) => {
      const element = document.getElementById("ksupport-status");
      if (chrome.runtime.lastError || !response?.ok) {
        element.textContent = "未接続";
        return;
      }
      const tabs = Array.isArray(response.tabs) ? response.tabs : [];
      const ready = tabs.some((tab) => tab.ok && tab.hasToken);
      element.textContent = ready ? "準備OK" : tabs.length ? "要再読込" : "未検出";
    });
  }

  document.getElementById("open-ksupport").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "keioSurvey.openKSupport" });
  });

  void main();
})();
