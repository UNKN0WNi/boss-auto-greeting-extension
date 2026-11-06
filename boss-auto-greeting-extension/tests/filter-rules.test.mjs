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

console.log(`通过 ${passed} / ${passed + failures.length}`);
if (failures.length) {
  console.log("\n失败用例：");
  for (const item of failures) console.log(`- ${item}`);
  process.exit(1);
}
