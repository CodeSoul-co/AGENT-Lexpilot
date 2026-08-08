const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CORPUS_PATH = path.resolve(__dirname, '..', 'resources', 'law-corpus', 'v0-minimal.zh-CN.json');
const VERIFIED_AT = '2026-08-08';

const SOURCES = Object.freeze({
  labor: {
    lawName: '中华人民共和国劳动合同法',
    publicationDate: '2012-12-28',
    effectiveDate: '2013-07-01',
    authority: '全国人大常委会办公厅国家法律法规数据库',
    metadataUrl: 'https://flk.npc.gov.cn/detail?fileId=&id=2c909fdd678bf17901678bf74d7106b3&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E5%8A%B3%E5%8A%A8%E5%90%88%E5%90%8C%E6%B3%95&type=',
    textAuthority: '国家市场监督管理总局',
    textUrl: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_0abfdd261c03417b949df19d869add8d.html'
  },
  civil: {
    lawName: '中华人民共和国民法典',
    publicationDate: '2020-05-28',
    effectiveDate: '2021-01-01',
    authority: '全国人大常委会办公厅国家法律法规数据库',
    metadataUrl: 'https://flk.npc.gov.cn/detail?fileId=&id=ff808081729d1efe01729d50b5c500bf&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E6%B0%91%E6%B3%95%E5%85%B8&type=',
    textAuthority: '工业和信息化部天津市通信管理局',
    textUrl: 'https://tjca.miit.gov.cn/zwgk/zcwj/flfg/art/2020/art_20cf1a2e1b854924b5caa744c8045d1f.html'
  },
  tax: {
    lawName: '中华人民共和国税收征收管理法',
    publicationDate: '2015-04-24',
    effectiveDate: '2015-04-24',
    authority: '全国人大常委会办公厅国家法律法规数据库',
    metadataUrl: 'https://flk.npc.gov.cn/detail?id=2c909fdd678bf17901678bf78cff0785&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E7%A8%8E%E6%94%B6%E5%BE%81%E6%94%B6%E7%AE%A1%E7%90%86%E6%B3%95',
    textAuthority: '国家市场监督管理总局',
    textUrl: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_1dbea81872cb4fda9ab3ccc45c627531.html'
  },
  invoice: {
    lawName: '中华人民共和国发票管理办法',
    publicationDate: '2023-07-20',
    effectiveDate: '2023-07-20',
    authority: '国家税务总局',
    metadataUrl: 'https://shanxi.chinatax.gov.cn/web/detail/sx-11400-545-1781492',
    textAuthority: '国家税务总局',
    textUrl: 'https://shanxi.chinatax.gov.cn/web/detail/sx-11400-545-1781492'
  },
  patent: {
    lawName: '中华人民共和国专利法',
    publicationDate: '2020-10-17',
    effectiveDate: '2021-06-01',
    authority: '全国人大常委会办公厅国家法律法规数据库',
    metadataUrl: 'https://flk.npc.gov.cn/detail?fileId=&id=ff808081752b7d430175e4651cbd1547&title=%E4%B8%AD%E5%8D%8E%E4%BA%BA%E6%B0%91%E5%85%B1%E5%92%8C%E5%9B%BD%E4%B8%93%E5%88%A9%E6%B3%95&type=',
    textAuthority: '国家知识产权局',
    textUrl: 'https://www.cnipa.gov.cn/art/2020/11/23/art_97_155167.html'
  },
  copyright: {
    lawName: '中华人民共和国著作权法',
    publicationDate: '2020-11-11',
    effectiveDate: '2021-06-01',
    authority: '国家自然科学基金委员会',
    metadataUrl: 'https://www.nsfc.gov.cn/p1/2871/2872/69475.html',
    textAuthority: '国家自然科学基金委员会',
    textUrl: 'https://www.nsfc.gov.cn/p1/2871/2872/69475.html'
  },
  trademark: {
    lawName: '中华人民共和国商标法',
    publicationDate: '2019-04-23',
    effectiveDate: '2019-11-01',
    authority: '国家知识产权局',
    metadataUrl: 'https://www.cnipa.gov.cn/art/2019/7/30/art_95_28179.html',
    textAuthority: '国家知识产权局',
    textUrl: 'https://www.cnipa.gov.cn/art/2019/7/30/art_95_28179.html',
    effectiveUntil: '2026-12-31',
    futureVersion: {
      effectiveDate: '2027-01-01',
      url: 'https://www.cnipa.gov.cn/art/2026/6/26/art_95_206942.html'
    }
  }
});

const NEW_ARTICLES = Object.freeze([
  ['labor', 'labor', 7, ['employment_relationship', 'employment_roster']],
  ['labor', 'labor', 10, ['written_contract', 'contract_signing_deadline']],
  ['labor', 'labor', 14, ['indefinite_term_contract', 'continuous_employment']],
  ['labor', 'labor', 17, ['mandatory_contract_terms', 'social_insurance']],
  ['labor', 'labor', 19, ['probation_period_limit', 'single_probation']],
  ['labor', 'labor', 20, ['probation_wages', 'minimum_wage']],
  ['labor', 'labor', 21, ['probation_dismissal', 'dismissal_reason']],
  ['labor', 'labor', 30, ['wage_payment', 'payment_order']],
  ['labor', 'labor', 31, ['overtime', 'overtime_pay']],
  ['labor', 'labor', 41, ['economic_layoff', 'priority_retention']],
  ['labor', 'labor', 42, ['dismissal_protection', 'medical_period']],
  ['labor', 'labor', 44, ['contract_termination', 'retirement']],
  ['civil', 'marriage_family', 1054, ['invalid_marriage', 'marriage_status']],
  ['civil', 'marriage_family', 1057, ['domestic_violence', 'family_protection']],
  ['civil', 'marriage_family', 1058, ['equal_family_status', 'family_decisions']],
  ['civil', 'marriage_family', 1060, ['daily_family_agency', 'marital_liability']],
  ['civil', 'marriage_family', 1061, ['spousal_inheritance', 'family_support']],
  ['civil', 'marriage_family', 1067, ['parent_child_support', 'child_support']],
  ['civil', 'marriage_family', 1078, ['divorce_registration', 'divorce_agreement']],
  ['civil', 'marriage_family', 1084, ['child_custody', 'parent_child_relationship']],
  ['civil', 'marriage_family', 1085, ['child_support', 'support_payment']],
  ['civil', 'marriage_family', 1087, ['divorce_property_division', 'child_interest']],
  ['civil', 'marriage_family', 1091, ['divorce_damages', 'domestic_violence']],
  ['civil', 'private_lending', 188, ['limitation_period', 'rights_protection']],
  ['civil', 'private_lending', 667, ['loan_contract', 'principal_and_interest']],
  ['civil', 'private_lending', 673, ['loan_use', 'early_repayment_request']],
  ['civil', 'private_lending', 674, ['interest_payment_term', 'interest_agreement']],
  ['civil', 'private_lending', 677, ['early_repayment', 'actual_loan_period']],
  ['civil', 'private_lending', 678, ['repayment_extension', 'extension_application']],
  ['civil', 'private_lending', 681, ['guarantee_contract', 'debt_security']],
  ['civil', 'private_lending', 686, ['guarantee_method', 'general_guarantee']],
  ['civil', 'private_lending', 687, ['general_guarantee', 'guarantor_defense']],
  ['tax', 'taxation', 15, ['tax_registration', 'registration_deadline']],
  ['tax', 'taxation', 19, ['accounting_records', 'voucher_retention']],
  ['tax', 'taxation', 21, ['invoice_management', 'invoice_issuance']],
  ['tax', 'taxation', 26, ['declaration_extension', 'tax_declaration']],
  ['tax', 'taxation', 30, ['withholding', 'withholding_reporting']],
  ['tax', 'taxation', 31, ['tax_payment_deadline', 'tax_payment']],
  ['tax', 'taxation', 35, ['assessed_tax', 'tax_basis']],
  ['tax', 'taxation', 52, ['tax_overpayment', 'tax_recovery_period']],
  ['invoice', 'taxation', 18, ['invoice_issuance', 'payment_receipt']],
  ['invoice', 'taxation', 21, ['truthful_invoice', 'false_invoice']],
  ['copyright', 'intellectual_property', 2, ['copyright_scope', 'work_protection']],
  ['copyright', 'intellectual_property', 10, ['copyright_content', 'exclusive_rights']],
  ['copyright', 'intellectual_property', 11, ['copyright_ownership', 'authorship']],
  ['copyright', 'intellectual_property', 17, ['audiovisual_work', 'copyright_ownership']],
  ['copyright', 'intellectual_property', 24, ['fair_use', 'statutory_limitation']],
  ['copyright', 'intellectual_property', 52, ['copyright_infringement', 'civil_liability']],
  ['copyright', 'intellectual_property', 53, ['copyright_infringement', 'administrative_liability']],
  ['copyright', 'intellectual_property', 54, ['copyright_damages', 'punitive_damages']],
  ['trademark', 'intellectual_property', 48, ['trademark_use', 'commercial_identification']],
  ['trademark', 'intellectual_property', 56, ['trademark_right_scope', 'approved_goods']],
  ['trademark', 'intellectual_property', 57, ['trademark_infringement', 'confusing_use']],
  ['trademark', 'intellectual_property', 63, ['trademark_damages', 'punitive_damages']]
]);

function chineseNumber(number) {
  const digits = '零一二三四五六七八九';
  if (number < 10) return digits[number];
  if (number < 20) return `十${number % 10 ? digits[number % 10] : ''}`;
  if (number < 100) return `${digits[Math.floor(number / 10)]}十${number % 10 ? digits[number % 10] : ''}`;
  if (number < 1000) {
    const hundreds = Math.floor(number / 100);
    const remainder = number % 100;
    return `${digits[hundreds]}百${remainder === 0 ? '' : remainder < 10 ? `零${digits[remainder]}` : chineseNumber(remainder)}`;
  }
  const thousands = Math.floor(number / 1000);
  const remainder = number % 1000;
  return `${digits[thousands]}千${remainder === 0 ? '' : remainder < 100 ? `零${chineseNumber(remainder)}` : chineseNumber(remainder)}`;
}

function articleNumber(number) {
  return `第${chineseNumber(number)}条`;
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', ensp: ' ', emsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot|ensp|emsp);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const numeric = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}

function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<!--[^]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[^]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .normalize('NFKC')
    .replace(/[\u00a0\u2002\u2003]/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractArticle(pageText, number) {
  const heading = articleNumber(number);
  const headingPattern = new RegExp(`(?:^|\\n)\\s*${heading}\\s*`);
  const match = headingPattern.exec(pageText);
  if (!match) throw new Error(`官方正文中未找到${heading}`);
  const bodyStart = match.index + match[0].length;
  const remainder = pageText.slice(bodyStart);
  const nextHeading = /\n\s*第[零一二三四五六七八九十百千万]+条\s*/.exec(remainder);
  const articleText = remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
  if (articleText.length < 8) throw new Error(`${heading}正文过短`);
  return articleText;
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { 'user-agent': 'LexPilot-law-corpus-refresh/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { text: htmlToText(await response.text()), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw new Error(`官方来源暂时不可用：${url}（${lastError?.message ?? 'unknown'}）`);
}

function idFor(sourceKey, number) {
  const prefix = {
    labor: 'cn.labor-contract-law', civil: 'cn.civil-code', tax: 'cn.tax-collection-administration-law',
    invoice: 'cn.invoice-administration-measures', patent: 'cn.patent-law', copyright: 'cn.copyright-law',
    trademark: 'cn.trademark-law'
  }[sourceKey];
  return `${prefix}.article-${number}`;
}

function profile(entry) {
  const id = entry.id;
  let factRequirements;
  let factExclusions;
  let excerptSignals;
  let unresolvedElements;

  if (id === 'cn.labor-contract-law.article-82') {
    return {
      factRequirements: { employmentDuration: ['mentioned'], writtenContractStatus: ['not_signed'] },
      factExclusions: { writtenContractStatus: ['signed'] },
      safeStopFields: ['employmentDuration', 'writtenContractStatus'],
      excerptSignals: ['工作', '合同', '签'],
      unresolvedElements: ['exact_employment_start_and_duration', 'written_contract_signing_timeline']
    };
  }
  if (id === 'cn.civil-code.article-675') {
    return {
      factRequirements: { evidenceStatus: ['available', 'none_stated'], repaymentTermStatus: ['agreed', 'not_agreed'], repaymentStatus: ['unpaid', 'partial'] },
      factExclusions: { repaymentStatus: ['paid'] },
      safeStopFields: ['evidenceStatus', 'repaymentTermStatus', 'repaymentStatus'],
      excerptSignals: ['借', '还', '到期', '说好'],
      unresolvedElements: ['loan_relationship_validity', 'exact_repayment_terms']
    };
  }
  if (id === 'cn.civil-code.article-676') {
    return {
      factRequirements: { evidenceStatus: ['available', 'none_stated'], repaymentTermStatus: ['agreed'], repaymentStatus: ['unpaid', 'partial'] },
      factExclusions: { repaymentTermStatus: ['not_agreed'], repaymentStatus: ['paid'] },
      safeStopFields: ['evidenceStatus', 'repaymentTermStatus', 'repaymentStatus'],
      excerptSignals: ['借', '还', '到期', '说好'],
      unresolvedElements: ['loan_relationship_validity', 'exact_repayment_due_date', 'applicable_overdue_interest_basis']
    };
  }
  if (id === 'cn.tax-collection-administration-law.article-25') {
    return {
      factRequirements: { taxpayerType: ['self_employed', 'company', 'individual'], taxIssueType: ['filing', 'withholding'], taxPeriod: ['mentioned'] },
      factExclusions: { taxIssueType: ['invoice', 'unrelated'] },
      safeStopFields: ['taxpayerType', 'taxIssueType', 'taxPeriod'],
      excerptSignals: ['税', '申报', '报税', '扣税'],
      unresolvedElements: ['applicable_declaration_deadline', 'actual_declaration_compliance']
    };
  }

  if (entry.legalDomain === 'labor') {
    const issueType = /article-(?:7|10|14|17|82)$/.test(id) ? 'contract'
      : /article-(?:19|20|21)$/.test(id) ? 'probation'
        : /article-30$/.test(id) ? 'unpaid_wages'
          : /article-31$/.test(id) ? 'overtime'
            : /article-(?:37|38)$/.test(id) ? 'employee_termination' : 'dismissal';
    factRequirements = { issueType: [issueType] };
    if (id.endsWith('article-82')) factRequirements.writtenContractStatus = ['not_signed'];
    factExclusions = { issueType: ['other'] };
    excerptSignals = ['工作', '合同', '工资', '辞退', '试用期', '加班'];
    unresolvedElements = ['employment_relationship_evidence', 'employer_documentation'];
  } else if (entry.legalDomain === 'marriage_family') {
    const disputeType = /article-(?:1062|1063|1065|1066|1087)$/.test(id) ? ['property']
      : /article-1064$/.test(id) ? ['debt']
        : /article-(?:1067|1084|1085)$/.test(id) ? ['children']
          : /article-(?:1042|1057|1091)$/.test(id) ? ['domestic_violence', 'bigamy']
            : /article-(?:1054|1076|1077|1078|1079)$/.test(id) ? ['marriage_status']
              : ['property', 'children', 'debt', 'marriage_status'];
    factRequirements = { disputeType };
    factExclusions = { disputeType: ['unrelated'] };
    excerptSignals = ['离婚', '夫妻', '孩子', '财产', '债务', '家庭'];
    unresolvedElements = ['relationship_evidence', 'specific_family_circumstances'];
  } else if (entry.legalDomain === 'private_lending') {
    const lendingIssueType = /article-(?:681|686|687)$/.test(id) ? 'guarantee'
      : /article-188$/.test(id) ? 'limitation'
        : /article-(?:674|675|676|677|678|680)$/.test(id) ? 'repayment_interest' : 'loan_formation';
    factRequirements = { lendingIssueType: [lendingIssueType], evidenceStatus: ['available', 'none_stated'] };
    factExclusions = { lendingIssueType: ['unrelated'] };
    excerptSignals = ['借款', '借条', '还款', '利息', '保证', '担保'];
    unresolvedElements = ['loan_relationship_evidence', 'exact_contract_terms'];
  } else if (entry.legalDomain === 'taxation') {
    const taxIssueType = id.includes('invoice-administration') || /article-21$/.test(id) ? 'invoice'
      : /article-30$/.test(id) ? 'withholding'
        : /article-(?:25|26|31|52|62)$/.test(id) ? 'filing'
          : /article-(?:32|63|64|65|66|67|68)$/.test(id) ? 'additional_tax' : 'general';
    factRequirements = { taxpayerType: ['individual', 'company', 'self_employed'], taxIssueType: [taxIssueType], taxPeriod: ['mentioned'] };
    factExclusions = { taxIssueType: ['unrelated'] };
    excerptSignals = ['报税', '纳税', '税款', '扣税', '发票'];
    unresolvedElements = ['applicable_tax_type', 'official_tax_records'];
  } else {
    const rightType = id.includes('patent-law') ? ['patent']
      : id.includes('trademark-law') ? ['trademark'] : ['written_work', 'image', 'software'];
    factRequirements = { rightType, allegedAct: ['copy', 'repost', 'sale', 'use'], authorizationStatus: ['not_authorized'] };
    factExclusions = { authorizationStatus: ['authorized'] };
    excerptSignals = ['文章', '图片', '软件', '商标', '专利', '复制', '使用', '销售'];
    unresolvedElements = ['right_ownership_evidence', 'statutory_exception'];
  }

  return {
    factRequirements,
    factExclusions,
    safeStopFields: Object.keys(factRequirements),
    excerptSignals,
    unresolvedElements
  };
}

function selectionReason(entry) {
  const domainLabels = {
    labor: '劳动用工',
    marriage_family: '婚姻家庭',
    private_lending: '民间借贷',
    taxation: '税务合规',
    intellectual_property: '知识产权'
  };
  const factLabels = {
    issueType: '争议事项',
    employmentDuration: '工作时长',
    writtenContractStatus: '书面合同状态',
    dismissalGround: '解除原因',
    noticeOrPayStatus: '通知或补偿情况',
    relationshipStatus: '关系状态',
    disputeType: '争议类型',
    lendingIssueType: '借贷事项',
    evidenceStatus: '证据情况',
    repaymentStatus: '还款状态',
    repaymentTermStatus: '还款期限约定',
    taxpayerType: '涉税主体',
    taxIssueType: '涉税事项',
    taxPeriod: '涉税期间',
    rightType: '权利类型',
    allegedAct: '相关行为',
    authorizationStatus: '授权情况'
  };
  const fieldNames = Object.keys(entry.matching.factRequirements)
    .map((field) => factLabels[field] ?? '必要事实')
    .join('、');
  return `该条与 LexPilot 已支持的${fieldNames}直接对应，用于补齐${domainLabels[entry.legalDomain]}领域现有检索链路中的适用要素、例外或责任环节。`;
}

async function main() {
  const existing = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const newById = new Map(
    NEW_ARTICLES.map(([sourceKey, legalDomain, number, topics]) => [
      idFor(sourceKey, number), { sourceKey, legalDomain, number, topics }
    ])
  );
  const allEntries = existing.entries.map((entry) => ({ ...entry }));
  for (const [id, candidate] of newById) {
    if (!allEntries.some((entry) => entry.id === id)) {
      const source = SOURCES[candidate.sourceKey];
      allEntries.push({
        id,
        legalDomain: candidate.legalDomain,
        lawName: source.lawName,
        articleNumber: articleNumber(candidate.number),
        topics: candidate.topics,
        publicationDate: source.publicationDate,
        effectiveDate: source.effectiveDate,
        status: 'effective',
        source: {
          authority: source.authority,
          metadataUrl: source.metadataUrl,
          textAuthority: source.textAuthority,
          textUrl: source.textUrl
        },
        ...(source.effectiveUntil ? { effectiveUntil: source.effectiveUntil, futureVersion: source.futureVersion } : {})
      });
    }
  }

  if (process.argv.includes('--reasons-only')) {
    for (const entry of allEntries) {
      entry.matching = profile(entry);
      entry.selectionReason = selectionReason(entry);
    }
    const corpus = { ...existing, entries: allEntries };
    fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ entryCount: allEntries.length, updated: 'selectionReason' }, null, 2));
    return;
  }

  const pages = new Map();
  for (const url of [...new Set(allEntries.map((entry) => entry.source.textUrl))]) {
    const fetched = await fetchWithRetry(url);
    pages.set(url, fetched.text);
    process.stderr.write(`verified source ${new URL(url).hostname} in ${fetched.attempts} attempt(s)\n`);
  }

  for (const entry of allEntries) {
    const number = Number(entry.id.match(/article-(\d+)$/)?.[1]);
    if (!Number.isInteger(number)) throw new Error(`无法解析条款编号：${entry.id}`);
    entry.articleNumber = articleNumber(number);
    entry.articleText = extractArticle(pages.get(entry.source.textUrl), number);
    entry.articleTextSha256 = crypto.createHash('sha256').update(entry.articleText, 'utf8').digest('hex');
    entry.verifiedAt = VERIFIED_AT;
    entry.retrievalEnabled = true;
    entry.matching = profile(entry);
    entry.selectionReason = selectionReason(entry);
  }

  const unique = new Set(allEntries.map((entry) => `${entry.lawName}::${entry.articleNumber}`));
  if (allEntries.length !== 100 || unique.size !== 100) {
    throw new Error(`数量或去重校验失败：${allEntries.length}/${unique.size}`);
  }

  const corpus = {
    ...existing,
    corpusId: 'law-corpus.cn.v0-100',
    version: '1.0.0',
    verifiedAt: VERIFIED_AT,
    entries: allEntries
  };
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ entryCount: allEntries.length, uniqueCount: unique.size }, null, 2));
    return;
  }
  fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ entryCount: allEntries.length, uniqueCount: unique.size, output: CORPUS_PATH }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
