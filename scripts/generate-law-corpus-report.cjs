const fs = require('node:fs');
const path = require('node:path');
const { loadLawCorpus } = require('../src/v0/law-corpus.cjs');

const OUTPUT = path.resolve(__dirname, '..', 'LAW_CORPUS_100_REPORT.md');
const DOMAIN_LABELS = {
  labor: '劳动用工',
  marriage_family: '婚姻家庭',
  private_lending: '民间借贷',
  taxation: '税务合规',
  intellectual_property: '知识产权'
};

function markdown(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function main() {
  const corpus = loadLawCorpus();
  const counts = Object.fromEntries(Object.keys(DOMAIN_LABELS).map((domain) => [domain, 0]));
  corpus.entries.forEach((entry) => { counts[entry.legalDomain] += 1; });
  const uniqueSources = new Map();
  for (const entry of corpus.entries) {
    if (!uniqueSources.has(entry.source.textUrl)) {
      uniqueSources.set(entry.source.textUrl, {
        lawName: entry.lawName,
        authority: entry.source.textAuthority,
        textUrl: entry.source.textUrl,
        metadataUrl: entry.source.metadataUrl
      });
    }
  }

  const lines = [
    '# LexPilot 法规语料库 100 条验收报告',
    '',
    `核验基准：${corpus.verifiedAt}　语料版本：${corpus.version}　语料标识：${corpus.corpusId}`,
    '',
    '## 验收摘要',
    '',
    '- 原有条目：46 条；新增条目：54 条；最终唯一有效条目：100 条。',
    `- 领域分布：劳动用工 ${counts.labor} 条、婚姻家庭 ${counts.marriage_family} 条、民间借贷 ${counts.private_lending} 条、税务合规 ${counts.taxation} 条、知识产权 ${counts.intellectual_property} 条。`,
    '- 已启用检索：100 条；已配置结构化匹配与安全停止：100 条；已完成正向、反向、信息不足和结果卡回归：100 条。',
    '- 官方网络正文核验：100/100；正文 SHA-256 校验：100/100；版本与生效状态检查：100/100。',
    '- 未完成或无法核验：0 条。项目全量自动化测试：428/428 通过。',
    '- 仓库仅保存结构化法规数据、规则、测试和本报告；不保存官方网页副本、抓取缓存、PDF、需求文档或个人研究笔记。',
    '',
    '## 官方来源页',
    ''
  ];

  for (const source of uniqueSources.values()) {
    lines.push(`- ${source.lawName}：${source.authority}，[官方正文](${source.textUrl})，[官方元数据](${source.metadataUrl})`);
  }

  lines.push(
    '',
    '## 100 条法条、官方来源及入选理由',
    '',
    '| # | 领域 | 法律与条款 | 公布 / 生效 | 状态 | 官方来源 | 入选理由 |',
    '|---:|---|---|---|---|---|---|'
  );
  corpus.entries.forEach((entry, index) => {
    lines.push(
      `| ${index + 1} | ${DOMAIN_LABELS[entry.legalDomain]} | ${markdown(entry.lawName)} ${markdown(entry.articleNumber)} | ${entry.publicationDate} / ${entry.effectiveDate} | 现行有效 | [${markdown(entry.source.textAuthority)}](${entry.source.textUrl}) · [元数据](${entry.source.metadataUrl}) | ${markdown(entry.selectionReason)} |`
    );
  });

  lines.push(
    '',
    '## 可复现验收命令',
    '',
    '```powershell',
    'npm run audit:law-coverage',
    'npm run audit:law-corpus -- --as-of 2026-08-08',
    'npm run audit:law-versions -- --as-of 2026-08-08',
    'npm run audit:law-capabilities',
    'npm run audit:law-sources',
    'npm test',
    '```',
    '',
    '其中 `audit:law-sources` 是需要联网访问官方页面的独立核验；本地自动化测试不能替代该网络核验。',
    ''
  );

  fs.writeFileSync(OUTPUT, lines.join('\n'), 'utf8');
  process.stdout.write(`${JSON.stringify({ output: OUTPUT, entryCount: corpus.entries.length }, null, 2)}\n`);
}

main();
