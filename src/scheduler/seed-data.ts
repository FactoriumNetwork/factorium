const dailyFacts = [
  {
    type: 'fact-check' as const,
    subject: 'Claim: "Bitcoin mining uses more electricity than Argentina"',
    result: JSON.stringify({ verdict: 'true-at-time', source: 'Cambridge Centre for Alternative Finance 2024', annualTWh: 121, argentinaTWh: 125, note: 'As of mid-2024, Bitcoin mining uses approximately 121 TWh/year; Argentina uses 125 TWh/year. Close but not exceeding.' }),
    resultSummary: 'Mostly accurate: Cambridge data shows ~121 TWh vs Argentina 125 TWh. Dated comparison but directionally correct.',
    confidence: 0.89,
    price: 5,
  },
  {
    type: 'fact-check' as const,
    subject: 'Claim: "Vaccines cause autism" — Wakefield 1998 study legacy',
    result: JSON.stringify({ verdict: 'false', consensus: 'overwhelmingly refuted', studiesReviewed: 67, sampleSize: 'over 20 million children', source: 'WHO, CDC, Cochrane Review' }),
    resultSummary: 'False: 67+ studies across 20M children show no link. Lancet retracted original paper in 2010.',
    confidence: 0.99,
    price: 5,
  },
  {
    type: 'content-authenticity' as const,
    subject: 'Image: "Shark swimming on flooded highway" — hurricane misinformation pattern',
    result: JSON.stringify({ authentic: false, pattern: 'recurring-viral-hoax', firstSeen: '2011 Hurricane Irene', reappearances: 7, detectionMethod: 'reverse image search + metadata analysis' }),
    resultSummary: 'Hoax: Image has resurfaced during 7 different hurricanes since 2011. Composite or AI-generated.',
    confidence: 0.96,
    price: 8,
  },
  {
    type: 'deepfake-detection' as const,
    subject: 'Common pattern: AI-generated LinkedIn profile photos — telltale markers',
    result: JSON.stringify({ isAIGenerated: true, markers: ['asymmetric earrings/jewelry', 'unnatural eye reflections', 'GAN fingerprint in frequency domain', 'inconsistent background blur gradients'], detectionMethod: 'spectral analysis + GAN fingerprint detection' }),
    resultSummary: 'AI-generated profile detection guide: watch for asymmetric accessories, unnatural eye reflections, and spectral GAN fingerprints.',
    confidence: 0.93,
    price: 12,
  },
  {
    type: 'code-audit' as const,
    subject: 'npm package: event-stream v3.3.6 — known supply chain attack (2018)',
    result: JSON.stringify({ audited: true, riskLevel: 'critical', cve: 'CVE-2018-1000174', description: 'Malicious dependency flatmap-stream injected Bitcoin-stealing code targeting Copay wallet users. Demonstrates supply chain risk of unvetted maintainer transfers.' }),
    resultSummary: 'Critical: CVE-2018-1000174. Injected Bitcoin wallet stealer via compromised maintainer. Landmark supply chain attack case study.',
    confidence: 0.99,
    price: 25,
  },
  {
    type: 'identity-verification' as const,
    subject: 'Domain: openai.com — impersonation domain analysis (openai.co, openai.io, openai.net)',
    result: JSON.stringify({ legitimate: 'openai.com', impersonationDomains: ['openai.co (squatted)', 'openai.io (redirects to phishing)', 'openai.net (unregistered)'], riskAssessment: 'High risk of typo-squatting attacks targeting ChatGPT users' }),
    resultSummary: 'Warning: openai.co and openai.io are impersonation domains. Users should verify they are on openai.com.',
    confidence: 0.97,
    price: 3,
  },
  {
    type: 'document-validation' as const,
    subject: 'Template: Standard Non-Disclosure Agreement (NDA) — one-way, California jurisdiction',
    result: JSON.stringify({ valid: true, templateType: 'NDA-one-way-CA', lastReviewed: '2025', containsUnconscionable: false, standardClauses: ['definition-of-confidential', 'exclusions', 'term-5-years', 'governing-law-ca', 'injunctive-relief'] }),
    resultSummary: 'Valid template: Standard one-way NDA for California. All standard clauses present. No unconscionable terms detected.',
    confidence: 0.94,
    price: 20,
  },
  {
    type: 'content-authenticity' as const,
    subject: 'Statistic: "90% of startups fail within the first year"',
    result: JSON.stringify({ verdict: 'false', actualRate: '~20% in first year, ~50% by year 5', source: 'U.S. Bureau of Labor Statistics 2024', methodology: 'Tracked 100,000+ new business entities from formation' }),
    resultSummary: 'False: BLS data shows ~20% failure in year 1, ~50% by year 5. The 90% figure is a persistent myth.',
    confidence: 0.95,
    price: 5,
  },
];

let seededFactsToday = 0;

export function getTodaysFreshAttestations(): typeof dailyFacts {
  const today = new Date().toISOString().slice(0, 10);
  return dailyFacts.map((f) => ({
    ...f,
    subject: `[${today}] ${f.subject}`,
    resultSummary: `[${today}] ${f.resultSummary}`,
  }));
}

export function getSeededFactsCount(): number {
  return seededFactsToday;
}

export function incrementSeededFactsCount(): void {
  seededFactsToday++;
}

export function shouldSeedToday(lastSeededDate: string | null): boolean {
  const today = new Date().toISOString().slice(0, 10);
  return lastSeededDate !== today;
}
