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

const els = {
  dailyLimit: document.getElementById("dailyLimit"),
  minDelay: document.getElementById("minDelay"),
  maxDelay: document.getElementById("maxDelay"),
  message: document.getElementById("message"),
  excludeKeywords: document.getElementById("excludeKeywords"),
  includeKeywords: document.getElementById("includeKeywords"),
  includeModeAll: document.getElementById("includeModeAll"),
  matchCardInfo: document.getElementById("matchCardInfo"),
  caseSensitive: document.getElementById("caseSensitive"),
  minSalary: document.getElementById("minSalary"),
  salaryBasis: document.getElementById("salaryBasis"),
  skipUnknownSalary: document.getElementById("skipUnknownSalary"),
  onlyCurrentPage: document.getElementById("onlyCurrentPage"),
  sentToday: document.getElementById("sentToday"),
  filteredCount: document.getElementById("filteredCount"),
  lastStatus: document.getElementById("lastStatus"),
  statusBadge: document.getElementById("statusBadge"),
  filterLogList: document.getElementById("filterLogList"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn")
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeSettings(raw) {
  const settings = { ...DEFAULTS, ...raw };
  settings.dailyLimit = Math.max(1, Math.min(100, Number(settings.dailyLimit) || DEFAULTS.dailyLimit));
  settings.minDelay = Math.max(3, Math.min(120, Number(settings.minDelay) || DEFAULTS.minDelay));
  settings.maxDelay = Math.max(settings.minDelay + 1, Math.min(180, Number(settings.maxDelay) || DEFAULTS.maxDelay));
  settings.message = String(settings.message || DEFAULTS.message).slice(0, 180);
  settings.excludeKeywords = String(settings.excludeKeywords || "").slice(0, 3000);
  settings.includeKeywords = String(settings.includeKeywords || "").slice(0, 3000);
  settings.includeMode = settings.includeMode === "all" ? "all" : "any";
  settings.matchCardInfo = settings.matchCardInfo !== false;
  settings.caseSensitive = Boolean(settings.caseSensitive);
  settings.minSalary = Math.max(0, Math.min(200, Number(settings.minSalary) || 0));
  settings.salaryBasis = settings.salaryBasis === "upper" ? "upper" : "lower";
  settings.skipUnknownSalary = Boolean(settings.skipUnknownSalary);
  settings.onlyCurrentPage = Boolean(settings.onlyCurrentPage);
  return settings;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToActiveTab(payload) {
  const tab = await activeTab();
  if (!tab?.id || !/^https:\/\/www\.zhipin\.com\//.test(tab.url || "")) {
    throw new Error("请先打开 BOSS 直聘职位列表页");
  }
  return chrome.tabs.sendMessage(tab.id, payload);
}

// 历史记录里可能存着 BOSS 薪资字体的私有区字符，渲染前统一清掉，避免显示方框
function cleanText(value) {
  return Array.from(String(value ?? ""))
    .map((ch) => {
      const code = ch.codePointAt(0);
      const unreadable = (code >= 0xE000 && code <= 0xF8FF)
        || (code >= 0xF0000 && code <= 0x10FFFD)
        || code === 0xFFFD
        || code === 0xFEFF
        || (code >= 0x200B && code <= 0x200F);
      return unreadable ? "" : ch;
    })
    .join("")
    // 旧记录里数字被清掉后会留下 " -K" 这类残片
    .replace(/[\s\-~—－至到]+[kK千万]\S*\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderFilterLog(entries) {
  const list = els.filterLogList;
  list.textContent = "";

  if (!entries.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "暂无过滤记录";
    list.appendChild(empty);
    return;
  }

  for (const entry of entries.slice(0, 12)) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.className = "log-title";
    title.textContent = cleanText(entry?.title) || "未知职位";
    const reason = document.createElement("span");
    reason.className = "log-reason";
    reason.textContent = cleanText(entry?.reason) || "被过滤";
    item.append(title, reason);
    list.appendChild(item);
  }
}

async function load() {
  const stored = await chrome.storage.local.get(["settings", "stats", "runner", "filterLog"]);
  const settings = normalizeSettings(stored.settings);
  els.dailyLimit.value = settings.dailyLimit;
  els.minDelay.value = settings.minDelay;
  els.maxDelay.value = settings.maxDelay;
  els.message.value = settings.message;
  els.excludeKeywords.value = settings.excludeKeywords;
  els.includeKeywords.value = settings.includeKeywords;
  els.includeModeAll.checked = settings.includeMode === "all";
  els.matchCardInfo.checked = settings.matchCardInfo;
  els.caseSensitive.checked = settings.caseSensitive;
  els.minSalary.value = settings.minSalary;
  els.salaryBasis.value = settings.salaryBasis;
  els.skipUnknownSalary.checked = settings.skipUnknownSalary;
  els.onlyCurrentPage.checked = settings.onlyCurrentPage;

  const stats = stored.stats || {};
  const sent = stats.date === todayKey() ? Number(stats.sent || 0) : 0;
  els.sentToday.textContent = String(sent);

  const runner = stored.runner || {};
  const running = Boolean(runner.running);
  els.statusBadge.textContent = running ? "运行中" : "待机";
  els.statusBadge.classList.toggle("running", running);
  els.lastStatus.textContent = cleanText(runner.lastStatus) || "未开始";
  els.filteredCount.textContent = String(Number(runner.filteredCount || 0));
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;

  renderFilterLog(Array.isArray(stored.filterLog) ? stored.filterLog : []);
}

async function saveSettings() {
  const settings = normalizeSettings({
    dailyLimit: els.dailyLimit.value,
    minDelay: els.minDelay.value,
    maxDelay: els.maxDelay.value,
    message: els.message.value,
    excludeKeywords: els.excludeKeywords.value,
    includeKeywords: els.includeKeywords.value,
    includeMode: els.includeModeAll.checked ? "all" : "any",
    matchCardInfo: els.matchCardInfo.checked,
    caseSensitive: els.caseSensitive.checked,
    minSalary: els.minSalary.value,
    salaryBasis: els.salaryBasis.value,
    skipUnknownSalary: els.skipUnknownSalary.checked,
    onlyCurrentPage: els.onlyCurrentPage.checked
  });
  await chrome.storage.local.set({ settings });
  return settings;
}

els.startBtn.addEventListener("click", async () => {
  try {
    const settings = await saveSettings();
    await sendToActiveTab({ type: "BOSS_AUTO_GREETING_START", settings });
    await load();
  } catch (error) {
    els.lastStatus.textContent = error.message;
  }
});

els.stopBtn.addEventListener("click", async () => {
  try {
    await sendToActiveTab({ type: "BOSS_AUTO_GREETING_STOP" });
    await load();
  } catch (error) {
    els.lastStatus.textContent = error.message;
  }
});

els.clearLogBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ filterLog: [] });
  await load();
});

for (const input of [
  els.dailyLimit,
  els.minDelay,
  els.maxDelay,
  els.message,
  els.excludeKeywords,
  els.includeKeywords,
  els.includeModeAll,
  els.matchCardInfo,
  els.caseSensitive,
  els.minSalary,
  els.salaryBasis,
  els.skipUnknownSalary,
  els.onlyCurrentPage
]) {
  input.addEventListener("change", saveSettings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stats || changes.runner || changes.filterLog)) {
    load();
  }
});

load();
