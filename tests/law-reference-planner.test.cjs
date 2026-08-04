const assert = require('node:assert/strict');
const test = require('node:test');
const { planLawRetrieval } = require('../src/v0/law-reference-planner.cjs');

test('maps only supported structured facts to law corpus topics', () => {
  const cases = [
    [
      'labor',
      { employmentDuration: 'mentioned', writtenContractStatus: 'not_signed' },
      ['written_contract']
    ],
    [
      'labor',
      {
        issueType: 'dismissal',
        writtenContractStatus: 'signed',
        dismissalGround: 'performance',
        noticeOrPayStatus: 'neither',
        performanceRemediationOutcome: 'no_training_or_adjustment'
      },
      ['dismissal_notice_or_pay']
    ],
    [
      'private_lending',
      { repaymentTermStatus: 'agreed', repaymentStatus: 'unpaid' },
      ['repayment_term', 'overdue_interest']
    ],
    [
      'private_lending',
      { repaymentTermStatus: 'not_agreed', repaymentStatus: 'partial' },
      ['repayment_term']
    ],
    [
      'marriage_family',
      { relationshipStatus: 'married', disputeType: 'domestic_violence' },
      ['domestic_violence']
    ],
    [
      'marriage_family',
      { relationshipStatus: 'married', disputeType: 'bigamy' },
      ['bigamy']
    ],
    [
      'marriage_family',
      { relationshipStatus: 'married', disputeType: 'marriage_freedom' },
      ['marriage_freedom']
    ],
    ['taxation', { taxIssueType: 'filing' }, ['tax_declaration']],
    ['taxation', { taxIssueType: 'withholding' }, ['withholding_declaration']],
    [
      'intellectual_property',
      { rightType: 'patent', allegedAct: 'sale', authorizationStatus: 'not_authorized' },
      ['patent_implementation']
    ]
  ];

  for (const [legalDomain, knownFacts, topics] of cases) {
    const result = planLawRetrieval({ legalDomain, knownFacts });
    assert.equal(result.eligible, true);
    assert.deepEqual(result.topics, topics);
  }
});

test('does not broaden retrieval when facts cannot support a corpus topic', () => {
  const cases = [
    ['labor', { writtenContractStatus: 'signed' }],
    [
      'labor',
      { issueType: 'dismissal', writtenContractStatus: 'signed', dismissalGround: 'performance' }
    ],
    [
      'labor',
      {
        issueType: 'dismissal',
        writtenContractStatus: 'signed',
        dismissalGround: 'other',
        noticeOrPayStatus: 'neither'
      }
    ],
    [
      'labor',
      { issueType: 'unpaid_wages', writtenContractStatus: 'signed' }
    ],
    [
      'private_lending',
      { repaymentTermStatus: 'agreed', repaymentStatus: 'paid' }
    ],
    ['marriage_family', { relationshipStatus: 'married', disputeType: 'property' }],
    ['taxation', { taxIssueType: 'invoice' }],
    [
      'intellectual_property',
      { rightType: 'trademark', authorizationStatus: 'not_authorized' }
    ],
    [
      'intellectual_property',
      { rightType: 'patent', allegedAct: 'copy', authorizationStatus: 'not_authorized' }
    ]
  ];

  for (const [legalDomain, knownFacts] of cases) {
    const result = planLawRetrieval({ legalDomain, knownFacts });
    assert.equal(result.eligible, false);
    assert.deepEqual(result.topics, []);
  }
});
