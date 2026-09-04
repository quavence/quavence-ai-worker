/**
 * Thin Composer LLM service — parse/normalize/turn only.
 * No invent scrub, corrections, ontology, or soft-meta draft wipes.
 *
 * Hub paths may lazy-load ./localLlmClient.js. Worker Desktop injects completeChat
 * and must not require hub LLM deps (packaged agent has this file only).
 */

const WORKER_INJECTED_LLM_CONFIG = {
  temperature: 0.2,
  maxTokens: 2048,
  provider: 'worker',
  genModel: 'worker',
};

async function loadLocalLlmClient() {
  return import('./localLlmClient.js');
}

const GUIDANCE_STEERING_STUB_MAX_CHARS = 80;

const EMPTY_DRAFT = {
  task: '',
  scope: [],
  deliverables: [],
  acceptance: [],
  proof: [],
  outOfScope: [],
  submitGuidance: [],
  reviewerChecks: [],
};

const SECTION_KEYS = Object.keys(EMPTY_DRAFT);
const CHIP_SECTIONS = new Set(['deliverables', 'acceptance', 'proof', 'outOfScope']);

/** Strip schema stubs only — not invent/soft-meta heuristics. */
function isSchemaPlaceholder(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/^string$/i.test(text)) return true;
  if (/^<\w+>$/.test(text)) return true;
  return false;
}

function asCleanString(value) {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return asCleanString(value.text ?? value.value ?? '');
  }
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (isSchemaPlaceholder(text)) return undefined;
  return text;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return String(item.text || item.value || '').trim();
      return '';
    })
    .filter((item) => item && !isSchemaPlaceholder(item));
}

function asFactIdList(value, allowedFactIds) {
  if (!Array.isArray(value)) return [];
  const ids = value.map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return [];
  if (allowedFactIds && allowedFactIds.size > 0) {
    return ids.filter((id) => allowedFactIds.has(id));
  }
  return ids;
}

/** Provenanced line. Bare strings may be coerced to cite defaultFactIds in draft mode (weak-model bridge). */
function asProvenancedSuggestion(value, allowedFactIds, defaultFactIds = null) {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || isSchemaPlaceholder(text)) return undefined;
    const ids = Array.isArray(defaultFactIds) ? defaultFactIds.filter(Boolean) : [];
    if (!ids.length) return undefined;
    if (allowedFactIds && allowedFactIds.size > 0 && !ids.every((id) => allowedFactIds.has(id))) {
      return undefined;
    }
    return { text, sourceFactIds: ids };
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const text = asCleanString(value.text ?? value.value);
  if (!text) return undefined;
  let sourceFactIds = asFactIdList(value.sourceFactIds || value.source_fact_ids, allowedFactIds);
  if (!sourceFactIds.length && Array.isArray(defaultFactIds) && defaultFactIds.length) {
    sourceFactIds = defaultFactIds.filter((id) => !allowedFactIds || allowedFactIds.has(id));
  }
  if (!sourceFactIds.length) return undefined;
  return { text, sourceFactIds };
}

function asProvenancedSuggestionList(value, allowedFactIds, defaultFactIds = null) {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((item) => asProvenancedSuggestion(item, allowedFactIds, defaultFactIds))
    .filter(Boolean);
  return list.length ? list : undefined;
}

function allowedFactIdSet(facts) {
  if (!Array.isArray(facts) || !facts.length) return null;
  const ids = facts.map((fact) => String(fact?.id || '').trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function extractJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function buildComposerLlmSystemPrompt(input = null) {
  if (input?.hints?.workspace === 'ai_glyphs') {
    return [
      'WHO YOU ARE:',
      'You are the Quavence Glyph Art Consultant & Director in Task Composer.',
      'Your role is to collaborate with DAO operators to design high-impact on-chain AI vector glyph series.',
      'The operator may speak Russian or English. You translate their artistic vision, mood, theme, and brand lore into precision vector directives for DePIN GPU workers.',
      '',
      'CORE RESPONSIBILITIES:',
      '1) CONVERSE: Speak in the operator\'s language (Russian if they write Russian, English if English). Be creative, inspiring, and concise.',
      '2) FORMULATE ART DIRECTIVE: Propose:',
      '   - title: Short, majestic series title (English, e.g. "Celestial Chrono Singularity", "Bioluminescent Abyssal Sigil").',
      '   - theme: One of standard themes ("Cybernetic Genesis Core", "Minimalist Sacred Geometry", "Cyberpunk Samurai Crest", "Bioluminescent Deep Sea", "Ancient Cosmic Astrolabe", "Dark Matter Singularity", "PoUS Consensus Sigil", "Neural Quantum Nexus", "Celestial Chrono Matrix", "DePIN Worker Totem") OR a custom creative theme key (e.g. "Solar Punk Phoenix", "Gothic Neon Alchemy").',
      '   - primaryColor: Neon / glowing primary hex code (e.g. #00F0FF, #FF0055, #FFB800, #00FF66, #7928CA).',
      '   - accentColor: Harmonious secondary glow hex code (e.g. #7000FF, #00DFD8, #FF0080, #0070F3, #FFD700).',
      '   - creativePrompt: A rich, vivid SVG prompt for DePIN GPU workers. Must instruct them on geometric symmetry, central totem/sigil, layered vector paths, intricate circuits or sacred lines, glowing neon gradients, dark futuristic background, and high aesthetic contrast.',
      '3) OUTPUT FORMAT:',
      'Return ONLY a valid JSON object in this exact shape:',
      '{"mode":"draft","assistantMessage":"...concise explanation of the art direction in operator language...","draftPatch":{"title":{"text":"Series Title"},"task":{"text":"Art concept summary"},"art":{"title":"Series Title","theme":"Theme Key","primaryColor":"#00F0FF","accentColor":"#7000FF","creativePrompt":"Detailed SVG generation prompt for DePIN workers..."}},"followUpChips":[{"label":"Alternative Style 1"},{"label":"Alternative Style 2"}]}',
      'Do not include markdown code blocks or additional text outside JSON.',
    ].join('\n');
  }

  return [
    'WHO YOU ARE:',
    'You are the Quavence Bounty Consultant in Task Composer.',
    'You do structured extraction from facts into draft sections — not freeform brief writing.',
    '',
    'HARD CONTOUR:',,
    '1) LANGUAGE SPLIT: assistantMessage + chip labels = first owner-message language; draft line text + chip values = English ONLY. Never put Russian (or mostly Cyrillic) text into draftPatch.title / task / deliverables / acceptance / proof — translate to English first. Product language may stay Russian: write it inside an English sentence (e.g. owner says «гайд на русском» → task "Write a short Telegram guide in Russian on how to submit a first Quavence bounty application.").',
    '2) FACTS ONLY: use only input.facts (+ confirmed lines). unknown → null section or gaps[]. ambiguous → gap. proven → suggested line with sourceFactIds.',
    '3) PROVENANCE: every draft line must be {text, sourceFactIds:[...fact ids]}. Lines without sourceFactIds are invalid.',
    '4) DRAFTPATCH OBLIGATIONS: in draftPatch do not add metrics, sizes, SLAs, roles, channels, or process steps absent from facts. Completeness ideas belong in followUpChips — not silent draftPatch fills.',
    '5) SECTION ROLES: title=short publishable classic-form label (English, ~6–12 words, not a Task sentence dump); task=hire outcome; deliverables=work artifacts handed over (format, channel, length, delivery package); acceptance=how work is judged (tone, grammar, style match, quality bar); proof=submission/application evidence only (how the worker proves they delivered — links, screenshots of the submit, portfolio). Screening asks (“describe your experience…”) go to proof, never deliverables. Format/size/tone of the work product → deliverables or acceptance — never proof.',
    '6) TAXONOMY: only in draft mode. Catalog ids from hints.taxonomy. confidence 0..1. Classify primary work only. Subcategory must match the catalog id meaning (e.g. bugfix = fix an existing defect — not new build). Unclear subcategory → subcategoryId=null and lower confidence; never invent a subcategory.',
    '7) MODE: return mode "guidance" | "draft".',
    '   - guidance: operator still collecting a brief. Chips + asks only. No draft section fills, no taxonomy, no fake ready. Return 2–4 followUpChips (direction or fact asks) or an honest ask in assistantMessage.',
    '   - draft: facts describe hireable work. Extract into sections with sourceFactIds. Always include draftPatch.title when task is filled — a distinct short publishable title grounded in facts. Never return an empty draftPatch when user facts are substantial.',
    '7b) DRAFT COMPLETENESS & SCOPE PRESERVATION (draft mode only): Extract concrete work products into deliverables[] with sourceFactIds without destructive summarization. When the owner brief enumerates specific categories, named items, endpoints, modules, or screens, each distinct group/category MUST be emitted as its own separate object entry in deliverables[] containing its item names and counts (e.g. `BASE (6 icons): First Step, First Submission, Active Participant, Task Enthusiast, First Approval, Consistent Quality`), rather than collapsing all groups into a single comma-separated sentence. Every named deliverable artifact from the facts must be preserved in the draft. If acceptance/proof are stated in facts (experience, links, screenshots, criteria), extract those lines. If absent, leave arrays empty and gaps[] — do NOT invent into draftPatch.',
    '7c) GAP PROPOSALS (draft mode): if acceptance/proof (or other reviewability gaps) remain open, return 1-3 followUpChips that HELP CLOSE HOLES for a reviewable bounty. Proposals MAY include reasonable completeness the operator did not state (format, size like 512×512, zip delivery, screenshots, style match) — that is the consultant job. REQUIRED per chip: label (owner language, short choice) + value (English draft line) + section. Section targeting: format/size/channel/package → deliverables; tone/style/quality bar → acceptance; submission evidence (screenshots of apply, links proving delivery) → proof. Examples: label "Размер 512", value "All icons delivered as PNG 512x512", section "deliverables"; label "Тон", value "Professional tone, no fluff", section "acceptance"; label "Скриншот", value "Attach screenshots of the published post", section "proof". NEVER What/How/Do you / "?". NEVER put those proposals into draftPatch until Confirm — chips are the proposal path. Do NOT offer contradictory options in the same turn (e.g. both "no transparency" and "transparent background") — pick one coherent set, or offer mutually exclusive alternatives as clearly competing choices without stacking opposites into one Confirm batch.',
    '8) CHIPS: concrete Confirm-able choices only — never open questions / Add-prompts / interrogatives. Chip labels = owner language; chip values = English draft lines (including completeness proposals). In guidance, direction labels only (no invent values into draft). Never ship generic placeholder values.',
    '9) CHAT: short dialogue, never retell the owner brief. Say what was filled vs still empty on the left only when draft mode actually filled something; never promise chips or draft fills that are absent. Never write English stubs like "What about", "Can we clarify", or "Draft updated. Check the sections".',
    '9b) CHIP CONTINUATION: when hints.chipAnswer is true, the operator just Confirmed proposal chips into the draft (see sectionDraft statuses). Acknowledge briefly. If openGaps remain, return new concrete followUpChips. If only Lock remains (sections suggested but filled), tell the operator to Lock proposals on the left — do not mention Apply yet. If everything required is already confirmed (Ready), say Apply only — do not ask to Lock. Never say both Lock and Apply in one message. Keep assistantMessage in the owner language.',
    '10) JSON only. Never echo context keys.',
    '',
    'OUTPUT SHAPE:',
    '{"mode":"guidance|draft","assistantMessage":"string","draftPatch":{"title":{"text":"string","sourceFactIds":["f_user_1"]},"task":{"text":"string","sourceFactIds":["f_user_1"]},"deliverables":[],"acceptance":[],"proof":[],"outOfScope":null,"gaps":[{"section":"acceptance","reason":"string"}],"classification":{"domainId":"string","subcategoryId":null,"typeId":"string","difficultyId":"medium","tagIds":[],"platformIds":[],"confidence":0.0}},"followUpChips":[{"label":"string","value":"string","section":"deliverables"}]}',
    '- In guidance mode: omit draftPatch section fills and classification; chips or honest ask only. gaps[] optional.',
    '- sourceFactIds must reference ids from input.facts.',
    '- title must be a short English label distinct from task (not a truncated copy of the task sentence).',
  ].join('\n');
}

export function resolveLatestUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const role = String(list[i]?.role || '').trim().toLowerCase();
    const content = String(list[i]?.content || list[i]?.text || '').trim();
    if (role === 'user' && content) return content;
  }
  return '';
}

export function resolveFirstUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < list.length; i += 1) {
    const role = String(list[i]?.role || '').trim().toLowerCase();
    const content = String(list[i]?.content || list[i]?.text || '').trim();
    if (role === 'user' && content) return content;
  }
  return '';
}

/** True when text is mostly Cyrillic (not allowed in draftPatch / chip value). */
export function isMostlyNonEnglishDraftText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const cyr = (raw.match(/[а-яё]/gi) || []).length;
  const lat = (raw.match(/[a-z]/gi) || []).length;
  return cyr >= 3 && cyr >= lat;
}

/** Sections/lines that would be dropped by thinNormalize for non-English text. */
export function collectNonEnglishDraftDrops(draftPatch) {
  const patch = draftPatch && typeof draftPatch === 'object' ? draftPatch : {};
  const dropped = [];
  for (const key of ['title', 'task']) {
    if (patch[key] == null) continue;
    const text =
      typeof patch[key] === 'string'
        ? patch[key]
        : String(patch[key]?.text || '');
    if (isMostlyNonEnglishDraftText(text)) {
      dropped.push({ section: key, text: String(text).trim().slice(0, 240) });
    }
  }
  for (const key of ['deliverables', 'acceptance', 'proof', 'outOfScope']) {
    if (!Array.isArray(patch[key])) continue;
    for (const line of patch[key]) {
      const text = typeof line === 'string' ? line : String(line?.text || '');
      if (isMostlyNonEnglishDraftText(text)) {
        dropped.push({ section: key, text: String(text).trim().slice(0, 240) });
      }
    }
  }
  return dropped;
}

export function shouldRetryEnglishDraft(output) {
  if (!output || output.mode !== 'draft') return false;
  const drops = Array.isArray(output.debug?.nonEnglishDraftDrops)
    ? output.debug.nonEnglishDraftDrops
    : [];
  if (!drops.length) return false;
  const patch = output.draftPatch && typeof output.draftPatch === 'object' ? output.draftPatch : {};
  const taskDropped = drops.some((drop) => drop?.section === 'task');
  if (taskDropped && !patch.task) return true;
  // Chip values were Cyrillic-only and contour stripped them while gaps remain.
  const chips = Array.isArray(output.followUpChips) ? output.followUpChips : [];
  const chipValuesDropped = Boolean(output.debug?.nonEnglishChipValuesDropped);
  if (chipValuesDropped && chips.length === 0) return true;
  return false;
}

function buildEnglishDraftRetryCorrection(drops) {
  const list = Array.isArray(drops) ? drops : [];
  const samples = list
    .slice(0, 4)
    .map((drop) => `- ${drop.section}: ${drop.text}`)
    .join('\n');
  return [
    'CORRECTION: previous JSON put non-English (Cyrillic) text into draftPatch and/or chip values.',
    'Left draft lines + chip values MUST be English ONLY. Translate the same facts — do not invent new obligations.',
    'Product language may remain Russian inside an English sentence (e.g. "Write a short Telegram guide in Russian…").',
    'Chip labels may stay in owner language; chip values must be English draft lines.',
    samples ? `Dropped samples:\n${samples}` : '',
    'Keep mode "draft". Return ONLY the corrected JSON object.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildEnglishDraftRejectAck(ownerText) {
  if (ownerUsesCyrillic(ownerText)) {
    return 'Task не принял: в draft нужен English (перевод брифа). Переформулируй или отправь ещё раз.';
  }
  return 'Task was not accepted: draft lines must be English. Rephrase or send again.';
}

/** Prefer retry English task/lines/chips when primary lost them to the language gate. */
export function mergeEnglishRetryTurn(primary, retry) {
  const a = primary && typeof primary === 'object' ? primary : {};
  const b = retry && typeof retry === 'object' ? retry : {};
  const patchA = a.draftPatch && typeof a.draftPatch === 'object' ? a.draftPatch : {};
  const patchB = b.draftPatch && typeof b.draftPatch === 'object' ? b.draftPatch : {};
  const draftPatch = { ...patchA };
  if (patchB.title && !patchA.title) draftPatch.title = patchB.title;
  if (patchB.task && !patchA.task) draftPatch.task = patchB.task;
  if (patchB.classification && !patchA.classification) draftPatch.classification = patchB.classification;
  for (const key of CONTENT_GAP_KEYS) {
    const merged = mergeProvenancedLists(patchA[key], patchB[key]);
    if (merged?.length) draftPatch[key] = merged;
    else delete draftPatch[key];
  }
  if (Array.isArray(patchB.gaps) && patchB.gaps.length) {
    draftPatch.gaps = patchB.gaps;
  } else if (Array.isArray(patchA.gaps) && patchA.gaps.length) {
    draftPatch.gaps = patchA.gaps;
  }
  const chipsA = Array.isArray(a.followUpChips) ? a.followUpChips : [];
  const chipsB = Array.isArray(b.followUpChips) ? b.followUpChips : [];
  const followUpChips = chipsB.length ? chipsB : chipsA;
  return {
    ...a,
    mode: 'draft',
    draftPatch,
    followUpChips,
    debug: {
      ...(a.debug && typeof a.debug === 'object' ? a.debug : {}),
      ...(b.debug && typeof b.debug === 'object' ? b.debug : {}),
      englishDraftRetry: true,
    },
  };
}

/** Thin normalize: drop schema placeholders and non-English draft lines; keep provenanced EN lines. */
export function thinNormalizeComposerDraftPatch(draftPatch) {
  const patch = { ...(draftPatch && typeof draftPatch === 'object' ? draftPatch : {}) };
  for (const key of ['title', 'task']) {
    if (patch[key] == null) continue;
    if (typeof patch[key] === 'string') {
      if (isSchemaPlaceholder(patch[key]) || isMostlyNonEnglishDraftText(patch[key])) delete patch[key];
    } else if (typeof patch[key] === 'object') {
      const text = String(patch[key].text || '').trim();
      const ids = Array.isArray(patch[key].sourceFactIds) ? patch[key].sourceFactIds : [];
      if (!text || isSchemaPlaceholder(text) || !ids.length || isMostlyNonEnglishDraftText(text)) {
        delete patch[key];
      }
    } else {
      delete patch[key];
    }
  }
  for (const key of ['deliverables', 'acceptance', 'proof', 'outOfScope']) {
    if (!Array.isArray(patch[key])) {
      if (patch[key] == null) delete patch[key];
      continue;
    }
    patch[key] = patch[key]
      .map((line) => {
        if (typeof line === 'string') return null;
        if (!line || typeof line !== 'object') return null;
        const text = String(line.text || '').trim();
        const sourceFactIds = Array.isArray(line.sourceFactIds)
          ? line.sourceFactIds.map((id) => String(id || '').trim()).filter(Boolean)
          : [];
        if (
          !text
          || isSchemaPlaceholder(text)
          || !sourceFactIds.length
          || isMostlyNonEnglishDraftText(text)
        ) {
          return null;
        }
        return { text, sourceFactIds };
      })
      .filter(Boolean);
    if (!patch[key].length) delete patch[key];
  }
  if (patch.classification && typeof patch.classification === 'object') {
    const classification = { ...patch.classification };
    if (isSchemaPlaceholder(classification.domainId)) delete classification.domainId;
    if (isSchemaPlaceholder(classification.subcategoryId)) classification.subcategoryId = null;
    if (!classification.domainId) {
      delete patch.classification;
    } else {
      patch.classification = classification;
    }
  }
  if (patch.art && typeof patch.art === 'object') {
    patch.art = {
      title: asCleanString(patch.art.title) || undefined,
      theme: asCleanString(patch.art.theme) || undefined,
      primaryColor: asCleanString(patch.art.primaryColor || patch.art.primary_color) || undefined,
      accentColor: asCleanString(patch.art.accentColor || patch.art.accent_color) || undefined,
      creativePrompt: asCleanString(patch.art.creativePrompt || patch.art.creative_prompt || patch.art.prompt) || undefined,
    };
  }
  return patch;
}

/** Drop non-English draft lines (contract: left draft = English). */
export function englishOnlyDraftPatch(draftPatch) {
  return thinNormalizeComposerDraftPatch(draftPatch);
}

/** Alias for older callers — same as thinNormalize (no soft-meta / greeting wipe). */
export function finalizeComposerDraftPatch(draftPatch, _latestUserMessage = '', _opts = {}) {
  return thinNormalizeComposerDraftPatch(draftPatch);
}

/** Pass-through — do not rewrite LLM assistant text. */
export function sanitizeComposerAssistantMessage(assistantMessage, _latestUserMessage = '', _context = {}) {
  const text = String(assistantMessage || '').trim();
  if (!text || text === '__composer_needs_ack__') return '';
  return text;
}

export function extractArtDirectiveFromOutput(rawOutput) {
  const patch = rawOutput?.draftPatch;
  if (!patch?.art || typeof patch.art !== 'object') return null;
  return {
    title: String(patch.art.title || patch.title?.text || '').trim() || null,
    theme: String(patch.art.theme || 'custom').trim(),
    primaryColor: String(patch.art.primaryColor || patch.art.primary_color || '#00F0FF').trim(),
    accentColor: String(patch.art.accentColor || patch.art.accent_color || '#7000FF').trim(),
    creativePrompt: String(patch.art.creativePrompt || patch.art.creative_prompt || '').trim(),
  };
}

export function buildComposerLlmUserPayload(input) {
  const messages = input?.messages || [];
  const latestUserMessage = resolveLatestUserMessage(messages);

  if (input?.hints?.workspace === 'ai_glyphs') {
    return JSON.stringify(
      {
        latestUserMessage,
        messages,
        hints: input.hints || { workspace: 'ai_glyphs' },
      },
      null,
      2,
    );
  }

  return JSON.stringify(
    {
      latestUserMessage,
      facts: Array.isArray(input.facts) ? input.facts : [],
      confirmed: input.confirmed || null,
      sectionDraft: input.sectionDraft || EMPTY_DRAFT,
      validation: input.validation || null,
      hints: input.hints || null,
      messages,
      constraints: {
        factsOnly: true,
        requireSourceFactIds: true,
        unknownToNullOrGap: true,
        noNewObligationsBeyondFacts: true,
        completenessProposalsViaChipsOk: true,
        chatAndChipLabelsMatchFirstOwnerLanguage: true,
        leftDraftAndChipValuesEnglishOnly: true,
        applyCopiesEnglishDraftAsIs: true,
        classificationCatalogIdsOnly: true,
        noEchoContextKeys: true,
        requireFollowUpChipsForOpenGaps: true,
        chipSelection: input.hints?.chipSelection || null,
      },
    },
    null,
    2,
  );
}

/**
 * Recover when local models echo sectionDraft instead of draftPatch.
 */
export function coerceComposerLlmRawObject(rawObject) {
  if (!rawObject || typeof rawObject !== 'object' || Array.isArray(rawObject)) {
    return rawObject;
  }

  const hasDraftPatch =
    (rawObject.draftPatch && typeof rawObject.draftPatch === 'object')
    || (rawObject.draft_patch && typeof rawObject.draft_patch === 'object');
  const echoedDraft =
    rawObject.sectionDraft && typeof rawObject.sectionDraft === 'object'
      ? rawObject.sectionDraft
      : rawObject.section_draft && typeof rawObject.section_draft === 'object'
        ? rawObject.section_draft
        : null;

  const draftPatch = hasDraftPatch
    ? (rawObject.draftPatch || rawObject.draft_patch)
    : echoedDraft || {};

  let assistantMessage = String(
    rawObject.assistantMessage
      || rawObject.assistant_message
      || rawObject.message
      || rawObject.reply
      || '',
  ).trim();

  const followUpChips = Array.isArray(rawObject.followUpChips || rawObject.follow_up_chips)
    ? (rawObject.followUpChips || rawObject.follow_up_chips)
    : [];

  if (!assistantMessage) {
    // Leave empty — parseComposerLlmRawResponse builds an honest owner-language ack.
    assistantMessage = '';
  }

  return {
    ...rawObject,
    assistantMessage,
    draftPatch: draftPatch && typeof draftPatch === 'object' ? draftPatch : {},
    followUpChips,
    debug: {
      ...(rawObject.debug && typeof rawObject.debug === 'object' ? rawObject.debug : {}),
      ...(echoedDraft && !hasDraftPatch ? { recoveredFromSectionDraftEcho: true } : {}),
      ...(!String(rawObject.assistantMessage || rawObject.assistant_message || '').trim()
        ? { synthesizedAssistantMessage: true }
        : {}),
    },
  };
}

function resolveModeFromInput(llmMode, facts, preferredMode, hasPatchContent = false) {
  if (preferredMode === 'guidance') return 'guidance';
  if (preferredMode === 'draft') return 'draft';
  const userChars = hireableUserFactChars(facts);
  if (userChars >= 80) return 'draft';
  const llm = String(llmMode || '').trim().toLowerCase();
  if (llm === 'guidance') return 'guidance';
  if (llm === 'draft') return 'draft';
  // Model omitted mode but returned a patch — treat as draft when any hireable user facts exist.
  if (hasPatchContent && userChars > 0) return 'draft';
  return 'guidance';
}

/** Help-me / thin stub — steers guidance; does not count as hireable brief content.
 * A message that actually describes work is not a stub — one steering word must not void it. */
function isGuidanceSteeringText(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.length > GUIDANCE_STEERING_STUB_MAX_CHARS) return false;
  return /помог[аиуе]?|help\s+me|не\s+уверен|not\s+sure|сформулир|formulate|что\s+именно\s+(нанимать|вписать|писать)|how\s+to\s+(write|shape|hire)/i.test(
    t,
  );
}

function hireableUserFactChars(facts) {
  return (Array.isArray(facts) ? facts : [])
    .filter((fact) => String(fact?.source || '') === 'user_message')
    .filter((fact) => !isGuidanceSteeringText(fact?.text))
    .reduce((sum, fact) => sum + String(fact?.text || '').trim().length, 0);
}

export function normalizeComposerLlmTurnOutput(rawObject, options = {}) {
  if (!rawObject || typeof rawObject !== 'object') {
    const err = new Error('Composer LLM returned non-object JSON');
    err.code = 'composer_llm_invalid_json';
    throw err;
  }

  const facts = Array.isArray(options.facts) ? options.facts : [];
  const allowedFactIds = allowedFactIdSet(facts);
  const defaultFactIds = facts.map((fact) => String(fact?.id || '').trim()).filter(Boolean);
  const preferredMode = String(options.preferredMode || options.hints?.preferredMode || '')
    .trim()
    .toLowerCase();
  const coerced = coerceComposerLlmRawObject(rawObject);
  // Empty message is OK — parse rebuilds honest owner-language ack. Do not invent EN stubs here.
  const assistantMessage =
    String(coerced.assistantMessage || '').trim() || '__composer_needs_ack__';

  const patchIn = coerced.draftPatch || {};
  const hasPatchContent = Boolean(
    patchIn.title
      || patchIn.task
      || (Array.isArray(patchIn.deliverables) && patchIn.deliverables.length)
      || (Array.isArray(patchIn.acceptance) && patchIn.acceptance.length)
      || (Array.isArray(patchIn.proof) && patchIn.proof.length)
      || (Array.isArray(patchIn.outOfScope) && patchIn.outOfScope.length)
      || patchIn.classification,
  );
  const mode = resolveModeFromInput(
    coerced.mode || coerced.composerMode,
    facts,
    preferredMode,
    hasPatchContent,
  );
  // In draft mode, bare strings may cite the full fact set (weak local models omit sourceFactIds).
  const coerceDefaults = mode === 'draft' && defaultFactIds.length ? defaultFactIds : null;

  const draftPatch = {};
  const title = asProvenancedSuggestion(patchIn.title, allowedFactIds, coerceDefaults);
  if (title) draftPatch.title = title;
  const task = asProvenancedSuggestion(patchIn.task, allowedFactIds, coerceDefaults);
  if (task) draftPatch.task = task;
  for (const key of ['deliverables', 'acceptance', 'proof', 'outOfScope']) {
    const list = asProvenancedSuggestionList(patchIn[key], allowedFactIds, coerceDefaults);
    if (list && list.length) draftPatch[key] = list;
  }

  const artIn = patchIn.art || coerced.art;
  if (artIn && typeof artIn === 'object') {
    draftPatch.art = {
      title: asCleanString(artIn.title || patchIn.title?.text || patchIn.title) || undefined,
      theme: asCleanString(artIn.theme) || undefined,
      primaryColor: asCleanString(artIn.primaryColor || artIn.primary_color) || undefined,
      accentColor: asCleanString(artIn.accentColor || artIn.accent_color) || undefined,
      creativePrompt: asCleanString(artIn.creativePrompt || artIn.creative_prompt || artIn.prompt) || undefined,
    };
  } else if (patchIn.creativePrompt || patchIn.creative_prompt) {
    draftPatch.art = {
      title: asCleanString(patchIn.title?.text || patchIn.title) || undefined,
      theme: asCleanString(patchIn.theme) || undefined,
      primaryColor: asCleanString(patchIn.primaryColor || patchIn.primary_color) || undefined,
      accentColor: asCleanString(patchIn.accentColor || patchIn.accent_color) || undefined,
      creativePrompt: asCleanString(patchIn.creativePrompt || patchIn.creative_prompt) || undefined,
    };
  }

  if (Array.isArray(patchIn.gaps)) {
    const gaps = patchIn.gaps
      .map((gap) => {
        const section = String(gap?.section || '').trim();
        const reason = String(gap?.reason || '').trim();
        if (!CHIP_SECTIONS.has(section) && section !== 'task') return null;
        if (!reason) return null;
        return { section, reason };
      })
      .filter(Boolean)
      .slice(0, 8);
    if (gaps.length) draftPatch.gaps = gaps;
  }

  const classificationIn = patchIn.classification || patchIn.Classification;
  if (classificationIn && typeof classificationIn === 'object' && !Array.isArray(classificationIn)) {
    const domainId = asCleanString(
      classificationIn.domainId
        || classificationIn.domain_id
        || classificationIn.domain
        || classificationIn.category,
    );
    const rawSubNull =
      classificationIn.subcategoryId === null || classificationIn.subcategory_id === null;
    const rawSub = rawSubNull
      ? null
      : asCleanString(
          classificationIn.subcategoryId
            || classificationIn.subcategory_id
            || classificationIn.subcategory,
        );
    const confidenceRaw = Number(classificationIn.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : undefined;
    if (domainId) {
      draftPatch.classification = {
        domainId,
        subcategoryId: rawSub,
        ...(asCleanString(classificationIn.typeId || classificationIn.type_id || classificationIn.type)
          ? {
              typeId: asCleanString(
                classificationIn.typeId || classificationIn.type_id || classificationIn.type,
              ),
            }
          : {}),
        ...(asCleanString(
          classificationIn.difficultyId || classificationIn.difficulty_id || classificationIn.difficulty,
        )
          ? {
              difficultyId: asCleanString(
                classificationIn.difficultyId
                  || classificationIn.difficulty_id
                  || classificationIn.difficulty,
              ),
            }
          : {}),
        ...(asStringArray(
          classificationIn.tagIds || classificationIn.tag_ids || classificationIn.tags,
        )
          ? {
              tagIds: asStringArray(
                classificationIn.tagIds || classificationIn.tag_ids || classificationIn.tags,
              ),
            }
          : {}),
        ...(asStringArray(
          classificationIn.platformIds || classificationIn.platform_ids || classificationIn.platforms,
        )
          ? {
              platformIds: asStringArray(
                classificationIn.platformIds
                  || classificationIn.platform_ids
                  || classificationIn.platforms,
              ),
            }
          : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      };
    }
  }

  const followUpChips = Array.isArray(coerced.followUpChips || coerced.follow_up_chips)
    ? (coerced.followUpChips || coerced.follow_up_chips)
        .map((chip) => {
          const label = String(chip?.label || chip || '').trim();
          const value = String(chip?.value || '').trim();
          const section = String(chip?.section || '').trim();
          // Guidance chips are direction/fact asks — labels only, no invent values into draft.
          if (mode === 'guidance') {
            return { label };
          }
          return {
            label,
            ...(value ? { value } : {}),
            ...(CHIP_SECTIONS.has(section) ? { section } : {}),
          };
        })
        .filter((chip) => chip.label && !isSchemaPlaceholder(chip.label) && !isSchemaPlaceholder(chip.value || chip.label))
        .slice(0, 6)
    : [];

  // Contract: guidance = chips/asks only — never ship draft fills or taxonomy.
  if (mode === 'guidance') {
    const gaps = Array.isArray(draftPatch.gaps) ? draftPatch.gaps : undefined;
    for (const key of Object.keys(draftPatch)) {
      delete draftPatch[key];
    }
    if (gaps?.length) draftPatch.gaps = gaps;
  }

  return {
    mode,
    assistantMessage,
    draftPatch,
    followUpChips,
    debug: coerced.debug && typeof coerced.debug === 'object' ? coerced.debug : undefined,
  };
}

function normalizeEchoText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ownerUsesCyrillic(text) {
  return /[а-яё]/i.test(String(text || ''));
}

/** Contour: chat must match first-owner language (RU owner → Cyrillic assistant). */
function assistantWrongLanguage(assistantMessage, ownerText) {
  if (!ownerUsesCyrillic(ownerText)) return false;
  const assistant = String(assistantMessage || '');
  const cyr = (assistant.match(/[а-яё]/gi) || []).length;
  const lat = (assistant.match(/[a-z]/gi) || []).length;
  if (lat < 12) return false;
  return cyr < 3;
}

/** Strong consulting cue — do NOT use bare "нужн" (matches owner briefs like "Нужно …"). */
const CONSULTANT_CUE =
  /в draft|confirm|chip|секци|принял|приняла|принят|осталось|осталось уточн|пробел|выбер(и|ите)|слева|locked your|captured the brief|check the sections/i;

/** True when the model pasted or retold the owner brief as assistantMessage. */
function assistantMessageEchoesOwner(assistantMessage, ownerText) {
  const assistant = normalizeEchoText(assistantMessage);
  const owner = normalizeEchoText(ownerText);
  if (!assistant || !owner || owner.length < 24) return false;
  if (assistant === owner) return true;
  if (assistant.includes(owner) || owner.includes(assistant)) return true;
  if (owner.length >= 80 && assistant.slice(0, 80) === owner.slice(0, 80)) return true;
  // Cross-language retell: RU brief → long EN "translation" with no consulting move.
  if (ownerUsesCyrillic(ownerText) && assistantWrongLanguage(assistantMessage, ownerText)) {
    if (assistant.length >= 60 && !CONSULTANT_CUE.test(assistantMessage)) return true;
  }
  // Same-language paraphrase retell.
  if (assistant.length >= Math.max(60, owner.length * 0.55)) {
    const ownerWords = owner.split(' ').filter((w) => w.length > 4);
    if (ownerWords.length >= 5) {
      const hit = ownerWords.filter((w) => assistant.includes(w)).length;
      const overlap = hit / ownerWords.length;
      if (overlap >= 0.35 && !CONSULTANT_CUE.test(assistantMessage)) return true;
    }
  }
  // Same-language soft paraphrase: long reply overlapping owner words, no consulting cue.
  // (Do not use bare "нужн" as a cue — it matches owner briefs like "Нужно …".)
  if (
    assistant.length >= 80
    && !CONSULTANT_CUE.test(assistantMessage)
    && ownerUsesCyrillic(ownerText) === ownerUsesCyrillic(assistantMessage)
  ) {
    const ownerWords = owner.split(' ').filter((w) => w.length > 4);
    if (ownerWords.length >= 5) {
      const hit = ownerWords.filter((w) => assistant.includes(w)).length;
      if (hit / ownerWords.length >= 0.25) return true;
    }
  }
  return false;
}

/** Retell of latest OR any earlier substantial owner message in the thread. */
function assistantEchoesAnyOwnerBrief(assistantMessage, messages, latestUserMessage) {
  if (assistantMessageEchoesOwner(assistantMessage, latestUserMessage)) return true;
  const list = Array.isArray(messages) ? messages : [];
  for (const item of list) {
    const role = String(item?.role || '').trim().toLowerCase();
    const content = String(item?.content || item?.text || '').trim();
    if (role !== 'user' || content.length < 40) continue;
    if (content === latestUserMessage) continue;
    if (assistantMessageEchoesOwner(assistantMessage, content)) return true;
  }
  return false;
}

const GAP_SECTION_LABEL_RU = {
  deliverables: 'Сдаваемое',
  acceptance: 'Приёмка',
  proof: 'Доказательство',
  outOfScope: 'Вне скоупа',
};

const CONTENT_GAP_KEYS = ['deliverables', 'acceptance', 'proof'];

function sectionHasLines(value) {
  if (!Array.isArray(value) || !value.length) return false;
  return value.some((item) => {
    if (typeof item === 'string') return Boolean(item.trim());
    if (item && typeof item === 'object') {
      return Boolean(String(item.text || item.value || '').trim());
    }
    return false;
  });
}

/** Open deliverables/acceptance/proof after merging patch into sectionDraft. */
export function resolveOpenContentGaps(draftPatch, sectionDraft) {
  const patch = draftPatch && typeof draftPatch === 'object' ? draftPatch : {};
  const existing = sectionDraft && typeof sectionDraft === 'object' ? sectionDraft : {};
  return CONTENT_GAP_KEYS.filter(
    (key) => !sectionHasLines(patch[key]) && !sectionHasLines(existing[key]),
  );
}

function expectsDraftMode(input) {
  const preferred = String(input?.hints?.preferredMode || input?.preferredMode || '')
    .trim()
    .toLowerCase();
  if (preferred === 'guidance') return false;
  if (preferred === 'draft') return true;
  return hireableUserFactChars(input?.facts) >= 80;
}

function hintsOpenGaps(input) {
  const gaps = input?.hints?.openGaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.map((gap) => String(gap || '').trim()).filter((gap) => CONTENT_GAP_KEYS.includes(gap));
}

/** Draft-mode nudge when client reports open gaps — reinforce 7b/7c. */
export function buildOpenGapsNudge(openGaps) {
  const gaps = Array.isArray(openGaps) ? openGaps.filter(Boolean) : [];
  if (!gaps.length) return '';
  return [
    `OPEN GAPS (${gaps.join(', ')}): do not stop after task+classification.`,
    'Extract concrete work products from facts into deliverables[] with sourceFactIds when named.',
    'For remaining open gaps (especially acceptance/proof), return 1-3 followUpChips that close reviewability holes: concrete proposals with label (owner language) + value (English draft line) + section.',
    'Section targeting: format/size/package → deliverables; tone/style/quality → acceptance; submission evidence → proof.',
    'Completeness proposals on chips are encouraged (format, size e.g. 512x512, zip, screenshots, style match) even if absent from facts. Do NOT write those into draftPatch until Confirm.',
  ].join(' ');
}

function buildGapRetryCorrection(openGaps) {
  const gaps = Array.isArray(openGaps) ? openGaps.filter(Boolean) : [];
  const needChips = gaps.filter((gap) => gap === 'acceptance' || gap === 'proof' || gap === 'deliverables');
  return [
    'CORRECTION: previous JSON omitted usable followUpChips (questions do not count) and/or deliverables extraction while gaps remain open.',
    gaps.length ? `Still open: ${gaps.join(', ')}.` : '',
    needChips.length
      ? `REQUIRED: 1-3 followUpChips with section in [${needChips.join(', ')}]. Each chip MUST include a non-question label AND an English value (draft line on Confirm). Completeness proposals OK — put format/size on deliverables (e.g. "All icons delivered as PNG 512x512"), tone/quality on acceptance, submission evidence on proof. Never What/How/Do you / "?". Never put those lines into draftPatch — only followUpChips.`
      : '',
    'Extract grounded deliverables with sourceFactIds when facts name artifacts.',
    'Do NOT invent acceptance/proof into draftPatch. Keep mode "draft". Return ONLY the corrected JSON object.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** True when draft turn left gaps open and shipped no chips — one LLM retry allowed. */
export function shouldRetryGapProposals(output, input) {
  if (!output || output.mode !== 'draft') return false;
  const chips = Array.isArray(output.followUpChips) ? output.followUpChips : [];
  if (chips.length > 0) return false;
  return resolveOpenContentGaps(output.draftPatch, input?.sectionDraft).length > 0;
}

function mergeProvenancedLists(primaryList, retryList) {
  const primary = Array.isArray(primaryList) ? primaryList : [];
  const retry = Array.isArray(retryList) ? retryList : [];
  if (!retry.length) return primary.length ? primary : undefined;
  if (!primary.length) return retry;
  const seen = new Set(primary.map((line) => String(line?.text || '').trim().toLowerCase()).filter(Boolean));
  const merged = [...primary];
  for (const line of retry) {
    const text = String(line?.text || '').trim();
    if (!text || !Array.isArray(line?.sourceFactIds) || !line.sourceFactIds.length) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged;
}

/** Prefer retry chips; merge grounded deliverables; keep primary task/classification unless retry adds. */
export function mergeGapRetryTurn(primary, retry) {
  const a = primary && typeof primary === 'object' ? primary : {};
  const b = retry && typeof retry === 'object' ? retry : {};
  const patchA = a.draftPatch && typeof a.draftPatch === 'object' ? a.draftPatch : {};
  const patchB = b.draftPatch && typeof b.draftPatch === 'object' ? b.draftPatch : {};
  const draftPatch = { ...patchA };
  if (patchB.title && !patchA.title) draftPatch.title = patchB.title;
  if (patchB.task && !patchA.task) draftPatch.task = patchB.task;
  if (patchB.classification && !patchA.classification) draftPatch.classification = patchB.classification;
  for (const key of CONTENT_GAP_KEYS) {
    const merged = mergeProvenancedLists(patchA[key], patchB[key]);
    if (merged?.length) draftPatch[key] = merged;
    else delete draftPatch[key];
  }
  if (Array.isArray(patchB.gaps) && patchB.gaps.length) {
    draftPatch.gaps = patchB.gaps;
  } else if (Array.isArray(patchA.gaps) && patchA.gaps.length) {
    draftPatch.gaps = patchA.gaps;
  }
  const chipsA = Array.isArray(a.followUpChips) ? a.followUpChips : [];
  const chipsB = Array.isArray(b.followUpChips) ? b.followUpChips : [];
  const followUpChips = chipsB.length ? chipsB : chipsA;
  return {
    ...a,
    mode: 'draft',
    draftPatch,
    followUpChips,
    debug: {
      ...(a.debug && typeof a.debug === 'object' ? a.debug : {}),
      ...(b.debug && typeof b.debug === 'object' ? b.debug : {}),
      gapProposalRetry: true,
    },
  };
}

/** Honest ack from what actually shipped — never promise chips that are absent. */
export function buildHonestAssistantAck(ownerText, draftPatch, followUpChips) {
  const ru = ownerUsesCyrillic(ownerText);
  const patch = draftPatch && typeof draftPatch === 'object' ? draftPatch : {};
  const chips = Array.isArray(followUpChips) ? followUpChips : [];
  const filled = [];
  if (patch.task) filled.push('Task');
  if (Array.isArray(patch.deliverables) && patch.deliverables.length) filled.push('Deliverables');
  if (Array.isArray(patch.acceptance) && patch.acceptance.length) filled.push('Acceptance');
  if (Array.isArray(patch.proof) && patch.proof.length) filled.push('Proof');
  if (patch.classification) filled.push('Classification');
  const empty = ['Deliverables', 'Acceptance', 'Proof'].filter((name) => {
    const key = name.toLowerCase();
    return !(Array.isArray(patch[key]) && patch[key].length);
  });

  if (ru) {
    if (!filled.length) {
      return chips.length
        ? 'Пока без заполнения слева — выбери варианты ниже, чтобы собрать факты.'
        : 'Принял сообщение. Слева пока пусто — допиши бриф или уточни в чате.';
    }
    const head = `Принял в draft: ${filled.join(', ')}.`;
    if (empty.length && chips.length) {
      return `${head} Ещё пусто: ${empty.join(', ')} — выбери варианты ниже или допиши слева.`;
    }
    if (empty.length) {
      return `${head} Ещё пусто: ${empty.join(', ')} — допиши слева или уточни в чате.`;
    }
    return chips.length
      ? `${head} Проверь proposals слева; варианты ниже — если нужно уточнить.`
      : `${head} Проверь proposals слева и Lock.`;
  }

  if (!filled.length) {
    return chips.length
      ? 'Nothing on the left yet — pick options below to collect facts.'
      : 'Got it. Left draft is still empty — add detail in chat or write on the left.';
  }
  const head = `Captured into draft: ${filled.join(', ')}.`;
  if (empty.length && chips.length) {
    return `${head} Still empty: ${empty.join(', ')} — use options below or fill the left.`;
  }
  if (empty.length) {
    return `${head} Still empty: ${empty.join(', ')} — fill the left or clarify in chat.`;
  }
  return chips.length
    ? `${head} Review proposals on the left; options below if you need to refine.`
    : `${head} Review proposals on the left and Lock.`;
}

function sectionDraftHasConfirmed(sectionDraft, key) {
  const draft = sectionDraft && typeof sectionDraft === 'object' ? sectionDraft : {};
  if (key === 'task') {
    const task = draft.task;
    if (!task) return false;
    if (typeof task === 'string') return Boolean(task.trim());
    return String(task.status || '').toLowerCase() === 'confirmed' && Boolean(String(task.text || '').trim());
  }
  if (key === 'classification') {
    const c = draft.classification;
    return Boolean(c && String(c.status || '').toLowerCase() === 'confirmed' && c.domainId);
  }
  const list = draft[key];
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((line) => {
    if (typeof line === 'string') return Boolean(line.trim());
    return String(line?.status || '').toLowerCase() === 'confirmed' && Boolean(String(line?.text || '').trim());
  });
}

function sectionDraftHasContent(sectionDraft, key) {
  const draft = sectionDraft && typeof sectionDraft === 'object' ? sectionDraft : {};
  if (key === 'task') {
    const task = draft.task;
    if (!task) return false;
    if (typeof task === 'string') return Boolean(task.trim());
    return Boolean(String(task.text || '').trim());
  }
  if (key === 'classification') {
    const c = draft.classification;
    return Boolean(c && c.domainId);
  }
  const list = draft[key];
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((line) => {
    if (typeof line === 'string') return Boolean(line.trim());
    return Boolean(String(line?.text || '').trim());
  });
}

/** After operator Confirmed chips — acknowledge locks; point to Lock, gaps, or Apply. */
export function buildChipContinuationAck(ownerText, sectionDraft, draftPatch, followUpChips) {
  const ru = ownerUsesCyrillic(ownerText);
  const chips = Array.isArray(followUpChips) ? followUpChips : [];
  const locked = ['Acceptance', 'Proof', 'Deliverables'].filter((name) =>
    sectionDraftHasConfirmed(sectionDraft, name.toLowerCase()),
  );
  const stillOpen = ['Deliverables', 'Acceptance', 'Proof'].filter(
    (name) => !sectionDraftHasContent(sectionDraft, name.toLowerCase()),
  );
  const pendingLock = ['Task', 'Deliverables', 'Acceptance', 'Proof', 'Classification'].filter((name) => {
    const key = name.toLowerCase();
    return sectionDraftHasContent(sectionDraft, key) && !sectionDraftHasConfirmed(sectionDraft, key);
  });
  const ready =
    sectionDraftHasConfirmed(sectionDraft, 'task')
    && ['deliverables', 'acceptance', 'proof'].every((key) => sectionDraftHasConfirmed(sectionDraft, key))
    && sectionDraftHasConfirmed(sectionDraft, 'classification');

  if (ru) {
    if (locked.length && stillOpen.length && chips.length) {
      return `Принял в draft: ${locked.join(', ')}. Ещё пусто: ${stillOpen.join(', ')} — выбери варианты ниже или допиши слева.`;
    }
    if (locked.length && stillOpen.length) {
      return `Принял в draft: ${locked.join(', ')}. Ещё пусто: ${stillOpen.join(', ')} — допиши слева или уточни в чате.`;
    }
    if (ready) {
      return locked.length
        ? `Принял: ${locked.join(', ')}. Контракт готов — можно нажать Apply to classic form.`
        : 'Контракт готов — можно нажать Apply to classic form.';
    }
    if (locked.length && pendingLock.length) {
      return `Принял: ${locked.join(', ')}. Осталось закрепить слева: ${pendingLock.join(', ')} (или Lock all).`;
    }
    if (locked.length) {
      return `Принял: ${locked.join(', ')}. Проверь предложения слева и нажми Lock.`;
    }
    return buildHonestAssistantAck(ownerText, draftPatch, followUpChips);
  }

  if (locked.length && stillOpen.length && chips.length) {
    return `Locked into draft: ${locked.join(', ')}. Still empty: ${stillOpen.join(', ')} — use options below or fill the left.`;
  }
  if (locked.length && stillOpen.length) {
    return `Locked into draft: ${locked.join(', ')}. Still empty: ${stillOpen.join(', ')} — fill the left or clarify in chat.`;
  }
  if (ready) {
    return locked.length
      ? `Locked: ${locked.join(', ')}. Everything is locked — you can Apply to classic form.`
      : 'Everything is locked — you can Apply to classic form.';
  }
  if (locked.length && pendingLock.length) {
    return `Locked: ${locked.join(', ')}. Still need Lock on the left: ${pendingLock.join(', ')} (or Lock all).`;
  }
  if (locked.length) {
    return `Locked: ${locked.join(', ')}. Review proposals on the left and Lock.`;
  }
  return buildHonestAssistantAck(ownerText, draftPatch, followUpChips);
}

/** EN stubs / vague clarifies that must never ship to a RU (or any) owner as the main ack. */
export function isWeakConsultantAck(assistantMessage) {
  const msg = String(assistantMessage || '').trim();
  if (!msg || msg === '__composer_needs_ack__') return true;
  if (/^(draft updated|check the sections)/i.test(msg)) return true;
  if (/what about/i.test(msg)) return true;
  if (/can we clarify/i.test(msg)) return true;
  if (/what should we clarify/i.test(msg)) return true;
  if (/still needed:/i.test(msg) && /\?$/.test(msg)) return true;
  return false;
}

/**
 * True when label/value is an open question — not a Confirm-able proposal.
 */
export function isQuestionChipText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/\?/.test(raw)) return true;
  return /^(what|how|where|when|which|why|do you|does |did |can you|could you|should i|would you|какой|какая|какие|каким|как |где |когда |зачем |нужно ли|надо ли)\b/i.test(
    raw,
  );
}

/**
 * Keep chips usable as Confirm-able proposals.
 * Drop questions / Add-prompts. RU owner + EN-only label → RU shell + full EN body (no ellipsis).
 * Draft gap chips with section need an English value (proposal line).
 * Drop stacked transparency contradictions in one turn.
 */
export function filterContourChips(followUpChips, ownerText) {
  const list = Array.isArray(followUpChips) ? followUpChips : [];
  const ownerRu = ownerUsesCyrillic(ownerText);
  const mapped = list
    .map((chip) => {
      if (!chip || typeof chip !== 'object') return null;
      let label = String(chip.label || '').trim();
      let value = String(chip.value || '').trim();
      const section = String(chip.section || '').trim();
      if (!label || label.length < 3) return null;
      if (isQuestionChipText(label) || isQuestionChipText(value)) return null;
      if (
        /^(add|require|request|specify|define|указать|добавить|требуй)\b/i.test(label)
      ) {
        return null;
      }
      // Section chips must be lockable proposals: English value required (or EN label as value).
      if (CHIP_SECTIONS.has(section)) {
        if (!value) {
          const labelIsEnOnly = !/[а-яё]/i.test(label) && /[a-z]/i.test(label);
          if (labelIsEnOnly) value = label;
        }
        if (!value || isQuestionChipText(value) || /[а-яё]/i.test(value)) return null;
      }
      const labelIsEnOnly = !/[а-яё]/i.test(label) && /[a-z]/i.test(label);
      if (ownerRu && labelIsEnOnly) {
        const shell = GAP_SECTION_LABEL_RU[section] || 'Вариант';
        label = `${shell}: ${label}`;
      } else if (!value && !/[а-яё]/i.test(label)) {
        value = label;
      }
      return {
        label,
        ...(value ? { value } : {}),
        ...(CHIP_SECTIONS.has(section) ? { section } : {}),
      };
    })
    .filter(Boolean);

  return dropContradictoryTransparencyChips(mapped).slice(0, 6);
}

/** If both "no transparency" and "transparent background" appear, keep the no-transparency set. */
export function dropContradictoryTransparencyChips(chips) {
  const list = Array.isArray(chips) ? chips : [];
  const valueOf = (chip) => String(chip?.value || chip?.label || '').toLowerCase();
  const isNoTrans = (chip) => /no transparency|without transparency|opaque\b/i.test(valueOf(chip));
  const isTransBg = (chip) =>
    /transparent background|with transparency|alpha channel/i.test(valueOf(chip))
    && !isNoTrans(chip);
  const hasNo = list.some(isNoTrans);
  const hasYes = list.some(isTransBg);
  if (!hasNo || !hasYes) return list;
  return list.filter((chip) => !isTransBg(chip));
}

function draftPatchHasContent(draftPatch) {
  const patch = draftPatch && typeof draftPatch === 'object' ? draftPatch : {};
  return Boolean(
    patch.title
      || patch.task
      || (Array.isArray(patch.deliverables) && patch.deliverables.length)
      || (Array.isArray(patch.acceptance) && patch.acceptance.length)
      || (Array.isArray(patch.proof) && patch.proof.length)
      || patch.classification,
  );
}

export function parseComposerLlmRawResponse(rawText, latestUserMessage = '', options = {}) {
  let parsed = extractJsonObject(rawText);
  if (!parsed) {
    const plainText = String(rawText || '').trim();
    if (plainText) {
      parsed = {
        mode: 'draft',
        assistantMessage: plainText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim(),
        draftPatch: {},
        followUpChips: []
      };
    } else {
      const err = new Error('Composer LLM response did not contain valid JSON');
      err.code = 'composer_llm_invalid_json';
      err.raw = String(rawText || '').slice(0, 2000);
      throw err;
    }
  }
  const messages = options.messages || [];
  const firstOwner = resolveFirstUserMessage(messages) || latestUserMessage;
  const chipAnswer = Boolean(options.hints?.chipAnswer);
  const facts = options.facts || [];
  const normalized = normalizeComposerLlmTurnOutput(parsed, {
    facts,
    preferredMode: options.preferredMode || options.hints?.preferredMode,
    hints: options.hints,
  });
  const isGlyphWorkspace = options.hints?.workspace === 'ai_glyphs';
  const nonEnglishDraftDrops = isGlyphWorkspace ? [] : collectNonEnglishDraftDrops(normalized.draftPatch);
  const draftPatch = thinNormalizeComposerDraftPatch(normalized.draftPatch);
  const rawChips = Array.isArray(normalized.followUpChips) ? normalized.followUpChips : [];
  const followUpChips = isGlyphWorkspace
    ? rawChips
        .filter((chip) => chip && (typeof chip === 'object' || typeof chip === 'string'))
        .map((chip) => ({
          label: String(chip?.label || chip || '').trim(),
        }))
        .filter((c) => c.label.length >= 2)
        .slice(0, 6)
    : filterContourChips(rawChips, firstOwner);
  const nonEnglishChipValuesDropped = rawChips.some((chip) => {
    const value = String(chip?.value || '').trim();
    return value && isMostlyNonEnglishDraftText(value);
  }) && followUpChips.length < rawChips.length;
  let assistantMessage = String(normalized.assistantMessage || '').trim();
  const needsAck =
    isWeakConsultantAck(assistantMessage)
    || assistantEchoesAnyOwnerBrief(assistantMessage, messages, latestUserMessage)
    || assistantWrongLanguage(assistantMessage, firstOwner);

  if (isGlyphWorkspace) {
    if (!assistantMessage || isWeakConsultantAck(assistantMessage)) {
      assistantMessage = ownerUsesCyrillic(firstOwner)
        ? 'Сформулировал арт-директиву для глифов. Проверьте карточку предложения и нажмите "Apply to Glyph Forge", чтобы передать параметры воркерам.'
        : 'Formulated art directive for glyphs. Review the proposal card and click "Apply to Glyph Forge" to send to DePIN workers.';
    }
  } else if (chipAnswer) {
    const guidanceTurn =
      (options.preferredMode || options.hints?.preferredMode) === 'guidance';
    if (guidanceTurn) {
      // Guidance Confirm = direction facts only — keep LLM ask/chips voice unless weak.
      if (needsAck) {
        assistantMessage = buildHonestAssistantAck(firstOwner, draftPatch, followUpChips);
      }
    } else {
      // Draft Confirm: contour owns next step (Lock vs Apply) — LLM often mixes both.
      assistantMessage = buildChipContinuationAck(
        firstOwner,
        options.sectionDraft,
        draftPatch,
        followUpChips,
      );
    }
  } else if (needsAck) {
    assistantMessage = buildHonestAssistantAck(firstOwner, draftPatch, followUpChips);
  }
  return {
    ...normalized,
    assistantMessage,
    draftPatch,
    followUpChips,
    debug: {
      ...(normalized.debug && typeof normalized.debug === 'object' ? normalized.debug : {}),
      nonEnglishDraftDrops,
      nonEnglishChipValuesDropped,
    },
  };
}

function buildComposerTurnUserContent(input, latestUserMessage, extraTail = '') {
  if (input?.hints?.workspace === 'ai_glyphs') {
    return [
      latestUserMessage
        ? `OPERATOR CREATIVE BRIEF / REQUEST:\n${latestUserMessage}`
        : '',
      'CONTEXT (Glyph Series Creation):',
      buildComposerLlmUserPayload(input),
      'Reply with ONLY one valid JSON object. Propose series title, theme, primaryColor hex, accentColor hex, and a detailed creativePrompt for DePIN workers generating SVG vectors.',
      extraTail,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  const openGaps = expectsDraftMode(input) ? hintsOpenGaps(input) : [];
  const openGapsNudge = buildOpenGapsNudge(openGaps);
  return [
    latestUserMessage
      ? `LATEST OWNER MESSAGE (also listed in facts — cite fact ids in draftPatch):\n${latestUserMessage}`
      : '',
    'CONTEXT (evidence only — do not echo keys). Use input.facts ids in sourceFactIds. confirmed = locked. unknown → null/gap.',
    buildComposerLlmUserPayload(input),
    'Reply with ONLY one JSON object including mode ("guidance"|"draft"). Every draft line = {text, sourceFactIds}. Bare strings invalid. Guidance: chips/asks only — leave draftPatch empty (gaps optional); never invent. Draft: extract with sourceFactIds; unknown → null/gaps; include followUpChips for open gaps. Never invent acceptance/proof/classification.',
    openGapsNudge,
    extraTail,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runComposerLlmTurn(input, options = {}) {
  const injectedChat = typeof options.completeChat === 'function' ? options.completeChat : null;
  let config = WORKER_INJECTED_LLM_CONFIG;
  let chat = injectedChat;

  if (!injectedChat) {
    const localLlm = await loadLocalLlmClient();
    if (!localLlm.isComposerLlmHybridEnabled()) {
      const err = new Error('Composer LLM hybrid is disabled');
      err.code = 'composer_llm_disabled';
      throw err;
    }
    config = localLlm.getComposerLlmConfig();
    chat = localLlm.completeLocalChat;
  }

  const latestUserMessage = resolveLatestUserMessage(input.messages || []);
  const parseOptions = {
    hints: input.hints,
    sectionDraft: input.sectionDraft,
    messages: input.messages,
    facts: input.facts,
    preferredMode: input.hints?.preferredMode || input.preferredMode,
  };
  const systemContent = buildComposerLlmSystemPrompt(input);
  const chatMessages = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: buildComposerTurnUserContent(input, latestUserMessage),
    },
  ];
  const raw = await chat({
    messages: chatMessages,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });

  let output = parseComposerLlmRawResponse(raw, latestUserMessage, parseOptions);
  const firstOwner = resolveFirstUserMessage(input.messages) || latestUserMessage;
  const isGlyphWorkspace = input?.hints?.workspace === 'ai_glyphs';

  if (!isGlyphWorkspace && shouldRetryEnglishDraft(output)) {
    const drops = Array.isArray(output.debug?.nonEnglishDraftDrops)
      ? output.debug.nonEnglishDraftDrops
      : [];
    const previousJson = JSON.stringify({
      mode: output.mode,
      draftPatch: output.draftPatch,
      followUpChips: output.followUpChips,
      droppedNonEnglish: drops,
    });
    const retryMessages = [
      { role: 'system', content: systemContent },
      {
        role: 'user',
        content: buildComposerTurnUserContent(
          input,
          latestUserMessage,
          [
            buildEnglishDraftRetryCorrection(drops),
            `PREVIOUS_JSON (non-English draft rejected — fix it):\n${previousJson}`,
          ].join('\n\n'),
        ),
      },
    ];
    const retryRaw = await chat({
      messages: retryMessages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    const retryOutput = parseComposerLlmRawResponse(retryRaw, latestUserMessage, parseOptions);
    output = mergeEnglishRetryTurn(output, retryOutput);
    if (shouldRetryEnglishDraft(output) && !output.draftPatch?.task) {
      output.assistantMessage = buildEnglishDraftRejectAck(firstOwner);
    } else {
      output.assistantMessage = buildHonestAssistantAck(
        firstOwner,
        output.draftPatch,
        output.followUpChips,
      );
    }
  }

  const skipGapRetryAfterEnglishReject =
    Boolean(output.debug?.englishDraftRetry) && !output.draftPatch?.task;

  if (!isGlyphWorkspace && !skipGapRetryAfterEnglishReject && shouldRetryGapProposals(output, input)) {
    const openGaps = resolveOpenContentGaps(output.draftPatch, input.sectionDraft);
    const previousJson = JSON.stringify({
      mode: output.mode,
      draftPatch: output.draftPatch,
      followUpChips: output.followUpChips,
    });
    const retryMessages = [
      { role: 'system', content: systemContent },
      {
        role: 'user',
        content: buildComposerTurnUserContent(
          input,
          latestUserMessage,
          [
            buildGapRetryCorrection(openGaps),
            `PREVIOUS_JSON (incomplete — fix it):\n${previousJson}`,
          ].join('\n\n'),
        ),
      },
    ];
    const retryRaw = await chat({
      messages: retryMessages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });
    const retryOutput = parseComposerLlmRawResponse(retryRaw, latestUserMessage, parseOptions);
    output = mergeGapRetryTurn(output, retryOutput);
    output.assistantMessage = buildHonestAssistantAck(
      firstOwner,
      output.draftPatch,
      output.followUpChips,
    );
  }

  const artDirective = isGlyphWorkspace ? extractArtDirectiveFromOutput(output) : undefined;

  return {
    ...output,
    ...(artDirective ? { artDirective } : {}),
    meta: {
      provider: injectedChat ? 'fixture' : config.provider,
      model: injectedChat ? 'fixture' : config.genModel,
    },
  };
}

export const COMPOSER_TASK_TYPE = 'TASK_BOUNTY_COMPOSER_TURN';

function parseComposerBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

/** Worker path off by default — keeps existing sync local LLM until explicitly enabled. */
export function isComposerWorkerEnabled() {
  if (!parseComposerBool(process.env.COMPOSER_LLM_HYBRID_ENABLED, false)) return false;
  return parseComposerBool(process.env.COMPOSER_WORKER_ENABLED, false);
}

export function isComposerLlmTurnOutput(payload) {
  return Boolean(
    payload
    && typeof payload === 'object'
    && typeof payload.assistantMessage === 'string'
    && String(payload.assistantMessage).trim().length > 0,
  );
}

export function buildComposerTurnInputPayload(input = {}) {
  const messages = Array.isArray(input.messages)
    ? input.messages
      .map((message) => ({
        role: String(message?.role || 'user').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user',
        content: String(message?.content || message?.text || '').trim(),
      }))
      .filter((message) => message.content)
    : [];
  return {
    messages,
    facts: Array.isArray(input.facts) ? input.facts : [],
    confirmed: input.confirmed || null,
    sectionDraft: input.sectionDraft || null,
    validation: input.validation || null,
    hints: input.hints || null,
  };
}

export async function getComposerLlmPublicStatus() {
  const localLlm = await loadLocalLlmClient();
  const config = localLlm.getComposerLlmConfig();
  const { getComposerRuntimePolicy } = await import('./aiAssistRuntimePolicyService.js');
  const runtimePolicy = await getComposerRuntimePolicy();
  return {
    enabled: runtimePolicy.enabled,
    worker_enabled: runtimePolicy.effectiveRuntime === 'worker',
    local_llm_enabled: runtimePolicy.effectiveRuntime === 'local',
    worker_capable: runtimePolicy.workerCapable,
    local_llm_capable: runtimePolicy.localCapable,
    requested_runtime: runtimePolicy.requestedRuntime,
    effective_runtime: runtimePolicy.effectiveRuntime,
    provider: config.provider,
    model: config.genModel,
  };
}
