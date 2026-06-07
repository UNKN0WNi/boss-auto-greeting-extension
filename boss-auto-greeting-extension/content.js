(() => {
  const DEFAULTS = {
    dailyLimit: 20,
    minDelay: 8,
    maxDelay: 18,
    message: "您好，我对这个岗位很感兴趣，想进一步了解一下，谢谢。",
    onlyCurrentPage: true
  };

  const state = {
    running: false,
    stopped: false,
    currentTimer: null,
    greetedKeys: new Set(),
    attemptedKeys: new Set(),
    contactedKeys: new Set(),
    processedCount: 0
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

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
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

  function nextUnattemptedCard() {
    return jobCards().find((card) => {
      const key = cardKey(card);
      return key
        && !state.attemptedKeys.has(key)
        && !state.greetedKeys.has(key)
        && !state.contactedKeys.has(key);
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
        && !state.contactedKeys.has(key);
    });
    return `扫描到 ${links.length} 个链接、${cards.length} 个职位、${fresh.length} 个未尝试`;
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

  async function greetCard(card, settings) {
    const key = cardKey(card);
    if (!key || state.greetedKeys.has(key) || state.contactedKeys.has(key)) return false;

    await selectCard(card);
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
      return false;
    }
    await clickElement(button);
    const sent = await confirmGreeting(settings);
    if (sent) state.greetedKeys.add(key);
    return sent;
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
    await setRunner({ running: true, lastStatus: "运行中" });

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
          await setRunner({ running: true, lastStatus: `准备打招呼：第 ${state.processedCount} 个职位` });
          const sent = await greetCard(card, settings);
          if (sent) {
            const next = await incrementSent();
            await setRunner({ running: true, lastStatus: `已打招呼 ${next.sent} 个` });
            await sleep(randomDelay(settings));
          } else {
            await sleep(600);
          }
        }

        if (state.stopped) break;
        if (!(await maybeLoadMore(settings))) {
          await setRunner({ running: false, lastStatus: "当前页面没有更多可处理职位" });
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
      state.processedCount = 0;
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
})();
