/*!
 * builtin-skills.js — 内置技能（SKILL.md 文本，首次运行播种到技能库）
 * 全部为「方法论 + 输出模板 + 工具白名单」，与 WorkBuddy/OpenClaw 的 SKILL.md 同构，
 * 可直接导出/迁移。默认【未启用】，由用户在 🧩 面板中开启（避免无意打破前缀缓存）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BUILTIN_SKILLS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var SKILLS = [
    '---\n' +
    'name: weekly-report\n' +
    'description: 根据本周工作记录生成结构化周报（成果-问题-计划）\n' +
    'version: 1\n' +
    'source: builtin\n' +
    'toolWhitelist: [read_file, write_file, markdown_to_pdf]\n' +
    'outputTemplate: |\n' +
    '  # 周报（{{week}}\n' +
    '  ## 本周成果\n' +
    '  ## 问题与风险\n' +
    '  ## 下周计划\n' +
    'rules:\n' +
    '  - 数据必须来自实际工作记录，不得编造\n' +
    '  - 措辞简洁，突出可量化结果\n' +
    '---\n' +
    '## 适用场景\n' +
    '- 每周五生成周报\n' +
    '## 执行步骤\n' +
    '1. 读取本周工作记录（用户提供或从指定文件读取）\n' +
    '2. 按「成果 / 问题 / 计划」三段式组织\n' +
    '3. 输出为 Markdown；如需要，用 markdown_to_pdf 导出 PDF\n',
    '---\n' +
    'name: meeting-minutes\n' +
    'description: 把会议记录/转写整理为纪要（决议-待办-负责人-截止）\n' +
    'version: 1\n' +
    'source: builtin\n' +
    'toolWhitelist: [read_file, write_file, todo_write]\n' +
    'rules:\n' +
    '  - 只提取明确表达的结论与行动项，不臆测\n' +
    '  - 每条待办必须有负责人与截止时间，缺失则标注「待定」\n' +
    '---\n' +
    '## 执行步骤\n' +
    '1. 通读会议记录，抽取关键信息\n' +
    '2. 输出：会议要点 / 决议 / 待办清单（负责人·截止）/ 遗留问题\n' +
    '3. 待办可用 todo_write 落成任务清单\n',
    '---\n' +
    'name: data-report\n' +
    'description: 读取表格数据 → 汇总分析 → 生成带图表的报告/PPT\n' +
    'version: 1\n' +
    'source: builtin\n' +
    'toolWhitelist: [list_dir, read_file, chart, data_to_chart, markdown_to_pdf, markdown_to_pptx, html_to_ppt]\n' +
    'outputTemplate: |\n' +
    '  # 数据分析报告\n' +
    '  ## 结论摘要\n' +
    '  ## 图表\n' +
    '  ## 明细\n' +
    'rules:\n' +
    '  - 先给结论，再给证据；图表必须有标题与口径说明\n' +
    '  - 所有数字来自源数据，注明计算口径\n' +
    '---\n' +
    '## 执行步骤\n' +
    '1. 定位并读取数据文件（xlsx/csv）\n' +
    '2. 汇总计算（同比/环比/占比等），生成图表（chart）\n' +
    '3. 组织成报告；如需要，导出 PPT（markdown_to_pptx）\n'
  ];
  return { list: function () { return SKILLS.slice(); } };
});
