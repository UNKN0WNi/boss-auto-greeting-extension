# BOSS Auto Greeting Chrome Extension

这是一个 Manifest V3 Chrome 扩展，用于在 BOSS 直聘职位列表页手动启动、限速执行“打招呼”。

## 安装

1. 打开 Chrome，进入 `chrome://extensions/`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展”。
4. 选择本目录：`boss-auto-greeting-extension`。

## 使用

1. 打开职位页，例如 `https://www.zhipin.com/web/geek/jobs?query=Java&city=101280100`。
2. 点击 Chrome 工具栏里的 `BOSS Auto Greeting`。
3. 设置每日上限、间隔和打招呼内容。
4. 点击“开始”。需要暂停时点击“停止”。

## 行为说明

- 插件只在你点击“开始”后执行。
- 默认只处理当前已经加载出来的职位。
- 遇到登录、验证码、安全验证、账号异常、访问过于频繁等页面会停止。
- 不读取 cookies、密码、简历文件或浏览器账号数据。
- 页面结构变化时，可能需要调整 `content.js` 里的按钮匹配规则。

