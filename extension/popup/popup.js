(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cacheGetMeta,
    storageGet
  } = window.KeioSurveyShared;

  let progressTimer = null;
  let optimisticProgress = null;

  function debugLog(label, payload = null) {
    if (payload == null) {
      console.log(`[KSSO popup] ${label}`);
      return;
    }
    console.log(`[KSSO popup] ${label}`, payload);
  }

  function countValues(value) {
    if (!value || typeof value !== "object") return 0;
    return new Set(
      Object.values(value)
        .map((entry) => entry?.recordId || JSON.stringify(entry))
        .filter(Boolean)
    ).size;
  }

  function formatLastSeen(lastSeen) {
    const raw = lastSeen?.at || lastSeen?.finishedAt;
    if (!raw) return "-";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("ja-JP", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function commentSectionCount(evaluation) {
    return Array.isArray(evaluation?.commentSections)
      ? evaluation.commentSections.reduce((sum, section) => sum + (Array.isArray(section.comments) && section.comments.length ? 1 : 0), 0)
      : 0;
  }

  function syncStatusText(meta) {
    const value = meta?.value;
    if (!value) return "未同期";
    if (Array.isArray(value.cappedSegments) && value.cappedSegments.length) return "上限注意";
    if (value.ok) return "完了";
    return "失敗";
  }

  function syncCountText(meta) {
    const value = meta?.value;
    if (!value) return "-";
    const courseCount = Number.isFinite(value.courseCount) ? value.courseCount : "-";
    const fetched = Number.isFinite(value.fetched) ? value.fetched : "-";
    const failed = Number.isFinite(value.failed) ? value.failed : 0;
    const capped = Array.isArray(value.cappedSegments) ? value.cappedSegments.length : 0;
    return `${fetched}/${courseCount}${failed ? ` 失敗${failed}` : ""}${capped ? ` 要分割${capped}` : ""}`;
  }

  function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString("ja-JP") : "-";
  }

  function phaseText(progress) {
    if (progress?.derivedPartial) return "部分キャッシュ";
    const phaseName = progress?.phaseName;
    if (phaseName === "starting") return "同期を開始中";
    if (phaseName === "searching") return "授業一覧を取得中";
    if (phaseName === "details") return "評価データを保存中";
    if (phaseName === "complete") return progress?.coverageComplete === false ? "完了（上限注意）" : "完了";
    if (phaseName === "failed") return "失敗";
    if (progress?.state === "running") return "同期中";
    return "未同期";
  }

  function progressPercent(progress, syncMeta) {
    const useSyncFallback = !progress?.state;
    const expected = Number(progress?.searchExpectedTotal ?? (useSyncFallback ? syncMeta?.value?.searchExpectedTotal : undefined));
    const detailTotal = Number(progress?.detailTotal ?? (useSyncFallback ? syncMeta?.value?.courseCount : undefined));
    const detailFetched = Number(progress?.detailFetched ?? (useSyncFallback ? syncMeta?.value?.fetched : undefined));
    const searchFound = Number(progress?.searchFoundUnique ?? (useSyncFallback ? syncMeta?.value?.courseCount : undefined));
    if (Number.isFinite(detailTotal) && detailTotal > 0 && Number.isFinite(detailFetched)) {
      return Math.max(0, Math.min(100, Math.round((detailFetched / detailTotal) * 100)));
    }
    if (Number.isFinite(expected) && expected > 0 && Number.isFinite(searchFound)) {
      return Math.max(0, Math.min(100, Math.round((searchFound / expected) * 100)));
    }
    return null;
  }

  function renderProgress(progressMeta, syncMeta) {
    const progress = progressMeta?.value || {};
    const sync = syncMeta?.value || {};
    const useSyncFallback = !progress.state;
    const expected = Number(progress.searchExpectedTotal ?? (useSyncFallback ? sync.searchExpectedTotal : undefined));
    const found = Number(progress.searchFoundUnique ?? (useSyncFallback ? sync.courseCount : undefined));
    const detailFetched = Number(progress.detailFetched ?? (useSyncFallback ? sync.fetched : undefined));
    const detailTotal = Number(progress.detailTotal ?? (useSyncFallback ? sync.courseCount : undefined));
    const detailFailed = Number(progress.detailFailed ?? (useSyncFallback ? sync.failed : 0) ?? 0);
    const capped = Number(progress.cappedSegmentsCount ?? (useSyncFallback && Array.isArray(sync.cappedSegments) ? sync.cappedSegments.length : 0));
    const percent = progressPercent(progress, syncMeta);
    const isRunning = progress.state === "running";
    const bar = document.getElementById("progress-bar");

    debugLog("renderProgress", {
      state: progress.state || "none",
      phaseName: progress.phaseName || null,
      expected,
      found,
      detailFetched,
      detailTotal,
      detailFailed,
      capped,
      percent,
      progressUpdatedAt: progress.updatedAt || null,
      syncFinishedAt: sync.finishedAt || null
    });

    document.getElementById("progress-stage").textContent = phaseText(progress);
    document.getElementById("progress-percent").textContent = percent == null ? (isRunning ? "同期中" : "-") : `${percent}%`;
    document.getElementById("expected-total").textContent = formatNumber(expected);
    document.getElementById("search-found").textContent = formatNumber(found);
    document.getElementById("detail-progress").textContent = `${formatNumber(detailFetched)} / ${formatNumber(detailTotal)}`;
    document.getElementById("progress-note").textContent = progress.message || (capped ? "まだ 1,500 件上限に当たっている検索条件があります。" : "同期中はこの画面を閉じても大丈夫です。K-Supportタブは開いたままにしてください。");
    document.getElementById("cache-detail").textContent = Number.isFinite(detailFetched) || Number.isFinite(detailTotal)
      ? `保存済み評価 ${formatNumber(detailFetched)} / ${formatNumber(detailTotal)} 件${detailFailed ? `（失敗 ${formatNumber(detailFailed)} 件）` : ""}`
      : "保存済み評価 - 件";
    bar.style.width = percent == null ? (isRunning ? "100%" : "0%") : `${percent}%`;
    bar.classList.toggle("is-running", isRunning);
    bar.classList.toggle("is-indeterminate", isRunning && percent == null);
    bar.classList.toggle("is-warning", capped > 0 || detailFailed > 0);
  }

  function storageMeta(value) {
    return value ? { value } : null;
  }

  function renderReadiness({ evaluationCount, progressMeta, syncMeta, ksupportReady = null }) {
    const progress = progressMeta?.value || {};
    const sync = syncMeta?.value || {};
    const title = document.getElementById("readiness-title");
    const note = document.getElementById("readiness-note");
    if (progress.state === "running") {
      title.textContent = "同期中";
      note.textContent = "授業評価を保存しています。進み具合は下に表示されます。";
      return;
    }
    if (evaluationCount > 0) {
      title.textContent = "表示できます";
      note.textContent = `${evaluationCount.toLocaleString("ja-JP")}件の授業評価をシラバス上で表示できます。`;
      return;
    }
    if (sync.ok === false) {
      title.textContent = "同期に失敗";
      note.textContent = "K-Supportを開いてログインし直してから、もう一度同期してください。";
      return;
    }
    title.textContent = ksupportReady ? "同期できます" : "未同期";
    note.textContent = ksupportReady
      ? "K-Supportに接続できています。授業評価を同期できます。"
      : "まずK-Supportを開いてログインしてください。";
  }

  async function renderCounts() {
    debugLog("renderCounts:start");
    const state = await storageGet({
      [STORAGE_KEYS.courses]: {},
      [STORAGE_KEYS.evaluations]: {},
      [STORAGE_KEYS.lastSeen]: null,
      [STORAGE_KEYS.lastSyncAllEvaluations]: null,
      [STORAGE_KEYS.lastSyncProgress]: null
    });
    let [cachedCourses, cachedEvaluations, syncMeta, progressMeta] = await Promise.all([
      cacheGetAll("courses").catch((error) => {
        console.warn("[KSSO popup] cacheGetAll(courses) failed", error);
        return [];
      }),
      cacheGetAll("evaluations").catch((error) => {
        console.warn("[KSSO popup] cacheGetAll(evaluations) failed", error);
        return [];
      }),
      cacheGetMeta("lastSyncAllEvaluations").catch((error) => {
        console.warn("[KSSO popup] cacheGetMeta(lastSyncAllEvaluations) failed", error);
        return null;
      }),
      cacheGetMeta("lastSyncProgress").catch((error) => {
        console.warn("[KSSO popup] cacheGetMeta(lastSyncProgress) failed", error);
        return null;
      })
    ]);
    syncMeta ||= storageMeta(state[STORAGE_KEYS.lastSyncAllEvaluations]);
    progressMeta ||= storageMeta(state[STORAGE_KEYS.lastSyncProgress]) || optimisticProgress;
    const courseCount = Math.max(cachedCourses.length, countValues(state[STORAGE_KEYS.courses]));
    const evaluationCount = Math.max(cachedEvaluations.length, countValues(state[STORAGE_KEYS.evaluations]));
    const commentsCount = cachedEvaluations.filter((evaluation) => commentSectionCount(evaluation) > 0).length;

    debugLog("renderCounts:data", {
      cachedCourses: cachedCourses.length,
      cachedEvaluations: cachedEvaluations.length,
      storageCourses: countValues(state[STORAGE_KEYS.courses]),
      storageEvaluations: countValues(state[STORAGE_KEYS.evaluations]),
      syncMeta: syncMeta?.value || null,
      progressMeta: progressMeta?.value || null
    });

    document.getElementById("course-count").textContent = String(courseCount);
    document.getElementById("evaluation-count").textContent = String(evaluationCount);
    document.getElementById("comment-count").textContent = String(commentsCount);
    document.getElementById("last-seen").textContent = formatLastSeen(syncMeta?.value) !== "-" ? formatLastSeen(syncMeta.value) : formatLastSeen(state[STORAGE_KEYS.lastSeen]);
    document.getElementById("sync-status").textContent = syncMeta?.value ? syncStatusText(syncMeta) : evaluationCount ? "部分保存" : "未同期";
    document.getElementById("sync-count").textContent = syncMeta?.value ? syncCountText(syncMeta) : evaluationCount ? `${evaluationCount}/-` : "-";
    if (!progressMeta?.value && (courseCount || evaluationCount)) {
      progressMeta = storageMeta({
        derivedPartial: true,
        message: "保存済みデータはありますが、全件同期のメタ情報がありません。K-Support にログインして同期すると慶應全体の件数と進捗を確認できます。",
        searchFoundUnique: courseCount || null,
        detailFetched: evaluationCount || null
      });
    }
    renderProgress(progressMeta, syncMeta);
    renderReadiness({ evaluationCount, progressMeta, syncMeta });
    if (progressMeta?.value?.state === "running" && !progressTimer) {
      debugLog("progressTimer:start");
      progressTimer = setInterval(() => void renderCounts(), 2000);
    }
    if (progressMeta?.value?.state !== "running" && progressTimer) {
      debugLog("progressTimer:stop", { state: progressMeta?.value?.state || null });
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function renderKSupportStatus() {
    debugLog("ksupportStatus:request");
    chrome.runtime.sendMessage({ type: "keioSurvey.ksupportStatus" }, (response) => {
      const element = document.getElementById("ksupport-status");
      if (chrome.runtime.lastError || !response?.ok) {
        console.warn("[KSSO popup] ksupportStatus failed", chrome.runtime.lastError, response);
        element.textContent = "未接続";
        return;
      }
      const tabs = Array.isArray(response.tabs) ? response.tabs : [];
      const ready = tabs.some((tab) => tab.ok && tab.hasToken);
      debugLog("ksupportStatus:response", { ready, tabs });
      element.textContent = ready ? "準備OK" : tabs.length ? "要再読込" : "未検出";
      void renderCounts().then(() => renderReadiness({
        evaluationCount: Number(document.getElementById("evaluation-count").textContent) || 0,
        progressMeta: optimisticProgress,
        syncMeta: null,
        ksupportReady: ready
      }));
    });
  }

  async function main() {
    debugLog("main:start");
    await renderCounts();
    renderKSupportStatus();
  }

  document.getElementById("open-ksupport").addEventListener("click", () => {
    debugLog("openKSupport:click");
    chrome.runtime.sendMessage({ type: "keioSurvey.openKSupport" }, (response) => {
      debugLog("openKSupport:response", response || chrome.runtime.lastError?.message);
    });
  });

  document.getElementById("sync-all").addEventListener("click", () => {
    const message = document.getElementById("debug-message");
    debugLog("syncAll:click", { includeComments: false });
    optimisticProgress = storageMeta({
      state: "running",
      phaseName: "starting",
      message: "K-Supportに同期開始を依頼しました。最初の件数取得まで少し待ってください。",
      startedAt: new Date().toISOString()
    });
    message.textContent = "同期を開始しています...";
    void renderCounts();
    chrome.runtime.sendMessage({ type: "keioSurvey.syncAllEvaluations", options: { includeComments: false } }, (response) => {
      debugLog("syncAll:response", response || chrome.runtime.lastError?.message);
      if (chrome.runtime.lastError || !response?.ok) {
        optimisticProgress = null;
        message.textContent = "同期を開始できませんでした。K-Support を開いてログインしてください。";
        void renderCounts();
        return;
      }
      message.textContent = response.started ? "同期を開始しました。進み具合は上に表示されます。" : "同期はすでに実行中です。進み具合を確認しています。";
      if (!progressTimer) {
        debugLog("progressTimer:startAfterSyncClick");
        progressTimer = setInterval(() => void renderCounts(), 2000);
      }
      setTimeout(() => void renderCounts(), 800);
      setTimeout(() => void renderCounts(), 2000);
    });
  });

  void main();
})();
