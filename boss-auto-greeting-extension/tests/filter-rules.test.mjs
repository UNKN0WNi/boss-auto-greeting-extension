// 过滤规则单测：直接加载 content.js，在最小的 DOM 桩里验证纯逻辑
// 运行：node tests/filter-rules.test.mjs
import fs from "node:fs";
import vm from "node:vm";

const contentPath = new URL("../content.js", import.meta.url);
const code = fs.readFileSync(contentPath, "utf8");

function loadExtension() {
  const context = {
    window: {
      setTimeout: () => 0,
      clearTimeout: () => {},
      innerWidth: 1440,
      innerHeight: 900,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      addEventListener: () => {}
    },
    document: {
      body: { innerText: "" },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      dispatchEvent: () => {}
    },
    chrome: {
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener: () => {} }
      },
      runtime: { onMessage: { addListener: () => {} } }
    },
    location: { href: "https://www.zhipin.com/web/geek/jobs" },
    InputEvent: class {},
    KeyboardEvent: class {},
    HTMLTextAreaElement: class {},
    HTMLInputElement: class {},
    URL,
    console
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context.window.__bossFilter;
}

const api = loadExtension();

const JD = `
岗位职责：
1. 负责公司核心业务系统的后端开发，参与需求评审；
2. 与产品、测试协作完成迭代交付。
任职要求：
1. 本科及以上学历，3 年以上 Java 开发经验；
2. 熟悉 Spring Boot、MySQL，有分布式经验优先。
`;

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
  } else {
    failures.push(`${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`);
  }
}

// 1. 关键词解析：换行 / 中英文逗号 / 顿号 / 分号 / 竖线，去空去重
check(
  "parseKeywords 支持多种分隔符并去重",
  api.parseKeywords("外包, 驻场\n销售、单休；Java|外包\n\n  "),
  ["外包", "驻场", "销售", "单休", "Java"]
);

// 2. 命排除词 → 跳过
const hitExclude = api.evaluate({ excludeKeywords: "外包\n驻场" }, JD + "\n本岗位为外包驻场岗位。");
check("命中排除词被跳过", [hitExclude.pass, hitExclude.keyword], [false, "外包"]);
check("跳过原因可读", hitExclude.reason, "命中排除词「外包」");

// 3. 没命中排除词、也没有必需词 → 通过
check("无规则命中则通过", api.evaluate({ excludeKeywords: "外包" }, JD).pass, true);

// 4. 必需词（任一）：都不出现 → 跳过
const anyMiss = api.evaluate({ includeKeywords: "Vue\nReact" }, JD);
check("必需词任一未命中被跳过", [anyMiss.pass, anyMiss.rule], [false, "require-any"]);

// 5. 必需词（任一）：命中一个 → 通过
check("必需词任一命中则通过", api.evaluate({ includeKeywords: "Vue\nJava" }, JD).pass, true);

// 6. 必需词需全部：缺一个 → 跳过，并指出缺的词
const allMiss = api.evaluate({ includeKeywords: "Java\nGo", includeMode: "all" }, JD);
check("必需词需全部出现", [allMiss.pass, allMiss.keyword], [false, "Go"]);

// 7. 必需词需全部：全部命中 → 通过
check(
  "必需词全部命中则通过",
  api.evaluate({ includeKeywords: "Java\nMySQL", includeMode: "all" }, JD).pass,
  true
);

// 8. 排除词优先于必需词
const both = api.evaluate({ excludeKeywords: "外包", includeKeywords: "Java" }, JD + "\n外包项目。");
check("排除词优先", [both.pass, both.rule], [false, "exclude"]);

// 9. 默认不区分大小写
check("默认不区分大小写", api.evaluate({ excludeKeywords: "JAVA" }, JD).pass, false);
check("可开启区分大小写", api.evaluate({ excludeKeywords: "JAVA", caseSensitive: true }, JD).pass, true);

// 10. 描述读不到时不拦截，避免误杀
const unknown = api.evaluate({ excludeKeywords: "外包" }, "");
check("描述为空时放行", [unknown.pass, Boolean(unknown.unknown)], [true, true]);

// 11. 必需词为空字符串时视为不限制
check("必需词留空不限制", api.evaluate({ excludeKeywords: "", includeKeywords: "  " }, JD).pass, true);

// ---------- 最低薪资过滤 ----------

function checkRange(name, raw, min, max, tolerance = 0.01) {
  const result = api.parseSalary(raw);
  if (!result) {
    failures.push(`${name}\n  期望解析成功，实际返回 null`);
    return;
  }
  const ok = Math.abs(result.min - min) <= tolerance && Math.abs(result.max - max) <= tolerance;
  if (ok) passed += 1;
  else failures.push(`${name}\n  期望: [${min}, ${max}]\n  实际: [${result.min}, ${result.max}]`);
}

checkRange("K 区间", "15-25K", 15, 25);
checkRange("带 13 薪后缀", "20-40K·13薪", 20, 40);
checkRange("带 14 薪后缀", "8-12K·14薪", 8, 12);
checkRange("小写 k 与波浪线", "10~20k", 10, 20);
checkRange("万元区间折算成 K", "1.5-2.5万/月", 15, 25);
checkRange("15K 以上单值", "15K以上", 15, 15);
checkRange("日薪折算成月薪", "300-500元/天", 6.53, 10.88);
checkRange("卡片混合文本中只取薪资区间", "Java开发工程师 15-25K 3-5年 本科", 15, 25);

check("面议无法识别", api.parseSalary("薪资面议"), null);
check("经验年限不会被当成薪资", api.parseSalary("3-5年 本科"), null);
check("关闭时（0）不拦截", api.checkSalary("5-8K", { minSalary: 0 }).pass, true);

const lowSalary = api.checkSalary("15-25K", { minSalary: 20 });
check("按下限：15-25K 低于 20K 被跳过", [lowSalary.pass, lowSalary.rule], [false, "salary"]);
check("跳过原因含薪资文本", lowSalary.reason.includes("15-25K"), true);

check(
  "按上限：15-25K 达到 20K 保留",
  api.checkSalary("15-25K", { minSalary: 20, salaryBasis: "upper" }).pass,
  true
);
check("按下限：25-40K 保留", api.checkSalary("25-40K", { minSalary: 20 }).pass, true);
check("13 薪不影响基础月薪判定", api.checkSalary("20-40K·13薪", { minSalary: 20 }).pass, true);
check("日薪职位按月薪比较", api.checkSalary("300-500元/天", { minSalary: 20 }).pass, false);

const unknownSalary = api.checkSalary("面议", { minSalary: 20 });
check("薪资未知默认放行", [unknownSalary.pass, Boolean(unknownSalary.unknown)], [true, true]);
check(
  "可配置薪资未知时跳过",
  [api.checkSalary("面议", { minSalary: 20, skipUnknownSalary: true }).pass],
  [false]
);

// ---------- BOSS 薪资字体（PUA）解码 ----------

// U+E031 ~ U+E03A 对应 0 ~ 9
const E = (digit) => String.fromCodePoint(0xE031 + digit);
const puaSalary = `${E(1)}${E(5)}-${E(2)}${E(5)}K·${E(1)}${E(3)}薪`; // 15-25K·13薪
const puaTitle = `后端工程师 ${E(1)}${E(5)}-${E(2)}${E(5)}K`;

check("解码私有区数字", api.decodeBossText(puaSalary), "15-25K·13薪");
check("textOf 自动解码", api.textOf({ innerText: puaTitle }), "后端工程师 15-25K");
check("解码后可正常解析薪资", [api.parseSalary(puaSalary).min, api.parseSalary(puaSalary).max], [15, 25]);
check("parseSalary 直接接收乱码文本", api.parseSalary(puaSalary).raw, "15-25K·13薪");
check("乱码薪资也按最低月薪判定", api.checkSalary(puaSalary, { minSalary: 20 }).pass, false);
check("乱码薪资达标时放行", api.checkSalary(`${E(2)}${E(5)}-${E(4)}${E(0)}K`, { minSalary: 20 }).pass, true);

const unknownPua = `后端${String.fromCodePoint(0xE100)}工程师${String.fromCodePoint(0xE101)}`;
check("未知私有区字符被清除", api.decodeBossText(unknownPua), "后端工程师");
check("展示文本不再含方框字符", /[\uE000-\uF8FF]/.test(api.cleanForDisplay(unknownPua)), false);
check("零宽字符被清除", api.cleanForDisplay("薪资\u200B面议"), "薪资面议");

// ---------- 过滤记录里的公司名 ----------

function node(text, children = []) {
  return {
    innerText: text,
    querySelectorAll: (sel) => (sel === "a,h3,.name,[class*='name'],span" ? children : []),
    querySelector: () => null
  };
}

function fakeCard(text, companyNodes = []) {
  return {
    innerText: text,
    querySelectorAll: (sel) => (sel.includes("company-name") ? companyNodes : []),
    querySelector: () => null
  };
}

const COMPANY = "北京星辰科技有限公司";
const verdict = { reason: "命中排除词「外包」", rule: "exclude", keyword: "外包" };

const cardWithCompany = fakeCard(`后端工程师 15-25K ${COMPANY} 已上市 1000-9999人`, [node(COMPANY)]);
const entryWithCompany = api.filterLogEntry(cardWithCompany, verdict);
check("过滤记录带公司名", entryWithCompany.company, COMPANY);
check("职位名里不再重复公司名", entryWithCompany.title, "后端工程师");
check("公司名不影响过滤原因", [entryWithCompany.reason, entryWithCompany.rule], ["命中排除词「外包」", "exclude"]);

const noisy = fakeCard("后端工程师 15-25K", [node(`${COMPANY} 已上市 1000-9999人`)]);
check("公司名去掉融资阶段与规模噪音", api.filterLogEntry(noisy, verdict).company, COMPANY);

const longContainer = node(
  `${COMPANY} 互联网电子商务 计算机软件 企业服务 数据服务 北京市朝阳区 望京 甲级写字楼`,
  [node(COMPANY)]
);
check(
  "命中大容器时取内部公司名元素",
  api.filterLogEntry(fakeCard("后端工程师", [longContainer]), verdict).company,
  COMPANY
);

const textOnlyCard = fakeCard(`后端工程师 15-25K ${COMPANY} 已上市`);
check("卡片无公司元素时从文本兜底提取", api.filterLogEntry(textOnlyCard, verdict).company, COMPANY);
check("cardCompany 调试接口可用", api.cardCompany(textOnlyCard), COMPANY);

const noCompanyCard = fakeCard("后端工程师 15-25K 3-5年 本科");
check("无公司信息时字段为空", api.filterLogEntry(noCompanyCard, verdict).company, "");
check("无可用详情面板时不会误记别的公司", api.filterLogEntry(noCompanyCard, verdict, true).company, "");

const puaCompanyCard = fakeCard("后端工程师", [node(`星辰${String.fromCodePoint(0xE100)}科技有限公司`)]);
check("公司名里的私有区字符被清除", api.filterLogEntry(puaCompanyCard, verdict).company, "星辰科技有限公司");

console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log("\n失败用例：");
  for (const item of failures) console.log(`- ${item}`);
  process.exit(1);
}
