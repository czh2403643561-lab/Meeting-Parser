const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "title_utils.js"), "utf8");
const context = {};
vm.runInNewContext(source, context);

assert.equal(context.normalizeRecordingTitle("录制文件"), "");
assert.equal(context.normalizeRecordingTitle("第14章：子平启蒙指微读书会 子平阶段总结"), "第14章：子平启蒙指微读书会 子平阶段总结");
assert.equal(
  context.normalizeFilenamePart('第14章：A/B?C*D|E<测试>"') ,
  "第14章：A／B？C＊D｜E＜测试＞＂"
);
assert.equal(context.normalizeFilenamePart("标题. "), "标题");
assert.ok([...context.normalizeFilenamePart("长".repeat(300))].length <= 220);

const heading = {
  tagName: "H1",
  textContent: "第14章：子平启蒙指微读书会 子平阶段总结",
  hidden: false,
  id: "recording-title",
  className: "recording-title",
  getAttribute: () => null,
  getBoundingClientRect: () => ({ top: 24 })
};
const contentContext = {
  console,
  location: { hostname: "meeting.tencent.com", pathname: "/crm/example" },
  navigator: { userAgent: "test" },
  document: {
    title: "录制文件",
    documentElement: {},
    querySelectorAll: (selector) => selector === "h1" ? [heading] : [],
    addEventListener: () => {}
  },
  getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  MutationObserver: class { observe() {} },
  chrome: { runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } } },
  setTimeout,
  clearTimeout
};
vm.runInNewContext(`${source}\n${fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8")}`, contentContext);
assert.equal(contentContext.extractRecordingTitle(), "第14章：子平启蒙指微读书会 子平阶段总结");

console.log("filename_rules.test.js passed");
