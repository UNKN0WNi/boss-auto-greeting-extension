(() => {
  const DEFAULTS = {
    dailyLimit: 20,
    minDelay: 8,
    maxDelay: 18,
    message: "您好，我对这个岗位很感兴趣，想进一步了解一下，谢谢。",
    onlyCurrentPage: true,
    excludeKeywords: "",
    includeKeywords: "",
    includeMode: "any",
    matchCardInfo: true,
    caseSensitive: false,
    minSalary: 0,
    salaryBasis: "lower",
    skipUnknownSalary: false
  };

  const state = {
    running: false,
    stopped: false,
    currentTimer: null,
    greetedKeys: new Set(),
    attemptedKeys: new Set(),
    contactedKeys: new Set(),
    filteredKeys: new Set(),
    filteredCount: 0,
    processedCount: 0,
    jdMisses: 0
  };

  const sleep = (ms) => new Promise((resolve) => {
    state.currentTimer = window.setTimeout(resolve, ms);
  });

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function randomDelay(settings) {
    const min = Math.max(3, Number(settings.minDelay) || DEFAULTS.minDelay);
    const max = Math.max(min + 1, Number(settings.maxDelay) || DEFAULTS.maxDelay);
    return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
  }

  async function getStats() {
    const { stats } = await chrome.storage.local.get("stats");
    if (!stats || stats.date !== todayKey()) {
      return { date: todayKey(), sent: 0 };
    }
    return { date: todayKey(), sent: Number(stats.sent || 0) };
  }

  async function setRunner(patch) {
    const { runner } = await chrome.storage.local.get("runner");
    await chrome.storage.local.set({
      runner: {
        ...(runner || {}),
        ...patch,
        updatedAt: Date.now()
      }
    });
  }

  async function incrementSent() {
    const stats = await getStats();
    const next = { date: todayKey(), sent: stats.sent + 1 };
    await chrome.storage.local.set({ stats: next });
    return next;
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  // BOSS 直聘把薪资数字换成私有区码位，靠 kanzhun-mix 自定义字体渲染：
  // U+E031 ~ U+E03A → 0 ~ 9。直接读 textContent 会是方框字符，需要还原成数字。
  const PUA_DIGIT_BASE = 0xE031;

  function decodeBossText(raw) {
    return Array.from(String(raw ?? ""))
      .map((ch) => {
        const code = ch.codePointAt(0);
        if (code >= PUA_DIGIT_BASE && code <= PUA_DIGIT_BASE + 9) {
          return String(code - PUA_DIGIT_BASE);
        }
        // 其它私有区字符、零宽字符、替换符：无法还原就直接去掉，避免日志里出现方框
        const unreadable = (code >= 0xE000 && code <= 0xF8FF)
          || (code >= 0xF0000 && code <= 0x10FFFD)
          || code === 0xFFFD
          || code === 0xFEFF
          || code === 0x00AD
          || (code >= 0x200B && code <= 0x200F)
          || (code >= 0x2060 && code <= 0x206F);
        return unreadable ? "" : ch;
      })
      .join("");
  }

  function cleanForDisplay(raw) {
    return decodeBossText(raw)
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textOf(el) {
    return decodeBossText(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isBlockingPage() {
    const bodyText = textOf(document.body);
    return /验证码|安全验证|登录后继续|请登录|账号异常|访问过于频繁/.test(bodyText);
  }

  function candidates(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(visible);
  }

  function findByText(selectors, regex) {
    return candidates(selectors).find((el) => regex.test(textOf(el)));
  }

  // "立即沟通" 按钮被点击过之后会变成 "继续沟通"，这类职位不需要再打招呼
  function isAlreadyContactedButton(el) {
    if (!el) return false;
    const text = textOf(el);
    if (!text) return false;
    return /继续沟通/.test(text) && !/立即沟通|打招呼|开聊|聊一聊|感兴趣|开始聊天/.test(text);
  }

  function jobListRoot() {
    const roots = candidates(".job-list-box,.search-job-result,.job-list,.job-list-container,.job-list-wrap,.job-list-content");
    return roots
      .map((root) => ({
        root,
        count: Array.from(root.querySelectorAll("a[href*='job_detail']")).filter((link) => {
          const rect = link.getBoundingClientRect();
          return rect.left < window.innerWidth * 0.72;
        }).length
      }))
      .filter((item) => {
        const rect = item.root.getBoundingClientRect();
        return rect.left < window.innerWidth * 0.72 && item.count > 0;
      })
      .sort((a, b) => b.count - a.count)[0]?.root || document;
  }

  function normalizeJobHref(href) {
    try {
      const url = new URL(href, location.href);
      const id = url.pathname.match(/job_detail\/([^/?#]+)/)?.[1];
      return id ? `job:${id}` : `${url.origin}${url.pathname}${url.searchParams.get("lid") || ""}`;
    } catch {
      return href;
    }
  }

  function leftJobLinks(root = document) {
    return Array.from(root.querySelectorAll("a[href*='job_detail']"))
      .filter(visible)
      .filter((link) => {
        const rect = link.getBoundingClientRect();
        return rect.left < window.innerWidth * 0.72 && rect.top > 40 && rect.top < window.innerHeight - 20;
      });
  }

  function enclosingJobCard(link) {
    return link.closest(".job-card-wrapper,.job-card-left,li[class*='job'],li,[ka^='search_list_']") || link;
  }

  function looksLikeJobCard(card, link) {
    const text = textOf(card) || textOf(link);
    const rect = card.getBoundingClientRect();
    return rect.left < window.innerWidth * 0.72 && /Java|薪|经验|学历|招聘|岗位|BOSS|HR|年|k|K/.test(text);
  }

  function legacyJobCards() {
    const root = jobListRoot();
    const selectors = [
      ".job-card-wrapper",
      ".job-card-left",
      "[ka^='search_list_']",
      "li[class*='job']",
      "li"
    ];
    const cards = selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector)).filter(visible));
    return cards.filter((card) => {
      const link = card.querySelector("a[href*='job_detail']");
      const rect = card.getBoundingClientRect();
      return link && rect.left < window.innerWidth * 0.72 && looksLikeJobCard(card, link);
    });
  }

  function jobCards() {
    const root = jobListRoot();
    const linkCards = leftJobLinks(root)
      .map((link) => enclosingJobCard(link))
      .filter((card) => looksLikeJobCard(card, card.matches("a") ? card : card.querySelector("a[href*='job_detail']")));
    const cards = linkCards.length ? linkCards : legacyJobCards();
    const seen = new Set();
    return cards.filter((card) => {
      const link = card.matches("a[href*='job_detail']") ? card : card.querySelector("a[href*='job_detail']");
      const key = link?.href ? normalizeJobHref(link.href) : textOf(card).slice(0, 160);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function cardKey(card) {
    const link = card.matches("a[href*='job_detail']") ? card : card.querySelector("a[href*='job_detail']");
    return link?.href ? normalizeJobHref(link.href) : textOf(card).slice(0, 120);
  }

  // ---------- 岗位描述过滤 ----------

  const KEYWORD_SPLIT = /[\n\r,，;；、|]+/;

  // 支持换行、中英文逗号、分号、顿号、竖线分隔；去空去重
  function parseKeywords(raw) {
    const seen = new Set();
    return String(raw || "")
      .split(KEYWORD_SPLIT)
      .map((word) => word.replace(/\s+/g, " ").trim())
      .filter((word) => {
        if (!word || seen.has(word)) return false;
        seen.add(word);
        return true;
      });
  }

  function compileFilters(settings) {
    const caseSensitive = Boolean(settings.caseSensitive);
    const toMatcher = (word) => ({
      label: word,
      value: caseSensitive ? word : word.toLowerCase()
    });
    return {
      excludes: parseKeywords(settings.excludeKeywords).map(toMatcher),
      includes: parseKeywords(settings.includeKeywords).map(toMatcher),
      requireAll: settings.includeMode === "all",
      caseSensitive,
      matchCardInfo: settings.matchCardInfo !== false
    };
  }

  function hasFilters(filters) {
    return Boolean(filters && (filters.excludes.length || filters.includes.length));
  }

  const JD_SELECTORS = [
    ".job-sec-text",
    ".job-detail-section",
    ".job-detail-body",
    ".job-detail-content",
    ".job-desc",
    ".detail-content",
    ".job-detail"
  ];

  function jobDescriptionText() {
    const parts = [];
    for (const selector of JD_SELECTORS) {
      for (const el of candidates(selector)) {
        const text = textOf(el);
        if (text && !parts.includes(text)) parts.push(text);
      }
      // 已经拿到正文就不必再收集更外层的容器，避免重复
      if (parts.join("\n").length > 80) break;
    }

    if (!parts.length) {
      for (const scope of detailScopes()) {
        // 兜底不要退化成整页文本，否则左侧其它职位的内容也会混进匹配
        if (scope === document || scope === document.body) continue;
        const text = textOf(scope);
        if (text) parts.push(text);
      }
    }

    return parts.join("\n").slice(0, 8000);
  }

  // 详情面板异步渲染，等正文更新后再判定，避免用上一个职位的描述做过滤
  async function waitForJobDescription(previous = "") {
    const budget = state.jdMisses >= 2 ? 700 : 2600;
    const deadline = Date.now() + budget;
    let text = jobDescriptionText();
    const ready = (value) => value.length >= 40 && (!previous || value !== previous);

    while (!ready(text) && Date.now() < deadline) {
      await sleep(250);
      const next = jobDescriptionText();
      if (next) text = next;
    }

    state.jdMisses = text.length < 40 ? state.jdMisses + 1 : 0;
    return text;
  }

  function cardTitle(card) {
    if (!card) return "";
    const el = card.querySelector(".job-name,.job-title,[class*='job-name'],[class*='job-title'],[class*='position-name']");
    const fromName = textOf(el);
    const raw = fromName || textOf(card);
    // 卡片兜底文本里常混着薪资和标签，去掉薪资区间后只留职位信息
    const cleaned = raw
      .replace(/\d+(?:\.\d+)?\s*[-~—－至到]\s*\d+(?:\.\d+)?\s*(?:[kK千万]|元\/\s*[天时月])[^\s]*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return (cleaned || raw).slice(0, 60);
  }

  function evaluateFilters(card, filters, description) {
    if (!hasFilters(filters)) return { pass: true };

    const chunks = [description];
    if (filters.matchCardInfo) chunks.push(textOf(card));
    const raw = chunks.filter(Boolean).join("\n");
    if (!raw.trim()) return { pass: true, unknown: true };

    const text = filters.caseSensitive ? raw : raw.toLowerCase();

    const excluded = filters.excludes.find((item) => text.includes(item.value));
    if (excluded) {
      return { pass: false, rule: "exclude", keyword: excluded.label, reason: `命中排除词「${excluded.label}」` };
    }

    if (!filters.includes.length) return { pass: true };

    const hits = filters.includes.filter((item) => text.includes(item.value));
    if (filters.requireAll && hits.length < filters.includes.length) {
      const missing = filters.includes.find((item) => !text.includes(item.value));
      return { pass: false, rule: "require-all", keyword: missing.label, reason: `缺少必需词「${missing.label}」` };
    }

    if (!filters.requireAll && !hits.length) {
      const labels = filters.includes.map((item) => item.label).join(" / ");
      return { pass: false, rule: "require-any", keyword: labels, reason: `未命中任一必需词（${labels}）` };
    }

    return { pass: true };
  }

  async function recordFiltered(card, verdict) {
    const entry = {
      title: cleanForDisplay(cardTitle(card)) || "未知职位",
      keyword: cleanForDisplay(verdict.keyword || ""),
      reason: cleanForDisplay(verdict.reason || "被过滤"),
      rule: verdict.rule || "filter",
      at: Date.now()
    };
    const { filterLog } = await chrome.storage.local.get("filterLog");
    const list = Array.isArray(filterLog) ? filterLog : [];
    list.unshift(entry);
    await chrome.storage.local.set({ filterLog: list.slice(0, 30) });
  }

  // ---------- 最低薪资过滤 ----------

  // BOSS 直聘职位卡片常见写法：15-25K、20-40K·13薪、1.5-2.5万、300-500元/天
  // 统一折算成「千元 / 月」(K)，日薪按 21.75 个工作日、时薪按每天 8 小时估算
  const DAYS_PER_MONTH = 21.75;
  const HOURS_PER_DAY = 8;
  const SALARY_NOISE = /[·•]\s*\d+(?:\.\d+)?\s*薪/g;
  const RANGE_SEP = "\\s*[-~—－至到]\\s*";

  const SALARY_RANGES = [
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*[kK千]`), unit: 1 },
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)\\s*[kK千]${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*[kK千]?`), unit: 1 },
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*万`), unit: 10 },
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)\\s*万${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*万?`), unit: 10 },
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*元?\\/?\\s*天`), unit: DAYS_PER_MONTH / 1000 },
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*元?\\/?\\s*时`), unit: HOURS_PER_DAY * DAYS_PER_MONTH / 1000 },
    { re: new RegExp(`(\\d+(?:\\.\\d+)?)${RANGE_SEP}(\\d+(?:\\.\\d+)?)\\s*元?\\/?\\s*月`), unit: 1 / 1000 }
  ];

  const SALARY_SINGLES = [
    { re: /(\d+(?:\.\d+)?)\s*[kK千]/, unit: 1 },
    { re: /(\d+(?:\.\d+)?)\s*万/, unit: 10 },
    { re: /(\d+(?:\.\d+)?)\s*元?\/?\s*天/, unit: DAYS_PER_MONTH / 1000 },
    { re: /(\d+(?:\.\d+)?)\s*元?\/?\s*时/, unit: HOURS_PER_DAY * DAYS_PER_MONTH / 1000 },
    { re: /(\d+(?:\.\d+)?)\s*元?\/?\s*月/, unit: 1 / 1000 }
  ];

  function parseSalary(raw, allowSingle = true) {
    // 再解一次：即便调用方直接传入了未清洗的 DOM 文本也能正确解析
    const cleaned = decodeBossText(raw);
    const text = cleaned
      .replace(/\s+/g, "")
      .replace(SALARY_NOISE, "")
      .replace(/,/g, "");
    if (!text || /面议|薪资待议|薪酬面议|待遇面议|保密|不限/.test(text)) return null;

    const build = (a, b, unit) => {
      const lo = Number(a) * unit;
      const hi = Number(b) * unit;
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
      return {
        min: Math.round(Math.min(lo, hi) * 100) / 100,
        max: Math.round(Math.max(lo, hi) * 100) / 100,
        raw: cleaned.trim().slice(0, 40)
      };
    };

    for (const { re, unit } of SALARY_RANGES) {
      const match = text.match(re);
      if (match) return build(match[1], match[2], unit);
    }
    if (allowSingle) {
      for (const { re, unit } of SALARY_SINGLES) {
        const match = text.match(re);
        if (match) return build(match[1], match[1], unit);
      }
    }
    return null;
  }

  const SALARY_SELECTORS = ".salary,[class*='salary'],[class*='job-salary'],[class*='job-pay']";

  function salaryTexts(scope) {
    if (!scope || scope === document || typeof scope.querySelectorAll !== "function") return [];
    return Array.from(scope.querySelectorAll(SALARY_SELECTORS))
      .filter(visible)
      .map(textOf)
      .filter((text) => text && text.length <= 60);
  }

  // 优先用薪资元素，读不到再退回整块文本（整块文本只允许识别带单位的区间，避免把"3-5年"当薪资）
  function readSalary(scope, fallbackText = "", allowSingleFallback = false) {
    for (const text of salaryTexts(scope).sort((a, b) => a.length - b.length)) {
      const parsed = parseSalary(text, true);
      if (parsed) return parsed;
    }
    return fallbackText ? parseSalary(fallbackText, allowSingleFallback) : null;
  }

  function readDetailSalary() {
    for (const scope of detailScopes()) {
      if (scope === document || scope === document.body) continue;
      const parsed = readSalary(scope, "");
      if (parsed) return parsed;
    }
    return null;
  }

  function salaryEnabled(settings) {
    return Number(settings.minSalary) > 0;
  }

  function evaluateSalary(parsed, settings) {
    const floor = Math.max(0, Number(settings.minSalary) || 0);
    if (floor <= 0) return { pass: true };

    if (!parsed) {
      return settings.skipUnknownSalary
        ? { pass: false, rule: "salary-unknown", keyword: "薪资未知", reason: "薪资无法识别（字体加密或面议），已跳过" }
        : { pass: true, unknown: true };
    }

    const byUpper = settings.salaryBasis === "upper";
    const value = byUpper ? parsed.max : parsed.min;
    if (value < floor) {
      return {
        pass: false,
        rule: "salary",
        keyword: parsed.raw,
        reason: `薪资 ${parsed.raw} 低于 ${floor}K（按${byUpper ? "上限" : "下限"}判断）`
      };
    }
    return { pass: true };
  }

  function nextUnattemptedCard() {
    return jobCards().find((card) => {
      const key = cardKey(card);
      return key
        && !state.attemptedKeys.has(key)
        && !state.greetedKeys.has(key)
        && !state.contactedKeys.has(key)
        && !state.filteredKeys.has(key);
    });
  }

  function scanSummary() {
    const root = jobListRoot();
    const links = leftJobLinks(root);
    const cards = jobCards();
    const fresh = cards.filter((card) => {
      const key = cardKey(card);
      return key
        && !state.attemptedKeys.has(key)
        && !state.greetedKeys.has(key)
        && !state.contactedKeys.has(key)
        && !state.filteredKeys.has(key);
    });
    const filteredPart = state.filteredCount ? `、已过滤 ${state.filteredCount} 个` : "";
    return `扫描到 ${links.length} 个链接、${cards.length} 个职位、${fresh.length} 个未尝试${filteredPart}`;
  }

  function cardClickTarget(card) {
    return card.matches("a[href*='job_detail']") ? card
      : card.querySelector("a[href*='job_detail']")
      || card.querySelector("[ka^='search_list_']")
      || card.querySelector(".job-card-left")
      || card;
  }

  function detailFingerprint() {
    return detailScopes()
      .map((scope) => textOf(scope).slice(0, 260))
      .join("|") || `${location.href}|${document.title}`;
  }

  async function selectCard(card) {
    const before = detailFingerprint();
    const target = cardClickTarget(card);
    if (target.tagName === "A") {
      target.removeAttribute("target");
    }
    await clickElement(target);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(300);
      if (detailFingerprint() !== before) return true;
    }
    return true;
  }

  async function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    await sleep(400 + Math.floor(Math.random() * 300));
    el.click();
  }

  function findGreetingButton(scope = document) {
    const selectors = "a,button,.btn,.op-btn,.btn-startchat,[role='button']";
    const matchGreeting = (el) => /立即沟通|继续沟通|打招呼|感兴趣|聊一聊|开聊/.test(textOf(el)) && !isAlreadyContactedButton(el);
    const button = Array.from(scope.querySelectorAll(selectors))
      .filter(visible)
      .find(matchGreeting);
    if (button) return button;
    return candidates(selectors).find(matchGreeting);
  }

  function detailScopes() {
    const selectors = [
      ".job-detail-container",
      ".job-detail",
      ".job-detail-box",
      ".detail-box",
      ".job-detail-content",
      ".job-detail-op",
      ".job-sec",
      ".job-banner"
    ];
    const scopes = selectors.flatMap((selector) => candidates(selector));
    return scopes.length ? scopes : [document];
  }

  function findDetailGreetingButton() {
    const button = detailScopes().map((scope) => findGreetingButton(scope)).find(Boolean);
    if (button) return button;

    const listKeys = new Set(jobCards().map((card) => cardKey(card)));
    return candidates("a,button,.btn,.op-btn,.btn-startchat,[role='button']")
      .filter((el) => /立即沟通|继续沟通|打招呼|感兴趣|聊一聊|开聊/.test(textOf(el)) && !isAlreadyContactedButton(el))
      .find((el) => {
        const card = el.closest(".job-card-wrapper,.job-card-left,.job-list-box li,[ka^='search_list_']");
        return !card || !listKeys.has(cardKey(card));
      });
  }

  function findMessageBox() {
    return candidates("textarea,input[type='text'],[contenteditable='true']")
      .find((el) => visible(el) && !/搜索|职位|公司/.test(el.getAttribute("placeholder") || ""));
  }

  function setNativeValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillMessageIfPossible(settings) {
    const box = findMessageBox();
    if (!box || !settings.message) return;
    const current = textOf(box) || box.value || "";
    if (current.length < 2) {
      setNativeValue(box, settings.message);
      await sleep(300);
    }
  }

  function modalLikeContainers() {
    const selectors = [
      ".dialog",
      ".modal",
      ".popup",
      ".boss-popup",
      ".chat-dialog",
      ".greeting-dialog",
      ".geek-chat-dialog",
      "[role='dialog']",
      "[aria-modal='true']"
    ];
    return selectors.flatMap((selector) => candidates(selector));
  }

  function closeButtonIn(scope) {
    const iconSelectors = [
      ".close",
      ".close-btn",
      ".icon-close",
      ".dialog-close",
      ".modal-close",
      ".popup-close",
      "[class*='close']",
      "[aria-label*='关闭']",
      "[aria-label*='close' i]",
      "[title*='关闭']",
      "[title*='close' i]"
    ].join(",");

    const iconButton = Array.from(scope.querySelectorAll(iconSelectors))
      .filter(visible)
      .find((el) => {
        const rect = el.getBoundingClientRect();
        const label = `${textOf(el)} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
        return /关闭|close|×|x/i.test(label) || rect.width <= 48;
      });
    if (iconButton) return iconButton;

    return Array.from(scope.querySelectorAll("button,a,.btn,[role='button']"))
      .filter(visible)
      .find((el) => /关闭|取消|稍后|知道了|我知道了|暂不|完成/.test(textOf(el)));
  }

  async function closeGreetingPopup() {
    await sleep(700);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const containers = modalLikeContainers();
      const scopes = containers.length ? containers : [document.body];
      const button = scopes.map(closeButtonIn).find(Boolean);
      if (!button) {
        if (attempt === 0) {
          document.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true
          }));
          await sleep(300);
          continue;
        }
        return false;
      }
      await clickElement(button);
      await sleep(500);
      if (!modalLikeContainers().length) return true;
    }
    return true;
  }

  async function confirmGreeting(settings) {
    await fillMessageIfPossible(settings);
    const sendButton = findByText("button,a,.btn,[role='button']", /发送|打招呼|立即沟通|确定|开始聊天/);
    if (!sendButton) return false;
    await clickElement(sendButton);
    await sleep(1000);
    await closeGreetingPopup();
    return true;
  }

  async function rejectCard(card, key, verdict) {
    state.filteredKeys.add(key);
    await recordFiltered(card, verdict);
    return { sent: false, filtered: true, reason: verdict.reason };
  }

  async function greetCard(card, settings, filters) {
    const key = cardKey(card);
    if (!key || state.greetedKeys.has(key) || state.contactedKeys.has(key) || state.filteredKeys.has(key)) {
      return { sent: false, filtered: false };
    }

    const salaryOn = salaryEnabled(settings);
    let needDetailSalary = false;

    // 薪资通常写在列表卡片上，先在这里判定，低薪职位连详情都不用点开
    if (salaryOn) {
      const fromCard = readSalary(card, textOf(card), false);
      if (fromCard) {
        const verdict = evaluateSalary(fromCard, settings);
        if (!verdict.pass) return rejectCard(card, key, verdict);
      } else {
        needDetailSalary = true;
      }
    }

    const filtersOn = hasFilters(filters);
    const previousDescription = filtersOn ? jobDescriptionText() : "";
    await selectCard(card);

    // 卡片上没读到薪资时，再从详情面板补一次
    if (needDetailSalary) {
      const verdict = evaluateSalary(readDetailSalary(), settings);
      if (!verdict.pass) return rejectCard(card, key, verdict);
    }

    // 详情面板加载完成后再按岗位描述判定，命中过滤词直接跳过，不再点击"立即沟通"
    if (filtersOn) {
      const description = await waitForJobDescription(previousDescription);
      const verdict = evaluateFilters(card, filters, description);
      if (!verdict.pass) return rejectCard(card, key, verdict);
    }

    const button = findDetailGreetingButton();
    if (!button) {
      // 详情页没有可点击的打招呼按钮，再确认一下是不是"立即沟通"已经被点过、变成"继续沟通"
      const contacted = findByText(
        "a,button,.btn,.op-btn,.btn-startchat,[role='button']",
        /继续沟通/
      );
      if (contacted) {
        state.contactedKeys.add(key);
      }
      return { sent: false, filtered: false };
    }
    await clickElement(button);
    const sent = await confirmGreeting(settings);
    if (sent) state.greetedKeys.add(key);
    return { sent, filtered: false };
  }

  async function maybeLoadMore(settings) {
    if (settings.onlyCurrentPage) return false;
    const before = document.body.scrollHeight;
    window.scrollTo({ top: before, behavior: "smooth" });
    await sleep(1400);
    return document.body.scrollHeight > before;
  }

  function scrollableJobList() {
    const root = jobListRoot();
    const possible = [
      root,
      ...Array.from(root.querySelectorAll(".job-list-box,.search-job-result,.job-list,.job-list-container,.job-card-wrapper"))
    ].filter((el) => el && el !== document && visible(el));

    return possible.find((el) => el.scrollHeight > el.clientHeight + 20)
      || document.scrollingElement
      || document.documentElement;
  }

  async function scrollJobList() {
    const scroller = scrollableJobList();
    const beforeTop = scroller.scrollTop;
    const beforeHeight = scroller.scrollHeight;
    const amount = Math.max(420, Math.floor((scroller.clientHeight || window.innerHeight) * 0.75));

    scroller.scrollBy({ top: amount, behavior: "smooth" });
    await sleep(1200);

    const moved = Math.abs(scroller.scrollTop - beforeTop) > 10;
    const grew = scroller.scrollHeight > beforeHeight + 10;
    return moved || grew;
  }

  async function run(settings) {
    if (state.running) return;
    state.running = true;
    state.stopped = false;
    const filters = compileFilters(settings);
    await setRunner({ running: true, lastStatus: "运行中", filteredCount: 0 });

    try {
      while (!state.stopped) {
        if (isBlockingPage()) {
          await setRunner({ running: false, lastStatus: "遇到登录、验证或频控页面，已停止" });
          break;
        }

        const stats = await getStats();
        if (stats.sent >= settings.dailyLimit) {
          await setRunner({ running: false, lastStatus: "已达到每日上限" });
          break;
        }

        let idleScrolls = 0;
        while (!state.stopped) {
          const card = nextUnattemptedCard();

          if (!card) {
            await setRunner({ running: true, lastStatus: `正在加载左侧更多职位：${scanSummary()}` });
            const scrolled = await scrollJobList();
            if (scrolled && idleScrolls < 8) {
              idleScrolls += 1;
              continue;
            }
            break;
          }

          idleScrolls = 0;
          const current = await getStats();
          if (current.sent >= settings.dailyLimit) break;
          const key = cardKey(card);
          state.attemptedKeys.add(key);
          state.processedCount += 1;
          await setRunner({ running: true, lastStatus: `准备处理：第 ${state.processedCount} 个职位` });
          const result = await greetCard(card, settings, filters);
          if (result.sent) {
            const next = await incrementSent();
            await setRunner({ running: true, lastStatus: `已打招呼 ${next.sent} 个`, filteredCount: state.filteredCount });
            await sleep(randomDelay(settings));
          } else if (result.filtered) {
            state.filteredCount += 1;
            await setRunner({
              running: true,
              lastStatus: `已过滤 ${state.filteredCount} 个：${result.reason}`,
              filteredCount: state.filteredCount
            });
            await sleep(400 + Math.floor(Math.random() * 400));
          } else {
            await sleep(600);
          }
        }

        if (state.stopped) break;
        if (!(await maybeLoadMore(settings))) {
          const filteredPart = state.filteredCount ? `，其中 ${state.filteredCount} 个被过滤词跳过` : "";
          await setRunner({ running: false, lastStatus: `当前页面没有更多可处理职位${filteredPart}` });
          break;
        }
      }
    } catch (error) {
      await setRunner({ running: false, lastStatus: `已停止：${error.message || "页面变化"}` });
    } finally {
      state.running = false;
      state.stopped = false;
      if (state.currentTimer) {
        window.clearTimeout(state.currentTimer);
        state.currentTimer = null;
      }
      const { runner } = await chrome.storage.local.get("runner");
      if (runner?.running) {
        await setRunner({ running: false, lastStatus: "已停止" });
      }
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BOSS_AUTO_GREETING_START") {
      const settings = { ...DEFAULTS, ...(message.settings || {}) };
      state.greetedKeys.clear();
      state.attemptedKeys.clear();
      state.contactedKeys.clear();
      state.filteredKeys.clear();
      state.filteredCount = 0;
      state.processedCount = 0;
      state.jdMisses = 0;
      chrome.storage.local.set({ filterLog: [] });
      run(settings);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "BOSS_AUTO_GREETING_STOP") {
      state.stopped = true;
      if (state.currentTimer) {
        window.clearTimeout(state.currentTimer);
        state.currentTimer = null;
      }
      setRunner({ running: false, lastStatus: "已手动停止" }).then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });

  // 调试用：在职位页控制台执行 __bossFilter.evaluate({ excludeKeywords: "外包" }, "某段岗位描述")
  window.__bossFilter = {
    parseKeywords,
    jobDescriptionText,
    compile: (raw) => compileFilters({ ...DEFAULTS, ...(raw || {}) }),
    evaluate: (raw, description) => evaluateFilters(null, compileFilters({ ...DEFAULTS, ...(raw || {}) }), description),
    parseSalary,
    readCardSalary: (card) => readSalary(card, textOf(card || {}), false),
    readDetailSalary,
    checkSalary: (raw, rawSettings) => evaluateSalary(parseSalary(raw), { ...DEFAULTS, ...(rawSettings || {}) }),
    decodeBossText,
    cleanForDisplay,
    textOf,
    // 排查字体映射是否变化：列出页面薪资元素里出现的私有区码位
    fontChars: () => {
      const counts = new Map();
      for (const el of document.querySelectorAll(SALARY_SELECTORS)) {
        for (const ch of el.textContent || "") {
          const code = ch.codePointAt(0);
          if (code >= 0xE000 && code <= 0xF8FF) counts.set(code, (counts.get(code) || 0) + 1);
        }
      }
      return Array.from(counts.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([code, count]) => ({ hex: `0x${code.toString(16).toUpperCase()}`, code, count }));
    }
  };
})();
