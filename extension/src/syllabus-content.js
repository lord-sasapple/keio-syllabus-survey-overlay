(() => {
  const {
    STORAGE_KEYS,
    cacheGetAll,
    cachePut,
    compactCourseKey,
    normalizeText,
    scoreCourseMatch,
    storageGet,
    storageSet,
  } = window.KeioSurveyShared;

  const ROOT_ID = "keio-survey-overlay-root";
  const BEAR_ROOT_ID = "keio-survey-bear-root";
  const STYLE_ID = "keio-survey-overlay-style";
  const KSUPPORT_SEARCH_URL =
    "https://keiouniversity.my.site.com/students/s/ClassEvaluationSearch";
  const FETCH_TIMEOUT_MS = 45 * 1000;
  const MISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const CHOICE_LABELS = [
    "1 そう思わない",
    "2 あまりそう思わない",
    "3 どちらともいえない",
    "4 ややそう思う",
    "5 そう思う",
  ];
  // const CHOICE_COLORS = ["#f27b6b", "#f6ba9c", "#c39bfa", "#9abaf7", "#5681ee"];
  const CHOICE_COLORS = ["#5681ee", "#9ab3f2", "#f7cca0", "#f9c366", "#f59e0b"];
  const BEAR_FALLBACK_COMMENT =
    "コメント欄は静かめだね。つまり、履修判断まで自力で鍛えてくれるタイプかな。";
  const KSUPPORT_LOGIN_BEAR_MESSAGE = "アンケート結果を読み込むために、";
  const KSUPPORT_LOGIN_BEAR_AFTER_LINK =
    "K-Supportを開いてログインしてね。できたらこのタブに戻って再読み込みしてね。";
  const TWEET_CHAR_LIMIT = 140;
  const TWEET_CLICK_THRESHOLD = 3;
  const TWEET_CLICK_WINDOW_MS = 900;

  function readText(selector, root = document) {
    return normalizeText(root.querySelector(selector)?.textContent || "");
  }

  function readInfoMap() {
    const map = new Map();
    for (const row of document.querySelectorAll(
      ".syllabus-header tr, #screen-detail tr",
    )) {
      const label = normalizeText(row.querySelector("th")?.textContent || "");
      const value = normalizeText(row.querySelector("td")?.textContent || "");
      if (label && value) map.set(label, value);
    }
    return map;
  }

  function pick(map, patterns) {
    for (const [label, value] of map.entries()) {
      if (patterns.some((pattern) => pattern.test(label))) return value;
    }
    return "";
  }

  function parseSyllabusCourse() {
    const info = readInfoMap();
    const url = new URL(location.href);
    return {
      courseName:
        readText(".syllabus-header h2.class-name") ||
        readText("h2.class-name") ||
        readText("h1,h2"),
      lecturer: pick(info, [/担当/, /教員/, /Lecturer|Instructor/i]),
      semester:
        pick(info, [/学期/, /Semester|Term/i]) ||
        url.searchParams.get("ttblyr") ||
        "",
      dayPeriod: pick(info, [/曜日|時限/, /Day|Period/i]),
      campus: pick(info, [/キャンパス/, /Campus/i]),
      faculty: pick(info, [/学部|研究科|設置/, /Faculty|Department/i]),
      registrationNumber: url.searchParams.get("entno") || "",
    };
  }

  function isSyllabusDetailPage() {
    const path = location.pathname;
    if (/\/(?:pub-)?syllabus\/detail(?:\/|$)/.test(path)) return true;

    const url = new URL(location.href);
    return (
      url.searchParams.has("entno") &&
      Boolean(document.querySelector(".syllabus-header, #screen-detail"))
    );
  }

  function hasCourseIdentity(syllabus) {
    return Boolean(
      syllabus.registrationNumber ||
      (syllabus.courseName &&
        (syllabus.lecturer || syllabus.semester || syllabus.campus)),
    );
  }

  function runtimeMessage(message, options = {}) {
    const timeoutMs =
      Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : null;
    return new Promise((resolve) => {
      let settled = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            settled = true;
            resolve({
              ok: false,
              code: "RUNTIME_MESSAGE_TIMEOUT",
              message: "K-Support から時間内に応答がありませんでした。",
            });
          }, timeoutMs)
        : null;
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            code: "RUNTIME_MESSAGE_FAILED",
            message: chrome.runtime.lastError.message,
          });
          return;
        }
        resolve(response || { ok: false, code: "EMPTY_RUNTIME_RESPONSE" });
      });
    });
  }

  function objectStore(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  }

  function courseFetchKey(course) {
    return (
      compactCourseKey(course) ||
      [
        normalizeText(course.courseName),
        normalizeText(course.lecturer).replace(/\s+/g, ""),
        normalizeText(course.registrationNumber),
      ].join("|")
    );
  }

  function hasFreshMiss(missStore, key) {
    const miss = objectStore(missStore)[key];
    if (!miss) return false;
    const at = Date.parse(miss.at || "");
    return Number.isFinite(at) && Date.now() - at < MISS_TTL_MS;
  }

  async function rememberMiss(key, course, code = "NO_MATCH") {
    if (!key) return;
    const current = await storageGet({ [STORAGE_KEYS.evaluationMisses]: {} });
    const misses = objectStore(current[STORAGE_KEYS.evaluationMisses]);
    misses[key] = {
      at: new Date().toISOString(),
      code,
      courseName: course.courseName,
      lecturer: course.lecturer,
      semester: course.semester,
      campus: course.campus,
    };
    await storageSet({ [STORAGE_KEYS.evaluationMisses]: misses });
  }

  function uniqueEvaluations(store) {
    const seen = new Set();
    const evaluations = [];
    for (const value of Object.values(store || {})) {
      if (!value || typeof value !== "object") continue;
      const id = value.recordId || JSON.stringify(value.course || {});
      if (seen.has(id)) continue;
      seen.add(id);
      evaluations.push(value);
    }
    return evaluations;
  }

  function findBestEvaluation(syllabus, evaluations) {
    let best = null;
    for (const evaluation of evaluations) {
      const score = scoreCourseMatch(syllabus, evaluation.course || {});
      if (!best || score > best.score) best = { evaluation, score };
    }
    return best && best.score >= 55 ? best : null;
  }

  function normalizeCommentSections(sections) {
    return Array.isArray(sections)
      ? sections
          .map((section) => ({
            kind: normalizeText(section.kind),
            title: normalizeText(section.title),
            en: normalizeText(section.en),
            comments: Array.isArray(section.comments)
              ? section.comments
                  .map((comment) => normalizeText(comment))
                  .filter(Boolean)
                  .slice(0, 30)
              : [],
          }))
          .filter((section) => section.comments.length)
      : [];
  }

  function normalizeEvaluation(event, options = {}) {
    const course = event.course || {};
    const evaluation = {
      source: "keio-ksupport-ksei",
      recordId: normalizeText(event.recordId),
      capturedAt: event.capturedAt || event.at || new Date().toISOString(),
      course: {
        recordId: normalizeText(event.recordId || course.recordId),
        courseName: normalizeText(course.courseName),
        lecturer: normalizeText(course.lecturer),
        semester: normalizeText(course.semester),
        dayPeriod: normalizeText(course.dayPeriod),
        campus: normalizeText(course.campus),
        faculty: normalizeText(course.faculty),
        answerPercent:
          typeof course.answerPercent === "number"
            ? course.answerPercent
            : null,
      },
      questions: Array.isArray(event.questions)
        ? event.questions.map((question) => ({
            index: question.index,
            ja: normalizeText(question.ja),
            en: normalizeText(question.en),
            avg: typeof question.avg === "number" ? question.avg : null,
            counts: Array.isArray(question.counts)
              ? question.counts.slice(0, 5).map((count) => Number(count) || 0)
              : [],
          }))
        : [],
    };
    if (options.includeComments) {
      evaluation.commentSections = normalizeCommentSections(
        event.commentSections,
      );
    }
    return evaluation;
  }

  async function saveEvaluation(event) {
    const evaluation = normalizeEvaluation(event, { includeComments: true });
    if (!evaluation.recordId && !evaluation.questions.length) return;
    const storageEvaluation = {
      ...evaluation,
      commentSections: [],
    };
    const current = await storageGet({
      [STORAGE_KEYS.courses]: {},
      [STORAGE_KEYS.evaluations]: {},
    });
    const courses = objectStore(current[STORAGE_KEYS.courses]);
    const evaluations = objectStore(current[STORAGE_KEYS.evaluations]);
    const key = compactCourseKey(evaluation.course);

    if (evaluation.recordId) {
      courses[`record:${evaluation.recordId}`] = {
        ...evaluation.course,
        recordId: evaluation.recordId,
      };
      evaluations[`record:${evaluation.recordId}`] = storageEvaluation;
    }
    if (key.replace(/\|/g, "")) {
      courses[`key:${key}`] = {
        ...evaluation.course,
        recordId: evaluation.recordId,
      };
      evaluations[`key:${key}`] = storageEvaluation;
    }
    await cachePut("evaluations", evaluation);
    if (evaluation.course?.recordId)
      await cachePut("courses", evaluation.course);

    await storageSet({
      [STORAGE_KEYS.courses]: courses,
      [STORAGE_KEYS.evaluations]: evaluations,
      [STORAGE_KEYS.lastSeen]: {
        url: location.href,
        title: document.title,
        at: new Date().toISOString(),
      },
    });
  }

  function formatPercent(value) {
    return typeof value === "number"
      ? `${value.toFixed(1).replace(/\.0$/, "")}%`
      : "-";
  }

  function formatAvg(value) {
    return typeof value === "number" ? value.toFixed(2) : "-";
  }

  function renderRating(value) {
    const score =
      typeof value === "number" ? clampPercent((value / 5) * 100) : 0;
    return `
      <span class="ksso-rating">
        <span class="ksso-rating-number">${formatAvg(value)}</span>
        <span class="ksso-stars" aria-label="5点中 ${formatAvg(value)}">
          <span class="ksso-stars-base">★★★★★</span>
          <span class="ksso-stars-fill" style="width: ${score}%">★★★★★</span>
        </span>
      </span>
    `;
  }

  function renderStars(value) {
    const score =
      typeof value === "number" ? clampPercent((value / 5) * 100) : 0;
    return `
      <span class="ksso-stars" aria-label="5点中 ${formatAvg(value)}">
        <span class="ksso-stars-base">★★★★★</span>
        <span class="ksso-stars-fill" style="width: ${score}%">★★★★★</span>
      </span>
    `;
  }

  function choiceTotal(counts) {
    return counts.reduce((sum, count) => sum + count, 0);
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, value));
  }

  function choicePercent(count, total) {
    return total ? (count / total) * 100 : null;
  }

  function renderLegend() {
    return `
      <div class="ksso-legend" aria-label="回答選択肢">
        ${CHOICE_LABELS.map(
          (label, index) => `
          <span class="ksso-legend-item">
            <span class="ksso-swatch" style="background: ${CHOICE_COLORS[index]}"></span>
            <span>${escapeHtml(label)}</span>
          </span>
        `,
        ).join("")}
      </div>
    `;
  }

  function renderChoiceRows(counts, total) {
    return `
      <div class="ksso-choice-rows" aria-label="回答分布">
        ${[4, 3, 2, 1, 0]
          .map((index) => {
            const percent = clampPercent(
              choicePercent(counts[index] || 0, total) || 0,
            );
            return `
            <div class="ksso-choice-row">
              <span class="ksso-choice-row-label">${index + 1}</span>
              <span class="ksso-choice-track">
                <span
                  class="ksso-choice-fill"
                  style="width: ${percent}%; background: ${CHOICE_COLORS[index]}"
                ></span>
              </span>
            </div>
          `;
          })
          .join("")}
      </div>
    `;
  }

  function isReversedWorkloadQuestion(question) {
    const text = normalizeText(`${question?.ja || ""} ${question?.en || ""}`);
    if (/適切/.test(text)) return false;
    return /負荷/.test(text) && /(大きすぎ|大き過ぎ|重すぎ|重過ぎ)/.test(text);
  }

  function displayQuestion(question) {
    if (!isReversedWorkloadQuestion(question)) {
      return {
        avg: question.avg,
        counts: Array.isArray(question.counts) ? question.counts : [],
        title: question.ja || question.en || `Q${question.index}`,
        reversed: false,
      };
    }
    const avg = typeof question.avg === "number" ? 6 - question.avg : null;
    return {
      avg,
      counts: Array.isArray(question.counts)
        ? question.counts.slice().reverse()
        : [],
      title: `Q${question.index} 学修の負荷は適切だった`,
      reversed: true,
    };
  }

  function renderCommentSections(sections) {
    const visibleSections = normalizeCommentSections(sections);
    if (!visibleSections.length) return "";
    return `
      <div class="ksso-comments">
        <div class="ksso-section-title">自由記述コメント</div>
        ${visibleSections
          .map(
            (section) => `
          <section class="ksso-comment-section ksso-comment-${escapeHtml(section.kind || "other")}">
            <h4><span class="ksso-comment-tone" aria-hidden="true"></span>${escapeHtml(section.title)}</h4>
            <div class="ksso-comment-bubbles">
              ${section.comments.map((comment) => `<p class="ksso-comment-bubble">${escapeHtml(comment)}</p>`).join("")}
            </div>
          </section>
        `,
          )
          .join("")}
      </div>
    `;
  }

  function flattenComments(sections) {
    return normalizeCommentSections(sections)
      .flatMap((section) => section.comments)
      .map((comment) => normalizeText(comment))
      .filter(Boolean);
  }

  function commentHash(comments) {
    return comments
      .join("|")
      .split("")
      .reduce((hash, char) => {
        return (hash * 31 + char.charCodeAt(0)) >>> 0;
      }, 7);
  }

  function includesAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
  }

  function pickByHash(values, hash) {
    if (!values.length) return BEAR_FALLBACK_COMMENT;
    return values[hash % values.length];
  }

  function buildBearFallbackComment(comments) {
    if (!comments.length) return BEAR_FALLBACK_COMMENT;
    const text = normalizeText(comments.join(" "));
    const hash = commentHash(comments);
    const candidates = [];

    if (includesAny(text, [/課題|レポート|宿題|負荷|重い|多い|忙し|大変/])) {
      candidates.push(
        "授業を取ったつもりが、課題の方から履修してくるタイプっぽいね。",
        "内容より課題が主役になりそう。睡眠時間、先に退学届を出してるかも。",
      );
    }
    if (
      includesAny(text, [
        /評価|基準|採点|成績|ルーブリック|わかりづら|分かりづら|不明/,
      ])
    ) {
      candidates.push(
        "評価基準が霧なら、努力は遭難するね。コンパス持って履修しよ。",
        "採点ルールが見えない授業、学生だけ暗闇でダンスさせられがち。",
      );
    }
    if (includesAny(text, [/グループ|班|発表|ディスカッション|議論|温度差/])) {
      candidates.push(
        "グループワークは学びもあるけど、メンバーガチャの筐体でもあるね。",
        "議論できるのは良いね。温度差で風邪ひく準備だけしておこ。",
      );
    }
    if (
      includesAny(text, [
        /わかりやす|分かりやす|丁寧|質問|面白|楽しい|よかった|良かった/,
      ])
    ) {
      candidates.push(
        "先生は当たりっぽいね。あとは締切が人の心を持ってるかだけ。",
        "評判は良さげ。ただ褒め言葉の裏に課題モンスターが寝てるかも。",
      );
    }
    if (
      includesAny(text, [/資料|スライド|説明|進行|連絡|遅い|早い|オンライン/])
    ) {
      candidates.push(
        "運営の相性は見とこ。連絡が迷子になる授業、学生も一緒に遭難するから。",
        "内容の前に進行が勝負っぽいね。授業というより交通整理の才能テスト。",
      );
    }

    if (!candidates.length) {
      candidates.push(
        "良い点も不安もあるね。履修登録ボタンがちょっと笑って見えるタイプ。",
        "コメントは静かだけど油断は禁物。静かな沼ほど靴を返してくれない。",
      );
    }
    return pickByHash(candidates, hash);
  }

  function charLength(value) {
    return Array.from(String(value || "")).length;
  }

  function tweetHeader(evaluation, mode = "full") {
    const course = evaluation?.course || {};
    const courseName = normalizeText(course.courseName) || "授業レビュー";
    const lecturer = normalizeText(course.lecturer);
    if (mode === "minimal") return "【口コミ紹介】授業レビュー";
    if (mode === "course") return `【口コミ紹介】${courseName}`;
    return `【口コミ紹介】${courseName}${lecturer ? ` (${lecturer})` : ""}`;
  }

  function ratingStars(evaluation) {
    const questions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
    const overall = questions.find((question) => question.index === 7);
    if (typeof overall?.avg !== "number") return "";
    const rounded = Math.max(0, Math.min(5, Math.round(overall.avg)));
    return `${"★".repeat(rounded)}${"☆".repeat(5 - rounded)}`;
  }

  function ratingLine(evaluation) {
    const questions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
    const overall = questions.find((question) => question.index === 7);
    const value =
      typeof overall?.avg === "number" ? overall.avg.toFixed(1).replace(/\.0$/, "") : "-";
    return `総合満足度: ★${value}`;
  }

  function splitExactReviewFragments(comment) {
    const text = String(comment || "").trim();
    if (!text) return [];
    const fragments = [text];
    const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [];
    fragments.push(...sentences.map((sentence) => sentence.trim()).filter(Boolean));
    fragments.push(
      ...text
        .split(/[、，]/)
        .map((fragment) => fragment.trim())
        .filter((fragment) => charLength(fragment) >= 12),
    );
    return fragments;
  }

  function punchlineScore(review) {
    const text = normalizeText(review);
    const keywordPatterns = [
      /イケイケ|バキバキ|地獄|罠|沼|謎|虚無|鬼|無理|しんど|きつ|つら|重い|多い|忙し|大変/,
      /課題|レポート|宿題|負荷|締切|評価|基準|採点|成績|不明|わかりづら|分かりづら/,
      /自信はない|上がらない|できない|ない|だけ|とは限らない|わけではない|ほぼ|大部分/,
      /グループ|班|発表|プレゼン|ディスカッション|温度差|ガチャ/,
    ];
    const keywordScore = keywordPatterns.reduce(
      (score, pattern) => score + (pattern.test(text) ? 16 : 0),
      0,
    );
    const length = charLength(text);
    const lengthScore = length >= 28 && length <= 72 ? 18 : length >= 14 && length <= 95 ? 8 : 0;
    const punctuationScore = /[。！？!?]$/.test(text) ? 4 : 0;
    return keywordScore + lengthScore + punctuationScore;
  }

  function tweetBearCommentOptions(review, evaluation) {
    const text = normalizeText(review);
    const stars = ratingStars(evaluation);
    const comments = [];
    if (/英語|語学/.test(text)) {
      comments.push("英語力は自力発電っぽい。", "英語は別売りっぽい。");
    }
    if (/課題|レポート|宿題|負荷|締切|忙し|大変|重い|多い/.test(text)) {
      comments.push("課題が本体の授業かも。", "生活リズムが収穫されそう。");
    }
    if (/シラバス|異な|違う|違っ|違い/.test(text)) {
      comments.push("シラバスが予告編で本編が別物なの、普通に困るね。");
      comments.push("契約書と納品物が違うやつ。授業でやるな。");
    }
    if (/読み上げ|読むだけ|読んでいるだけ|資料/.test(text)) {
      comments.push("資料読み上げ会なら、せめて朗読単位って書いといてほしい。");
      comments.push("授業というより資料の音声化サービスっぽい。");
    }
    if (/評価|基準|採点|成績|不明|わかりづら|分かりづら/.test(text)) {
      comments.push("評価方法がズレるのは、学生の努力を迷子にするやつ。", "採点ルール、霧深め。");
    }
    if (/グループ|班|発表|プレゼン|ディスカッション|温度差/.test(text)) {
      comments.push("メンバーガチャも単位の一部。", "発表筋は鍛えられそう。");
    }
    if (stars) comments.push(`なのに満足度は${stars}。何が起きた。`);
    comments.push("履修登録ボタンが笑ってる。", "静かな沼の気配。", "覚悟だけ先に履修しよ。", "なるほどね。");
    return [...new Set(comments)].sort((a, b) => charLength(b) - charLength(a));
  }

  function tweetBearSystemPrompt(maxChars) {
    return `
あなたは黄色と白の横ボーダー水着を着た、履修登録に脳を焼かれたしろくまのマスコットです。
口コミ紹介ツイートに添える「クマのコメント」だけを日本語で返してください。
条件:
- ${maxChars}文字以内
- 1文だけ
- 皮肉は強め
- 口コミを書いた学生の不満に同調する
- 皮肉の矛先は学生ではなく、授業設計・運営・評価方法・シラバスとのズレに向ける
- でも学生や教員への人格攻撃、差別、容姿いじりはしない
- 丁寧語・敬語を使わない
- 「ですね」「でしょう」「ようです」「かもしれません」を使わない
- 口コミ本文を引用・要約・改変しない
- 学生を煽る表現を使わない
- 「勘違いじゃね？」のように口コミを書いた人を疑う言い方をしない
- 余計な前置きや引用符を付けない
良い例:
- シラバスと違う評価方法は、学生の努力を迷子にするやつ。
- 資料読み上げ会なら、最初から朗読単位って書いといてほしい。
悪い例:
- それってただの勘違いじゃね？
- 期待しすぎちゃった？
`.trim();
  }

  function formatTweetBearPrompt(review, evaluation, maxChars) {
    const rating = ratingLine(evaluation);
    return `
クマのコメント上限: ${maxChars}文字
${rating}
口コミ:
${review}
`.trim();
  }

  function cleanTweetBearComment(value) {
    return normalizeText(value)
      .replace(/^["「『]+|["」』]+$/g, "")
      .replace(/^クマのコメント[:：]\s*/, "");
  }

  async function generateTweetBearComment(review, evaluation, maxChars) {
    const fallback =
      tweetBearCommentOptions(review, evaluation).find(
        (comment) => charLength(comment) <= maxChars,
      ) || "";
    if (maxChars < 4) return fallback;
    try {
      if (typeof window === "undefined" || !("LanguageModel" in window)) {
        return fallback;
      }
      const modelOptions = {
        expectedInputs: [{ type: "text", languages: ["ja"] }],
        expectedOutputs: [{ type: "text", languages: ["ja"] }],
      };
      const availability =
        await window.LanguageModel.availability(modelOptions);
      if (availability === "unavailable") return fallback;
      let session = null;
      try {
        session = await window.LanguageModel.create({
          ...modelOptions,
          initialPrompts: [
            { role: "system", content: tweetBearSystemPrompt(maxChars) },
          ],
        });
        const result = await session.prompt(
          formatTweetBearPrompt(review, evaluation, maxChars),
        );
        const text = cleanTweetBearComment(result);
        return text && charLength(text) <= maxChars ? text : fallback;
      } finally {
        session?.destroy?.();
      }
    } catch (error) {
      console.warn("Syllabus Lens tweet bear comment failed", error);
      return fallback;
    }
  }

  async function composeTweetText(evaluation) {
    const comments = flattenComments(evaluation?.commentSections);
    const reviewCandidates = comments
      .flatMap(splitExactReviewFragments)
      .map((review, index) => ({ review, index, score: punchlineScore(review) }))
      .filter((candidate) => candidate.review)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const headerModes = ["full", "course", "minimal"];
    for (const candidate of reviewCandidates) {
      for (const headerMode of headerModes) {
        const header = tweetHeader(evaluation, headerMode);
        const prefix = `${header}\n${ratingLine(evaluation)}\n${candidate.review}\n\nクマのコメント\n`;
        const maxCommentLength = TWEET_CHAR_LIMIT - charLength(prefix);
        if (maxCommentLength < 4) continue;
        const bearComment = await generateTweetBearComment(
          candidate.review,
          evaluation,
          maxCommentLength,
        );
        if (!bearComment) continue;
        const tweet = `${prefix}${bearComment}`;
        if (charLength(tweet) <= TWEET_CHAR_LIMIT) return tweet;
      }
    }
    return "";
  }

  async function openTweetComposer(evaluation) {
    const tweetText = await composeTweetText(evaluation);
    if (!tweetText) return;
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function bindBearTweetShortcut(root, evaluation) {
    const stage = root.querySelector("[data-ksso-bear-stage]");
    if (!stage || !flattenComments(evaluation?.commentSections).length) return;
    stage.title = "3回クリックで口コミ紹介をツイート";
    let clickCount = 0;
    let firstClickAt = 0;
    stage.addEventListener("click", () => {
      const now = Date.now();
      if (now - firstClickAt > TWEET_CLICK_WINDOW_MS) {
        clickCount = 0;
        firstClickAt = now;
      }
      clickCount += 1;
      if (clickCount < TWEET_CLICK_THRESHOLD) return;
      clickCount = 0;
      firstClickAt = 0;
      void openTweetComposer(evaluation);
    });
  }

  function bearSystemPrompt() {
    return `
あなたは黄色と白の横ボーダー水着を着た、履修登録に脳を焼かれたしろくまのマスコットです。
履修を迷っている友だちの横で、授業レビューを読んでかなり毒のある感想を日本語で1文だけ返してください。
条件:
- 皮肉はかなり強め
- でも学生や教員への人格攻撃、差別、容姿いじりはしない
- 授業設計・課題量・評価基準・運営・履修リスクをネタにする
- 丁寧語・敬語を使わない
- 「ですね」「でしょう」「ようです」「かもしれません」を使わない
- 「一方」「貢献」「疑問が残る」「改善点」「課題の両面」のような講評っぽい言葉を使わない
- 30字から65字くらい
- 断定しすぎない
- 授業レビュー本文をそのまま引用しない
- 個人が特定されそうな内容には触れない
文体例:
- 先生は良さそう。ただ英語力アップは、別売りオプション扱いかもね。
- プレゼンは鍛えられそう。英語力は校舎の外で自力発電っぽい。
- 評価基準が見えないなら、努力が夜道で財布落とすタイプの授業だね。
- 課題が多い授業、単位じゃなくて生活リズムを収穫してくるんだよな。
`.trim();
  }

  function formatBearPrompt(comments) {
    return `
授業レビュー:
${comments
  .slice(0, 8)
  .map((comment, index) => `${index + 1}. ${comment}`)
  .join("\n")}
`.trim();
  }

  async function generateBearComment(comments) {
    const fallback = buildBearFallbackComment(comments);
    try {
      if (
        !comments.length ||
        typeof window === "undefined" ||
        !("LanguageModel" in window)
      ) {
        return fallback;
      }
      const modelOptions = {
        expectedInputs: [{ type: "text", languages: ["ja"] }],
        expectedOutputs: [{ type: "text", languages: ["ja"] }],
      };
      const availability =
        await window.LanguageModel.availability(modelOptions);
      if (availability === "unavailable") return fallback;
      let session = null;
      try {
        session = await window.LanguageModel.create({
          ...modelOptions,
          initialPrompts: [{ role: "system", content: bearSystemPrompt() }],
        });
        const result = await session.prompt(formatBearPrompt(comments));
        const text = normalizeText(result).replace(/^["「]+|["」]+$/g, "");
        return text || fallback;
      } finally {
        session?.destroy?.();
      }
    } catch (error) {
      console.warn("Syllabus Lens bear comment failed", error);
      return fallback;
    }
  }

  function renderBearSvg(thinking = false) {
    const eyes = thinking
      ? `
        <g>
          <path d="M92 106 Q102 99 112 106" fill="none" stroke="#06112e" stroke-width="4" stroke-linecap="round" />
          <path d="M148 106 Q158 99 168 106" fill="none" stroke="#06112e" stroke-width="4" stroke-linecap="round" />
        </g>
      `
      : `
        <g>
          <ellipse cx="102" cy="106" rx="8.5" ry="11" fill="#06112e" />
          <ellipse cx="158" cy="106" rx="8.5" ry="11" fill="#06112e" />
          <circle cx="105" cy="101" r="2.4" fill="white" opacity="0.95" />
          <circle cx="161" cy="101" r="2.4" fill="white" opacity="0.95" />
        </g>
      `;
    return `
      <svg class="ksso-bear-svg" viewBox="0 0 260 320" role="img" aria-label="Syllabus Lens のクマのマスコット">
        <defs>
          <radialGradient id="ksso-bear-fur" cx="42%" cy="30%" r="75%">
            <stop offset="0%" stop-color="#fffaf0" />
            <stop offset="100%" stop-color="#efe1c9" />
          </radialGradient>
          <linearGradient id="ksso-bear-stripe" x1="0" x2="1">
            <stop offset="0%" stop-color="#f7b500" />
            <stop offset="100%" stop-color="#ffd25a" />
          </linearGradient>
          <clipPath id="ksso-bear-romper">
            <path d="M78 174 C82 143 101 126 130 126 C159 126 178 143 182 174 L190 238 C194 269 173 291 145 291 L115 291 C87 291 66 269 70 238Z" />
          </clipPath>
        </defs>
        <ellipse cx="130" cy="302" rx="70" ry="12" fill="#d6c5ad" opacity="0.28" />
        <path d="M78 174 C82 143 101 126 130 126 C159 126 178 143 182 174 L190 238 C194 269 173 291 145 291 L115 291 C87 291 66 269 70 238Z" fill="url(#ksso-bear-fur)" />
        <g clip-path="url(#ksso-bear-romper)">
          <rect x="66" y="132" width="128" height="160" fill="#fffdf6" />
          <rect x="66" y="144" width="128" height="20" fill="url(#ksso-bear-stripe)" />
          <rect x="66" y="188" width="128" height="21" fill="url(#ksso-bear-stripe)" />
          <rect x="66" y="232" width="128" height="21" fill="url(#ksso-bear-stripe)" />
          <rect x="66" y="276" width="128" height="19" fill="url(#ksso-bear-stripe)" />
        </g>
        <path d="M86 154 C105 136 155 136 174 154" fill="none" stroke="#fff7e9" stroke-width="18" stroke-linecap="round" />
        <path d="M84 164 C105 150 155 150 176 164" fill="none" stroke="#f7b500" stroke-width="7" stroke-linecap="round" />
        <path d="M73 165 C54 173 45 197 51 222 C57 247 73 258 88 247 C101 237 103 206 94 185 C89 173 81 164 73 165Z" fill="url(#ksso-bear-fur)" />
        <circle cx="58" cy="170" r="8" fill="#fff8ea" opacity="0.8" />
        <path d="M187 165 C206 173 215 197 209 222 C203 247 187 258 172 247 C159 237 157 206 166 185 C171 173 179 164 187 165Z" fill="url(#ksso-bear-fur)" />
        <circle cx="202" cy="170" r="8" fill="#fff8ea" opacity="0.8" />
        <ellipse cx="102" cy="286" rx="27" ry="21" fill="url(#ksso-bear-fur)" />
        <path d="M91 287 L91 298" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <path d="M104 289 L104 300" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <ellipse cx="158" cy="286" rx="27" ry="21" fill="url(#ksso-bear-fur)" />
        <path d="M150 289 L150 300" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <path d="M163 287 L163 298" stroke="#9d7d61" stroke-width="3" stroke-linecap="round" opacity="0.65" />
        <circle cx="82" cy="66" r="29" fill="url(#ksso-bear-fur)" />
        <circle cx="178" cy="66" r="29" fill="url(#ksso-bear-fur)" />
        <circle cx="83" cy="68" r="16" fill="#fff6e8" opacity="0.72" />
        <circle cx="177" cy="68" r="16" fill="#fff6e8" opacity="0.72" />
        <circle cx="130" cy="104" r="68" fill="url(#ksso-bear-fur)" />
        ${eyes}
        <ellipse cx="130" cy="129" rx="18" ry="14" fill="#4b2c20" />
        <path d="M130 142 L130 154" stroke="#4b2c20" stroke-width="4" stroke-linecap="round" />
        <path d="M112 153 Q130 164 148 153" fill="none" stroke="#4b2c20" stroke-width="4" stroke-linecap="round" />
      </svg>
    `;
  }

  function removeBearMascot() {
    document.getElementById(BEAR_ROOT_ID)?.remove();
  }

  function mountBearMessage(message, options = {}) {
    removeBearMascot();
    const root = document.createElement("aside");
    root.id = BEAR_ROOT_ID;
    root.setAttribute("aria-label", "クマの授業コメント");
    const bubbleContent = options.ksupportLink
      ? `${escapeHtml(message)}<a class="ksso-bear-link" href="${escapeHtml(KSUPPORT_SEARCH_URL)}" target="_blank" rel="noopener noreferrer">ここから</a>${escapeHtml(KSUPPORT_LOGIN_BEAR_AFTER_LINK)}`
      : escapeHtml(message);
    root.innerHTML = `
      <button type="button" class="ksso-bear-close" aria-label="クマを閉じる">×</button>
      <div class="ksso-bear-bubble" data-ksso-bear-comment>${bubbleContent}</div>
      <div class="ksso-bear-stage${options.tweet ? " ksso-bear-stage--tweet" : ""}" data-ksso-bear-stage>${renderBearSvg(Boolean(options.thinking))}</div>
    `;
    document.body.appendChild(root);
    root
      .querySelector(".ksso-bear-close")
      ?.addEventListener("click", removeBearMascot);
    return root;
  }

  function mountBearMascot(evaluation) {
    const comments = flattenComments(evaluation.commentSections);
    const root = mountBearMessage(
      comments.length
        ? "みんなどんな感じで授業受けてるのかな..."
        : buildBearFallbackComment(comments),
      { thinking: Boolean(comments.length), tweet: Boolean(comments.length) },
    );
    if (!comments.length) return;
    bindBearTweetShortcut(root, evaluation);
    void generateBearComment(comments).then((comment) => {
      if (!root.isConnected) return;
      const bubble = root.querySelector("[data-ksso-bear-comment]");
      const stage = root.querySelector("[data-ksso-bear-stage]");
      if (bubble) bubble.textContent = comment;
      if (stage) stage.innerHTML = renderBearSvg(false);
    });
  }

  function renderQuestion(question) {
    const display = displayQuestion(question);
    const counts = display.counts;
    const total = choiceTotal(counts);
    return `
      <li class="ksso-question">
        <div class="ksso-question-head">
          <span class="ksso-question-title">
            ${escapeHtml(display.title)}
            ${
              display.reversed
                ? `
              <button type="button" class="ksso-info-button" aria-label="表示を反転した理由">
                i
                <span class="ksso-tooltip" role="tooltip">元の設問は「学修の負荷が大きすぎた」でした。見やすくするため、高いほど良い評価になるように表示を反転しています。</span>
              </button>
            `
                : ""
            }
          </span>
        </div>
        <div class="ksso-question-overview">
          ${renderChoiceRows(counts, total)}
          <div class="ksso-question-score">
            <span class="ksso-question-score-value">${formatAvg(display.avg)}</span>
            <span class="ksso-question-score-stars">${renderStars(display.avg)}</span>
          </div>
        </div>
      </li>
    `;
  }

  function primaryInstructorName(value) {
    return normalizeText(value)
      .replace(/\s+他(?:\s|$).*/, "")
      .split(/[、，;]/)[0]
      .trim();
  }

  function renderFacultyProfile(profile, instructorName) {
    if (!profile?.imageUrl || !profile?.profileUrl) return "";
    const name = profile.name || instructorName;
    return `
      <a class="ksso-faculty-profile" href="${escapeHtml(profile.profileUrl)}" target="_blank" rel="noopener noreferrer">
        <img class="ksso-faculty-photo" src="${escapeHtml(profile.imageUrl)}" alt="${escapeHtml(name)}">
        <span class="ksso-faculty-body">
          <span class="ksso-faculty-label">教員プロフィール</span>
          <span class="ksso-faculty-name">${escapeHtml(name)} <span class="ksso-external-mark" aria-hidden="true">↗</span></span>
          ${profile.affiliations ? `<span class="ksso-faculty-affiliation">${escapeHtml(profile.affiliations)}</span>` : ""}
        </span>
      </a>
    `;
  }

  function ksupportEvaluationUrl(evaluation) {
    const recordId = normalizeText(
      evaluation?.course?.recordId || evaluation?.recordId,
    );
    if (!recordId) return "";
    return `https://keiouniversity.my.site.com/students/s/course-offering-schedule/${encodeURIComponent(recordId)}/csh163408`;
  }

  function renderSourceMeta(evaluation) {
    const course = evaluation?.course || {};
    const url = ksupportEvaluationUrl(evaluation);
    const label =
      normalizeText(
        `${course.semester || ""} ${course.courseName || ""} 授業評価`,
      ) || "K-Support 授業評価";
    if (!url) {
      return `<div class="ksso-meta">ソース: ${escapeHtml(label)}</div>`;
    }
    return `
      <div class="ksso-meta">
        ソース:
        <a class="ksso-source-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(label)}<span class="ksso-external-mark" aria-hidden="true">↗︎</span>
        </a>
      </div>
    `;
  }

  async function hydrateFacultyProfile(root, syllabus, evaluation) {
    const slot = root.querySelector("[data-ksso-faculty-profile]");
    if (!slot) return;
    const instructorName = primaryInstructorName(
      evaluation.course?.lecturer || syllabus.lecturer,
    );
    if (!instructorName) return;
    const response = await runtimeMessage({
      type: "keioSurvey.fetchFacultyProfile",
      instructorName,
      faculty: evaluation.course?.faculty || syllabus.faculty || "",
    });
    if (!response?.ok || !response.profile) return;
    slot.innerHTML = renderFacultyProfile(response.profile, instructorName);
    slot.hidden = !slot.innerHTML;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        margin: 16px 0;
        background: #ffffff;
        color: #1f2937;
        font-size: 14px;
        line-height: 1.55;
      }
      #${ROOT_ID} .ksso-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      #${ROOT_ID} .ksso-title {
        font-size: 16px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-meta {
        color: #64748b;
        font-size: 12px;
        text-align: right;
      }
      #${ROOT_ID} .ksso-source-link {
        color: #475569;
        font-weight: 700;
        text-decoration: none;
      }
      #${ROOT_ID} .ksso-source-link:hover {
        color: #1d4ed8;
        text-decoration: underline;
      }
      #${ROOT_ID} .ksso-faculty-profile-slot[hidden] {
        display: none;
      }
      #${ROOT_ID} .ksso-faculty-profile-slot {
        min-width: 0;
      }
      #${ROOT_ID} .ksso-faculty-profile {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        height: 100%;
        max-width: 100%;
        padding: 10px 12px;
        color: #1f2937;
        text-decoration: none;
        box-sizing: border-box;
      }
      #${ROOT_ID} .ksso-faculty-profile:hover {
        border-color: #cbd5e1;
        background: #f8fafc;
      }
      #${ROOT_ID} .ksso-faculty-photo {
        width: 76px;
        height: 76px;
        flex: 0 0 auto;
        border-radius: 8px;
        object-fit: cover;
        background: #f1f5f9;
      }
      #${ROOT_ID} .ksso-faculty-body {
        display: grid;
        gap: 2px;
        min-width: 0;
      }
      #${ROOT_ID} .ksso-faculty-label {
        color: #64748b;
        font-size: 11px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-faculty-name {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 14px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-faculty-affiliation,
      #${ROOT_ID} .ksso-faculty-source {
        color: #64748b;
        font-size: 12px;
        line-height: 1.35;
      }
      #${ROOT_ID} .ksso-external-mark {
        color: #64748b;
        font-size: 12px;
        line-height: 1;
      }
      #${ROOT_ID} .ksso-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }
      #${ROOT_ID} .ksso-button {
        appearance: none;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 7px 10px;
        background: #ffffff;
        color: #1f2937;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
      }
      #${ROOT_ID} .ksso-button:hover {
        background: #f1f5f9;
      }
      #${ROOT_ID} .ksso-status {
        color: #475569;
        white-space: pre-line;
      }
      #${ROOT_ID} .ksso-error {
        color: #b91c1c;
        white-space: pre-line;
      }
      #${ROOT_ID} .ksso-summary {
        display: grid;
        grid-template-columns: minmax(300px, 1.15fr) minmax(280px, 1fr);
        align-items: stretch;
        gap: 10px;
        margin-bottom: 14px;
        border: 1px solid #d9d9d9;
        border-radius: 10px;
      }
      #${ROOT_ID} .ksso-metric {
        padding: 8px 10px;
      }
      #${ROOT_ID} .ksso-metric--overall {
        padding: 14px 16px;
      }
      #${ROOT_ID} .ksso-metric--responses {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        margin-top: 8px;
        color: #475569;
      }
      #${ROOT_ID} .ksso-response-row {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
      }
      #${ROOT_ID} .ksso-response-name {
        color: #64748b;
        font-size: 11px;
      }
      #${ROOT_ID} .ksso-response-value {
        color: #334155;
        font-size: 12px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-label {
        color: #64748b;
        font-size: 12px;
      }
      #${ROOT_ID} .ksso-metric--overall .ksso-label {
        color: #92400e;
        font-size: 13px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-value {
        display: block;
        font-size: 18px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-metric--overall .ksso-value {
        margin-top: 4px;
      }
      #${ROOT_ID} .ksso-rating {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      #${ROOT_ID} .ksso-rating-number {
        flex: 0 0 auto;
      }
      #${ROOT_ID} .ksso-metric--overall .ksso-rating {
        align-items: flex-end;
        gap: 10px;
      }
      #${ROOT_ID} .ksso-metric--overall .ksso-rating-number {
        color: #111827;
        font-size: 42px;
        font-weight: 800;
        line-height: 0.95;
      }
      #${ROOT_ID} .ksso-metric--overall .ksso-stars {
        font-size: 22px;
      }
      #${ROOT_ID} .ksso-stars {
        position: relative;
        display: inline-block;
        color: #cbd5e1;
        font-size: 18px;
        line-height: 1;
        letter-spacing: 0;
      }
      #${ROOT_ID} .ksso-stars-fill {
        position: absolute;
        inset: 0 auto 0 0;
        overflow: hidden;
        color: #f59e0b;
        white-space: nowrap;
      }
      #${ROOT_ID} .ksso-stars-base {
        color: #cbd5e1;
      }
      #${ROOT_ID} .ksso-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 14px;
        align-items: center;
        border-top: 1px solid #eef2f7;
        border-bottom: 1px solid #eef2f7;
        margin: 8px 0 12px;
        padding: 10px 0;
        color: #334155;
      }
      #${ROOT_ID} .ksso-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      #${ROOT_ID} .ksso-swatch {
        display: inline-block;
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
        border: 1px solid rgba(15, 23, 42, 0.18);
        border-radius: 2px;
      }
      #${ROOT_ID} .ksso-questions {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        list-style: none;
        margin: 0;
        padding: 0;
      }
      #${ROOT_ID} .ksso-question {
        border: 1px solid #eef2f7;
        border-radius: 6px;
        padding: 12px 14px;
        background: #ffffff;
      }
      #${ROOT_ID} .ksso-question-head {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }
      #${ROOT_ID} .ksso-question-title {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        font-weight: 600;
      }
      #${ROOT_ID} .ksso-info-button {
        position: relative;
        display: inline-grid;
        place-items: center;
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        background: #ffffff;
        color: #64748b;
        cursor: help;
        font: inherit;
        font-size: 12px;
        font-weight: 800;
        line-height: 1;
      }
      #${ROOT_ID} .ksso-info-button:hover,
      #${ROOT_ID} .ksso-info-button:focus-visible {
        border-color: #94a3b8;
        color: #334155;
      }
      #${ROOT_ID} .ksso-tooltip {
        position: absolute;
        z-index: 2;
        left: 50%;
        bottom: calc(100% + 8px);
        width: max-content;
        max-width: min(320px, 70vw);
        transform: translateX(-50%);
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 8px 10px;
        background: #0f172a;
        color: #ffffff;
        font-size: 12px;
        font-weight: 600;
        line-height: 1.45;
        white-space: normal;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.12s ease;
      }
      #${ROOT_ID} .ksso-info-button:hover .ksso-tooltip,
      #${ROOT_ID} .ksso-info-button:focus-visible .ksso-tooltip {
        opacity: 1;
      }
      #${ROOT_ID} .ksso-question-overview {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 96px;
        align-items: center;
        gap: 18px;
      }
      #${ROOT_ID} .ksso-choice-rows {
        display: grid;
        gap: 7px;
        min-width: 0;
      }
      #${ROOT_ID} .ksso-choice-row {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
      }
      #${ROOT_ID} .ksso-choice-row-label {
        color: #475569;
        font-size: 13px;
        font-weight: 700;
        text-align: center;
      }
      #${ROOT_ID} .ksso-choice-track {
        display: block;
        height: 9px;
        overflow: hidden;
        border-radius: 999px;
        background: #eef2f7;
      }
      #${ROOT_ID} .ksso-choice-fill {
        display: block;
        height: 100%;
        border-radius: inherit;
      }
      #${ROOT_ID} .ksso-question-score {
        display: grid;
        justify-items: center;
        gap: 6px;
        color: #1f2937;
      }
      #${ROOT_ID} .ksso-question-score-value {
        font-size: 42px;
        font-weight: 700;
        line-height: 1;
      }
      #${ROOT_ID} .ksso-question-score-stars .ksso-stars {
        font-size: 16px;
      }
      #${ROOT_ID} .ksso-comments {
        border-top: 1px solid #eef2f7;
        margin-top: 14px;
        padding-top: 12px;
      }
      #${ROOT_ID} .ksso-section-title {
        margin-bottom: 8px;
        font-size: 15px;
        font-weight: 700;
      }
      #${ROOT_ID} .ksso-comment-section {
        border: 1px solid #eef2f7;
        border-radius: 8px;
        margin-top: 8px;
        padding: 10px 12px 12px;
        background: #ffffff;
      }
      #${ROOT_ID} .ksso-comment-positive {
        border-color: #dcfce7;
      }
      #${ROOT_ID} .ksso-comment-improvement {
        border-color: #ffedd5;
      }
      #${ROOT_ID} .ksso-comment-other {
        border-color: #dbeafe;
      }
      #${ROOT_ID} .ksso-comment-section h4 {
        display: flex;
        align-items: center;
        gap: 7px;
        margin: 0 0 8px;
        color: #1f2937;
        font-size: 14px;
        line-height: 1.45;
      }
      #${ROOT_ID} .ksso-comment-tone {
        flex: 0 0 auto;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #64748b;
      }
      #${ROOT_ID} .ksso-comment-positive .ksso-comment-tone {
        background: #22c55e;
      }
      #${ROOT_ID} .ksso-comment-improvement .ksso-comment-tone {
        background: #f97316;
      }
      #${ROOT_ID} .ksso-comment-other .ksso-comment-tone {
        background: #3b82f6;
      }
      #${ROOT_ID} .ksso-comment-section h4 span {
        color: #475569;
        font-weight: 600;
      }
      #${ROOT_ID} .ksso-comment-bubbles {
        display: grid;
        gap: 10px;
        margin: 0;
      }
      #${ROOT_ID} .ksso-comment-bubble {
        width: fit-content;
        max-width: min(100%, 78ch);
        margin: 0;
        border: 1px solid #e2e8f0;
        border-left-width: 4px;
        border-radius: 12px;
        padding: 10px 14px;
        background: #f8fafc;
        color: #1f2937;
        font-size: 15px;
        font-weight: 600;
        line-height: 1.65;
        white-space: pre-wrap;
        word-break: break-word;
        box-sizing: border-box;
      }
      #${ROOT_ID} .ksso-comment-bubble::before,
      #${ROOT_ID} .ksso-comment-bubble::after {
        content: none;
      }
      #${ROOT_ID} .ksso-comment-positive .ksso-comment-bubble {
        border-color: #bbf7d0;
        border-left-color: #22c55e;
        background: #f0fdf4;
      }
      #${ROOT_ID} .ksso-comment-improvement .ksso-comment-bubble {
        border-color: #fed7aa;
        border-left-color: #f97316;
        background: #fff7ed;
      }
      #${ROOT_ID} .ksso-comment-other .ksso-comment-bubble {
        border-color: #bfdbfe;
        border-left-color: #3b82f6;
        background: #eff6ff;
      }
      #${BEAR_ROOT_ID} {
        position: fixed;
        right: max(16px, env(safe-area-inset-right));
        bottom: max(14px, env(safe-area-inset-bottom));
        z-index: 2147483646;
        display: grid;
        justify-items: end;
        width: min(340px, calc(100vw - 24px));
        color: #172554;
        font-family: inherit;
        pointer-events: none;
      }
      #${BEAR_ROOT_ID} .ksso-bear-close {
        padding: 0;
        position: absolute;
        top: 12px;
        right: 28px;
        z-index: 2;
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border: 1px solid #f8d67a;
        border-radius: 999px;
        background: #ffffff;
        color: #854d0e;
        cursor: pointer;
        font: inherit;
        font-size: 16px;
        font-weight: 800;
        line-height: 1;
        pointer-events: auto;
      }
      #${BEAR_ROOT_ID} .ksso-bear-close:hover,
      #${BEAR_ROOT_ID} .ksso-bear-close:focus-visible {
        background: #fffbeb;
      }
      #${BEAR_ROOT_ID} .ksso-bear-bubble {
        position: relative;
        width: min(300px, calc(100vw - 40px));
        margin: 0 18px -10px 0;
        border: 2px solid #f6c453;
        border-radius: 18px;
        padding: 13px 38px 13px 15px;
        background: #ffffff;
        box-shadow: 0 12px 28px rgba(15, 35, 95, 0.16);
        font-size: 14px;
        font-weight: 800;
        line-height: 1.55;
        letter-spacing: 0;
        word-break: break-word;
        box-sizing: border-box;
        pointer-events: auto;
      }
      #${BEAR_ROOT_ID} .ksso-bear-bubble::after {
        content: "";
        position: absolute;
        right: 54px;
        bottom: -10px;
        width: 18px;
        height: 18px;
        border-right: 2px solid #f6c453;
        border-bottom: 2px solid #f6c453;
        background: #ffffff;
        transform: rotate(45deg);
      }
      #${BEAR_ROOT_ID} .ksso-bear-link {
        color: #1d4ed8;
        font-weight: 900;
        text-decoration: underline;
        text-underline-offset: 2px;
        pointer-events: auto;
      }
      #${BEAR_ROOT_ID} .ksso-bear-link:hover {
        color: #1e40af;
      }
      #${BEAR_ROOT_ID} .ksso-bear-stage {
        width: 132px;
        height: 162px;
        margin-right: 16px;
        filter: drop-shadow(0 16px 18px rgba(15, 35, 95, 0.16));
        cursor: pointer;
        pointer-events: auto;
      }
      #${BEAR_ROOT_ID} .ksso-bear-svg {
        display: block;
        width: 100%;
        height: 100%;
      }
      @media (max-width: 720px) {
        #${ROOT_ID} .ksso-summary,
        #${ROOT_ID} .ksso-questions {
          grid-template-columns: 1fr;
        }
        #${ROOT_ID} .ksso-metric--overall .ksso-rating-number {
          font-size: 36px;
        }
        #${ROOT_ID} .ksso-question-overview {
          grid-template-columns: 1fr;
        }
        #${ROOT_ID} .ksso-question-score {
          justify-items: start;
        }
        #${ROOT_ID} .ksso-question-score-value {
          font-size: 34px;
        }
        #${ROOT_ID} .ksso-top {
          align-items: flex-start;
          flex-direction: column;
        }
        #${BEAR_ROOT_ID} {
          width: min(250px, calc(100vw - 18px));
        }
        #${BEAR_ROOT_ID} .ksso-bear-bubble {
          width: min(220px, calc(100vw - 30px));
          margin-right: 8px;
          padding: 10px 34px 10px 12px;
          font-size: 12px;
        }
        #${BEAR_ROOT_ID} .ksso-bear-close {
          top: 8px;
          right: 16px;
        }
        #${BEAR_ROOT_ID} .ksso-bear-stage {
          width: 86px;
          height: 106px;
          margin-right: 12px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function renderOverlay(match) {
    const previous = document.getElementById(ROOT_ID);
    if (previous) previous.remove();
    injectStyle();

    const evaluation = match.evaluation;
    const questions = Array.isArray(evaluation.questions)
      ? evaluation.questions
      : [];
    const q7 = questions.find((question) => question.index === 7);
    const total = questions[0] ? choiceTotal(questions[0].counts || []) : null;
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="ksso-top">
        <div class="ksso-title">授業評価</div>
        ${renderSourceMeta(evaluation)}
      </div>
      <div class="ksso-summary">
        <div class="ksso-metric ksso-metric--overall">
          <span class="ksso-label">総合満足度</span>
          <span class="ksso-value">${renderRating(q7?.avg)}</span>
          <div class="ksso-metric--responses">
            <div class="ksso-response-row"><span class="ksso-response-name">回答率</span><span class="ksso-response-value">${formatPercent(evaluation.course?.answerPercent)}</span></div>
            <div class="ksso-response-row"><span class="ksso-response-name">回答数</span><span class="ksso-response-value">${typeof total === "number" ? `${total}件` : "-"}</span></div>
          </div>
        </div>
        <div class="ksso-faculty-profile-slot" data-ksso-faculty-profile hidden></div>
      </div>
      ${renderLegend()}
      <ul class="ksso-questions">
        ${questions.map(renderQuestion).join("")}
      </ul>
      ${renderCommentSections(evaluation.commentSections)}
    `;

    const anchor =
      document.querySelector(".syllabus-header") ||
      document.querySelector("#screen-detail") ||
      document.body;
    if (anchor === document.body) {
      document.body.prepend(root);
    } else {
      anchor.insertAdjacentElement("afterend", root);
    }
    void hydrateFacultyProfile(root, match.syllabus || {}, evaluation);
    mountBearMascot(evaluation);
  }

  function mountRoot() {
    injectStyle();
    let root = document.getElementById(ROOT_ID);
    if (root) return root;
    root = document.createElement("section");
    root.id = ROOT_ID;
    const anchor =
      document.querySelector(".syllabus-header") ||
      document.querySelector("#screen-detail") ||
      document.body;
    if (anchor === document.body) {
      document.body.prepend(root);
    } else {
      anchor.insertAdjacentElement("afterend", root);
    }
    return root;
  }

  function renderStatus(title, message, options = {}) {
    if (options.bearMessage) {
      mountBearMessage(options.bearMessage, {
        thinking: options.bearThinking,
        ksupportLink: options.bearKSupportLink,
      });
    } else {
      removeBearMascot();
    }
    const root = mountRoot();
    const actions = [];
    if (options.openKSupport) {
      actions.push(
        `<button type="button" class="ksso-button" data-ksso-action="open-ksupport">${escapeHtml(options.openKSupportLabel || "K-Supportを開く")}</button>`,
      );
    }
    if (options.retry) {
      actions.push(
        '<button type="button" class="ksso-button" data-ksso-action="retry">再取得</button>',
      );
    }
    root.innerHTML = `
      <div class="ksso-top">
        <div class="ksso-title">${escapeHtml(title)}</div>
        <div class="ksso-meta">Syllabus Lens</div>
      </div>
      <div class="${options.error ? "ksso-error" : "ksso-status"}">${escapeHtml(message)}</div>
      ${actions.length ? `<div class="ksso-actions">${actions.join("")}</div>` : ""}
    `;
  }

  function renderNoEvaluationFound() {
    renderStatus("授業評価", "この授業の公開評価は見つかりませんでした。");
  }

  function renderKSupportLoginNeeded() {
    renderStatus("授業評価", "K-Support へのログインが必要です。", {
      openKSupport: true,
      openKSupportLabel: "K-Supportを開く",
      bearMessage: KSUPPORT_LOGIN_BEAR_MESSAGE,
      bearKSupportLink: true,
    });
  }

  function bindActions(syllabus) {
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.(`#${ROOT_ID} [data-ksso-action]`);
      if (!button) return;
      const action = button.getAttribute("data-ksso-action");
      if (action === "open-ksupport") {
        void runtimeMessage({ type: "keioSurvey.openKSupport" });
      }
      if (action === "retry") {
        void fetchAndRender(syllabus);
      }
    });
  }

  function isKSupportConnectionError(response) {
    const code = response?.code || "";
    const message = response?.message || "";
    return (
      code === "TAB_MESSAGE_FAILED" ||
      code === "KSUPPORT_TABS_UNAVAILABLE" ||
      code === "RUNTIME_MESSAGE_TIMEOUT" ||
      /Receiving end does not exist|Could not establish connection/i.test(
        message,
      )
    );
  }

  function isKSupportAuthError(response) {
    const text = `${response?.code || ""} ${response?.message || ""}`;
    return (
      /Sp_CourseEvaluationSearchController/.test(text) &&
      /アクセス権|access|permission|権限/i.test(text)
    );
  }

  function isKSupportLoginNeeded(response) {
    const code = response?.code || "";
    const text = `${code} ${response?.message || ""}`;
    return (
      code === "KSUPPORT_TAB_NOT_FOUND" ||
      code === "KSUPPORT_TABS_UNAVAILABLE" ||
      code === "TAB_MESSAGE_FAILED" ||
      code === "KSUPPORT_CONTEXT_MISSING" ||
      code === "KSUPPORT_CONTEXT_EXPIRED" ||
      isKSupportAuthError(response) ||
      /ログイン|Receiving end does not exist|Could not establish connection|Aura token|アクセス権|権限/i.test(
        text,
      )
    );
  }

  async function fetchAndRender(syllabus, existingMatch = null) {
    const missKey = courseFetchKey(syllabus);
    if (!existingMatch) {
      renderStatus("授業評価", "K-Support でこの授業の評価を探しています...");
    }
    const response = await runtimeMessage(
      {
        type: "keioSurvey.fetchEvaluationForSyllabus",
        syllabus,
      },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );

    if (response?.ok && response.evaluation) {
      const responseScore =
        response.match?.score ??
        scoreCourseMatch(syllabus, response.evaluation.course || {});
      if (existingMatch && existingMatch.score >= responseScore) {
        return;
      }
      await saveEvaluation(response.evaluation);
      renderOverlay({
        syllabus,
        evaluation: normalizeEvaluation(response.evaluation, {
          includeComments: true,
        }),
        score: responseScore,
      });
      return;
    }

    if (isKSupportLoginNeeded(response)) {
      renderKSupportLoginNeeded();
      return;
    }

    if (isKSupportConnectionError(response)) {
      renderStatus("授業評価", "この授業の公開評価はまだ確認できていません。", {
        retry: true,
      });
      return;
    }

    if (response?.code === "NO_MATCH") {
      await rememberMiss(missKey, syllabus, response.code);
      renderNoEvaluationFound();
      return;
    }

    renderStatus(
      "授業評価",
      response?.message || "授業評価の取得に失敗しました。",
      {
        retry: true,
        error: true,
      },
    );
  }

  async function main() {
    if (!isSyllabusDetailPage()) return;

    const syllabus = parseSyllabusCourse();
    if (!syllabus.courseName || !hasCourseIdentity(syllabus)) {
      renderStatus("授業評価", "シラバスから科目名を読み取れませんでした。", {
        error: true,
      });
      return;
    }
    bindActions(syllabus);

    const current = await storageGet({
      [STORAGE_KEYS.evaluations]: {},
      [STORAGE_KEYS.evaluationMisses]: {},
    });
    const cachedEvaluations = await cacheGetAll("evaluations").catch(() => []);
    const match = findBestEvaluation(syllabus, [
      ...cachedEvaluations,
      ...uniqueEvaluations(current[STORAGE_KEYS.evaluations]),
    ]);
    if (match) {
      renderOverlay({ ...match, syllabus });
      return;
    }
    if (
      hasFreshMiss(
        current[STORAGE_KEYS.evaluationMisses],
        courseFetchKey(syllabus),
      )
    ) {
      renderNoEvaluationFound();
      return;
    }
    renderStatus("授業評価", "保存済みの評価を確認中です...");
    void fetchAndRender(syllabus, match);
  }

  void main();
})();
