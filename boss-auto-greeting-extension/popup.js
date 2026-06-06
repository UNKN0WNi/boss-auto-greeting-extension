const DEFAULTS = {
  dailyLimit: 20,
  minDelay: 8,
  maxDelay: 18,
  message: "您好，我对这个岗位很感兴趣，想进一步了解一下，谢谢。",
  onlyCurrentPage: true
};

const els = {
  dailyLimit: document.getElementById("dailyLimit"),
  minDelay: document.getElementById("minDelay"),
  maxDelay: document.getElementById("maxDelay"),
  message: document.getElementById("message"),
  onlyCurrentPage: document.getElementById("onlyCurrentPage"),
  sentToday: document.getElementById("sentToday"),
  lastStatus: document.getElementById("lastStatus"),
  statusBadge: document.getElementById("statusBadge"),
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

async function load() {
  const stored = await chrome.storage.local.get(["settings", "stats", "runner"]);
  const settings = normalizeSettings(stored.settings);
  els.dailyLimit.value = settings.dailyLimit;
  els.minDelay.value = settings.minDelay;
  els.maxDelay.value = settings.maxDelay;
  els.message.value = settings.message;
  els.onlyCurrentPage.checked = settings.onlyCurrentPage;

  const stats = stored.stats || {};
  const sent = stats.date === todayKey() ? Number(stats.sent || 0) : 0;
  els.sentToday.textContent = String(sent);

  const runner = stored.runner || {};
  const running = Boolean(runner.running);
  els.statusBadge.textContent = running ? "运行中" : "待机";
  els.statusBadge.classList.toggle("running", running);
  els.lastStatus.textContent = runner.lastStatus || "未开始";
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
}

async function saveSettings() {
  const settings = normalizeSettings({
    dailyLimit: els.dailyLimit.value,
    minDelay: els.minDelay.value,
    maxDelay: els.maxDelay.value,
    message: els.message.value,
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

for (const input of [els.dailyLimit, els.minDelay, els.maxDelay, els.message, els.onlyCurrentPage]) {
  input.addEventListener("change", saveSettings);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stats || changes.runner)) {
    load();
  }
});

load();
