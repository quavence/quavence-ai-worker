/**
 * Domain-specific profiles for Quavence Bounty Composer.
 * Supplies grounded vocabulary for deliverables, acceptance, and proof
 * preventing few-shot contamination and hallucinated proposals.
 */

export const DOMAIN_PROFILES = {
  design: {
    deliverables: [
      {
        labelRu: 'Векторные исходники',
        labelEn: 'Vector source files',
        value: 'Source files in SVG/Figma format with exported assets at standard resolutions',
      },
      {
        labelRu: 'Цветовая палитра',
        labelEn: 'Color palette guide',
        value: 'Color palette and typography guidelines matching the Quavence design system',
      },
      {
        labelRu: 'Превью-пак',
        labelEn: 'Preview asset pack',
        value: 'Exported preview gallery showing all assets on dark (#020617) background',
      },
    ],
    acceptance: [
      {
        labelRu: 'Контраст на тёмном',
        labelEn: 'Dark theme contrast',
        value: 'Meets contrast ratio requirements on dark background and legible at minimum scale',
      },
      {
        labelRu: 'Чистота векторов',
        labelEn: 'Clean vector paths',
        value: 'Clean vector outlines with no stray nodes, overlapping paths, or raster artifacts',
      },
      {
        labelRu: 'Стиль бренда',
        labelEn: 'Brand style consistency',
        value: 'Consistently follows Quavence neon/cyberpunk aesthetics and grid guidelines',
      },
    ],
    proof: [
      {
        labelRu: 'Ссылка на исходники',
        labelEn: 'Link to source files',
        value: 'Link to shared folder (Figma/Drive) containing organized source files named by ID',
      },
      {
        labelRu: 'Превью-борд',
        labelEn: 'Preview board link',
        value: 'Link or screenshot of the assembled preview board displaying all deliverable items',
      },
    ],
  },
  development: {
    deliverables: [
      {
        labelRu: 'Pull Request',
        labelEn: 'Pull Request',
        value: 'Pull request to the specified repository implementing the requested changes',
      },
      {
        labelRu: 'Юнит-тесты',
        labelEn: 'Unit tests',
        value: 'Automated test suite covering the new logic and edge cases',
      },
      {
        labelRu: 'Документация',
        labelEn: 'Documentation',
        value: 'Updated documentation, README, or API specification reflecting the changes',
      },
    ],
    acceptance: [
      {
        labelRu: 'CI без ошибок',
        labelEn: 'Passing CI checks',
        value: 'All CI checks, build pipelines, and automated test runs pass without failures',
      },
      {
        labelRu: 'Чистый линтер',
        labelEn: 'Zero linter warnings',
        value: 'Zero new linter warnings, type errors, or architectural violations',
      },
      {
        labelRu: 'Тестовое покрытие',
        labelEn: 'Maintained test coverage',
        value: 'Code coverage maintained or improved according to repository thresholds',
      },
    ],
    proof: [
      {
        labelRu: 'Ссылка на PR',
        labelEn: 'Pull request link',
        value: 'Link to the open or merged pull request with passing checks',
      },
      {
        labelRu: 'Лог тестов',
        labelEn: 'Test run log / badge',
        value: 'Test execution summary or link to successful CI build run',
      },
    ],
  },
  crypto_web3: {
    deliverables: [
      {
        labelRu: 'Смарт-контракт',
        labelEn: 'Smart contract code',
        value: 'Smart contract source code with deployment scripts and migration files',
      },
      {
        labelRu: 'Сьют тестов',
        labelEn: 'Contract test suite',
        value: 'Automated unit and fuzz tests covering invariant properties and permissions',
      },
      {
        labelRu: 'Аудит / секьюрити чек',
        labelEn: 'Security review notes',
        value: 'Security review checklist and static analyzer report',
      },
    ],
    acceptance: [
      {
        labelRu: 'Тесты контракта',
        labelEn: '100% test pass rate',
        value: 'All contract unit, scenario, and edge case tests pass in local testnet',
      },
      {
        labelRu: 'Безопасность',
        labelEn: 'Zero critical issues',
        value: 'Zero high or critical security findings identified in static analysis',
      },
      {
        labelRu: 'Газовая оптимизация',
        labelEn: 'Gas optimization bar',
        value: 'Gas usage profiles within specified limits for main user interaction methods',
      },
    ],
    proof: [
      {
        labelRu: 'Эксплорер / адрес',
        labelEn: 'Explorer verified link',
        value: 'Verified contract link on the block explorer or testnet deployment TxID',
      },
      {
        labelRu: 'Отчёт тестов',
        labelEn: 'Test execution report',
        value: 'Link to full test execution report and gas benchmark log',
      },
    ],
  },
  smm_marketing: {
    deliverables: [
      {
        labelRu: 'Тексты публикаций',
        labelEn: 'Post copy package',
        value: 'Publication texts in agreed format with designated hashtags and links',
      },
      {
        labelRu: 'Медиа-ассеты',
        labelEn: 'Media assets',
        value: 'High-resolution images or short video clips matching the campaign style',
      },
    ],
    acceptance: [
      {
        labelRu: 'Tone of voice',
        labelEn: 'Brand voice compliance',
        value: 'Matches project tone of voice, editorial guidelines, and contains zero typos',
      },
      {
        labelRu: 'Соблюдение формата',
        labelEn: 'Format & character limits',
        value: 'Complies with target platform character limits, formatting, and layout standards',
      },
    ],
    proof: [
      {
        labelRu: 'Ссылка на публикацию',
        labelEn: 'Published post URL',
        value: 'Public URL to the published post on the specified channel or platform',
      },
      {
        labelRu: 'Скриншот охвата',
        labelEn: 'Analytics screenshot',
        value: 'Screenshot showing published post and initial engagement/reach metrics',
      },
    ],
  },
  content_media: {
    deliverables: [
      {
        labelRu: 'Готовая статья/документ',
        labelEn: 'Completed article / doc',
        value: 'Written article or tutorial in Markdown format with structured sections',
      },
      {
        labelRu: 'Иллюстрации/схемы',
        labelEn: 'Diagrams and media',
        value: 'Annotated diagrams and screenshots supporting the written content',
      },
    ],
    acceptance: [
      {
        labelRu: 'Фактическая точность',
        labelEn: 'Fact check & clarity',
        value: 'Factually verified, clear step-by-step instructions with working code/link references',
      },
      {
        labelRu: 'Редполитика',
        labelEn: 'Editorial guidelines',
        value: 'Adheres to project style guide, zero plagiarism, and grammatical correctness',
      },
    ],
    proof: [
      {
        labelRu: 'Ссылка на публикацию',
        labelEn: 'Published document link',
        value: 'Public link to the published article, tutorial, or pull request to docs',
      },
      {
        labelRu: 'Аппрув редактора',
        labelEn: 'Editorial sign-off',
        value: 'Review comment or sign-off confirmation from the content lead',
      },
    ],
  },
  ai_automation: {
    deliverables: [
      {
        labelRu: 'Промпты и воркфлоу',
        labelEn: 'Prompt & workflow scripts',
        value: 'System prompt definitions and workflow pipeline script files',
      },
      {
        labelRu: 'Бенчмарк датасет',
        labelEn: 'Evaluation dataset',
        value: 'Evaluation dataset with reference test inputs and expected ground truth outputs',
      },
    ],
    acceptance: [
      {
        labelRu: 'Метрики качества',
        labelEn: 'Quality threshold met',
        value: 'Achieves target accuracy or evaluation score on the benchmark test set',
      },
      {
        labelRu: 'Устойчивость схемы',
        labelEn: 'Schema stability',
        value: 'Outputs strictly adhere to defined JSON schema without syntax or parse errors',
      },
    ],
    proof: [
      {
        labelRu: 'Лог запуска',
        labelEn: 'Benchmark run log',
        value: 'Execution log from the evaluation suite showing test cases and score breakdown',
      },
      {
        labelRu: 'Репозиторий воркфлоу',
        labelEn: 'Repository link',
        value: 'Link to repository or gist containing the workflow code and runnable example',
      },
    ],
  },
  community: {
    deliverables: [
      {
        labelRu: 'Материалы комьюнити',
        labelEn: 'Community guide package',
        value: 'Onboarding documentation, FAQ guide, or moderation handbook',
      },
      {
        labelRu: 'Отчёт по активности',
        labelEn: 'Activity report',
        value: 'Summary report of handled user inquiries, hosted session, or moderation activity',
      },
    ],
    acceptance: [
      {
        labelRu: 'Полнота ответов',
        labelEn: 'Response quality & accuracy',
        value: 'Clear, accurate answers addressing all frequent user questions and scenarios',
      },
      {
        labelRu: 'Тон общения',
        labelEn: 'Helpful & welcoming tone',
        value: 'Patient, polite, and constructive tone representing the Quavence community',
      },
    ],
    proof: [
      {
        labelRu: 'Ссылки на треды/чат',
        labelEn: 'Chat / thread links',
        value: 'Links to relevant discussion threads, announcements, or event recording',
      },
    ],
  },
  analytics_research: {
    deliverables: [
      {
        labelRu: 'Аналитический отчёт',
        labelEn: 'Analysis report deck',
        value: 'Structured analytical report with key findings, methodology, and recommendations',
      },
      {
        labelRu: 'Датасет и расчёты',
        labelEn: 'Data tables & calculations',
        value: 'Spreadsheet or repository with raw collected data and reproducible calculations',
      },
    ],
    acceptance: [
      {
        labelRu: 'Проверяемость данных',
        labelEn: 'Reproducible data sources',
        value: 'All metrics and citations traced to verifiable primary sources or on-chain queries',
      },
      {
        labelRu: 'Чёткие выводы',
        labelEn: 'Actionable takeaways',
        value: 'Conclusions logically follow from the data with clear actionable takeaways',
      },
    ],
    proof: [
      {
        labelRu: 'Ссылка на документ',
        labelEn: 'Report document link',
        value: 'Link to shared report document (Google Docs/PDF/Notion) with comment access',
      },
    ],
  },
};

/**
 * Generates the DOMAIN PROFILE block to inject into the system prompt.
 * Grounding the LLM in domain-specific vocabulary.
 */
export function getDomainProfileBlock(domainId) {
  const normalizedId = String(domainId || '').trim().toLowerCase();
  const profile = DOMAIN_PROFILES[normalizedId];
  if (!profile) return '';

  const formatOptions = (items) =>
    (items || []).map((item) => `"${item.value}"`).join(' | ');

  return [
    `DOMAIN PROFILE (detected domain: "${normalizedId}"):`,
    `  deliverables options: ${formatOptions(profile.deliverables)}`,
    `  acceptance options:   ${formatOptions(profile.acceptance)}`,
    `  proof options:        ${formatOptions(profile.proof)}`,
    'DOMAIN PROPOSAL RULE: followUpChips values MUST strictly adhere to this domain vocabulary.',
    'NEVER suggest options from other domains (e.g. no social media screenshots for design or development tasks).',
  ].join('\n');
}

/**
 * Deterministically constructs followUpChips for open gaps using domain profiles.
 * Runs without LLM invocation, eliminating retry waterfalls.
 */
export function buildDomainChipsForGaps(domainId, openGaps, ownerUsesRussian = false) {
  const normalizedId = String(domainId || '').trim().toLowerCase();
  const profile = DOMAIN_PROFILES[normalizedId] || DOMAIN_PROFILES.development;
  if (!profile) return [];

  const gaps = Array.isArray(openGaps) ? openGaps : [];
  const chips = [];

  for (const gap of gaps) {
    const options = profile[gap];
    if (!Array.isArray(options) || !options.length) continue;

    // Pick top option for this gap
    const chosen = options[0];
    chips.push({
      label: ownerUsesRussian ? chosen.labelRu : chosen.labelEn,
      value: chosen.value,
      section: gap,
    });

    // Optionally add a second option if available
    if (options.length > 1 && chips.length < 3) {
      const second = options[1];
      chips.push({
        label: ownerUsesRussian ? second.labelRu : second.labelEn,
        value: second.value,
        section: gap,
      });
    }

    if (chips.length >= 3) break;
  }

  return chips.slice(0, 3);
}
