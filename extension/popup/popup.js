(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cacheGetMeta,
    storageGet
  } = window.KeioSurveyShared;

  let progressTimer = null;

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
    if (phaseName === "starting") return "開始中";
    if (phaseName === "searching") return "検索分割中";
    if (phaseName === "details") return "詳細・自由記述取得中";
    if (phaseName === "complete") return progress?.coverageComplete === false ? "完了（上限注意）" : "完了";
    if (phaseName === "failed") return "失敗";
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
    const bar = document.getElementById("progress-bar");

    document.getElementById("progress-stage").textContent = phaseText(progress);
    document.getElementById("progress-percent").textContent = percent == null ? "未確認" : `${percent}%`;
    document.getElementById("expected-total").textContent = formatNumber(expected);
    document.getElementById("search-found").textContent = formatNumber(found);
    document.getElementById("detail-progress").textContent = `${formatNumber(detailFetched)} / ${formatNumber(detailTotal)}`;
    document.getElementById("progress-note").textContent = progress.message || (capped ? "まだ 1,500 件上限に当たっている検索条件があります。" : "全件同期を開始すると進捗が表示されます。");
    bar.style.width = `${percent ?? 0}%`;
    bar.classList.toggle("is-running", progress.state === "running");
    bar.classList.toggle("is-warning", capped > 0 || detailFailed > 0);
  }

  function storageMeta(value) {
    return value ? { value } : null;
  }

  async function renderCounts() {
    const state = await storageGet({
      [STORAGE_KEYS.courses]: {},
      [STORAGE_KEYS.evaluations]: {},
      [STORAGE_KEYS.lastSeen]: null,
      [STORAGE_KEYS.lastSyncAllEvaluations]: null,
      [STORAGE_KEYS.lastSyncProgress]: null
    });
    let [cachedCourses, cachedEvaluations, syncMeta, progressMeta] = await Promise.all([
      cacheGetAll("courses").catch(() => []),
      cacheGetAll("evaluations").catch(() => []),
      cacheGetMeta("lastSyncAllEvaluations").catch(() => null),
      cacheGetMeta("lastSyncProgress").catch(() => null)
    ]);
    syncMeta ||= storageMeta(state[STORAGE_KEYS.lastSyncAllEvaluations]);
    progressMeta ||= storageMeta(state[STORAGE_KEYS.lastSyncProgress]);
    const courseCount = Math.max(cachedCourses.length, countValues(state[STORAGE_KEYS.courses]));
    const evaluationCount = Math.max(cachedEvaluations.length, countValues(state[STORAGE_KEYS.evaluations]));
    const commentsCount = cachedEvaluations.filter((evaluation) => commentSectionCount(evaluation) > 0).length;
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
    if (progressMeta?.value?.state === "running" && !progressTimer) {
      progressTimer = setInterval(() => void renderCounts(), 2000);
    }
    if (progressMeta?.value?.state !== "running" && progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }

  function renderKSupportStatus() {
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

  async function main() {
    await renderCounts();
    renderKSupportStatus();
  }

  document.getElementById("open-ksupport").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "keioSurvey.openKSupport" });
  });

  document.getElementById("sync-all").addEventListener("click", () => {
    const message = document.getElementById("debug-message");
    message.textContent = "同期を開始しています...";
    chrome.runtime.sendMessage({ type: "keioSurvey.syncAllEvaluations", options: { includeComments: true } }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        message.textContent = "同期を開始できませんでした。K-Support を開いてログインしてください。";
        return;
      }
      message.textContent = response.started ? "同期を開始しました。しばらくしてから再度開くと件数が更新されます。" : "同期はすでに実行中です。";
      if (!progressTimer) progressTimer = setInterval(() => void renderCounts(), 2000);
      setTimeout(() => void renderCounts(), 1500);
    });
  });

  void main();
})();
