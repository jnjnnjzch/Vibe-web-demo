import { createViewer } from './viewer.js';
import { createSlices } from './slices.js';

export const ALLOWED_RELATION_TYPES = Object.freeze([
  'official_label',
  'exact_synonym',
  'close_relation',
  'related_term',
  'broader_term',
  'narrower_term',
  'ambiguous_label',
]);

const allowedRelations = new Set(ALLOWED_RELATION_TYPES);
const defaultLanguage = 'en';

async function loadJson(path, fetchImpl = fetch) {
  const response = await fetchImpl(path);
  if (!response.ok) throw new Error(`Failed to load ${path}`);
  return response.json();
}

function unwrapItems(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : [];
}

function normalize(text) {
  return String(text || '').trim().toLowerCase();
}

function mapByEntry(items) {
  return new Map(items.map((item) => [item.entry_id, item]));
}

function mapByKey(items, key) {
  return new Map(items.map((item) => [item[key], item]));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normalizeAtlasData(payload) {
  const regions = unwrapItems(payload.regions).map((region) => ({
    ...region,
    label: region.official_label || region.label || '',
  }));
  const aliases = unwrapItems(payload.aliases);
  const assets = unwrapItems(payload.assets);
  const sources = unwrapItems(payload.sources);
  const papers = unwrapItems(payload.papers);
  const citations = unwrapItems(payload.citations);

  const aliasesByEntryId = new Map();
  aliases.forEach((alias) => {
    const bucket = aliasesByEntryId.get(alias.entry_id) || [];
    bucket.push(alias);
    aliasesByEntryId.set(alias.entry_id, bucket);
  });

  return {
    regions,
    aliases,
    assets,
    assetMetadata: payload.assets && !Array.isArray(payload.assets)
      ? {
          whole_brain_context_mesh: payload.assets.whole_brain_context_mesh || null,
        }
      : { whole_brain_context_mesh: null },
    sources,
    papers,
    citations,
    regionsById: mapByEntry(regions),
    aliasesByEntryId,
    assetsByEntryId: mapByEntry(assets),
    papersByEntryId: mapByEntry(papers),
    citationsById: mapByKey(citations, 'citation_id'),
    sourcesById: mapByKey(sources, 'source_id'),
  };
}

export function validateContract(dataset) {
  const { regions, aliases, assets, papers } = dataset;
  if (regions.length !== 368) throw new Error(`Expected 368 regions, got ${regions.length}`);
  if (new Set(regions.map((region) => region.entry_id)).size !== regions.length) throw new Error('entry_id must be unique');
  if (assets.length !== 368) throw new Error(`Expected 368 asset records, got ${assets.length}`);
  if (assets.filter((asset) => asset.asset_status === 'available').length !== 365) throw new Error('Expected 365 available spatial assets');
  if (assets.filter((asset) => asset.asset_status === 'missing_in_volume').length !== 3) throw new Error('Expected 3 missing_in_volume asset records');
  if (!aliases.every((alias) => allowedRelations.has(alias.relation_type))) throw new Error('Unsupported alias relation type');
  if (!papers.every((item) => 'paper_ids' in item && 'papers' in item && 'references' in item && 'paper_annotations' in item && 'evidence_density' in item)) throw new Error('Paper extension contract incomplete');
  if (new Set(dataset.citations.map((item) => item.citation_id)).size !== dataset.citations.length) throw new Error('citation_id must be unique');
}

export function searchRegions(dataset, query) {
  const q = normalize(query);
  if (!q) return dataset.regions;
  return dataset.regions.filter((region) => {
    const aliases = dataset.aliasesByEntryId.get(region.entry_id) || [];
    const haystack = [
      region.entry_id,
      region.official_label,
      region.official_long_name,
      region.recommended_display_name,
      region.group,
      ['verified', 'machine_translated'].includes(region.localized_names?.['zh-CN']?.status)
        ? region.localized_names['zh-CN'].name
        : '',
      ...aliases.map((alias) => alias.alias),
    ].join(' ');
    return normalize(haystack).includes(q);
  });
}

export function buildRegionViewModel(dataset, entryId) {
  const region = dataset.regionsById.get(entryId);
  if (!region) return null;
  const paperRecord = dataset.papersByEntryId.get(entryId) || {};
  const asset = dataset.assetsByEntryId.get(entryId) || null;
  const source = asset?.source_id ? dataset.sourcesById.get(asset.source_id) || null : null;
  return {
    ...region,
    aliases: dataset.aliasesByEntryId.get(entryId) || [],
    asset,
    source,
    paper_ids: paperRecord.paper_ids || [],
    papers: (paperRecord.paper_ids || paperRecord.papers || [])
      .map((citationId) => dataset.citationsById.get(citationId))
      .filter(Boolean),
    references: paperRecord.references || [],
    paper_annotations: paperRecord.paper_annotations || [],
    evidence_density: paperRecord.evidence_density || null,
    review: paperRecord.review || null,
    functional_summary: paperRecord.functional_summary || null,
    connectivity_summary: paperRecord.connectivity_summary || null,
  };
}

export function readStateFromUrl(urlLike = location.href) {
  const url = new URL(urlLike, 'http://localhost/');
  return {
    entryId: url.searchParams.get('entry_id') || url.searchParams.get('entry') || '',
    query: url.searchParams.get('q') || '',
    language: url.searchParams.get('lang') === 'zh' ? 'zh' : defaultLanguage,
  };
}

export function writeStateToUrl(state, historyImpl = history, locationImpl = location) {
  const url = new URL(locationImpl.href);
  if (state.entryId) url.searchParams.set('entry_id', state.entryId);
  else url.searchParams.delete('entry_id');
  if (state.query) url.searchParams.set('q', state.query);
  else url.searchParams.delete('q');
  if (state.language && state.language !== defaultLanguage) url.searchParams.set('lang', state.language);
  else url.searchParams.delete('lang');
  historyImpl.replaceState({}, '', url);
}

function translated(language, en, zh) {
  return language === 'zh' ? zh : en;
}

export function displayName(region, language = defaultLanguage) {
  const english = region?.recommended_display_name || region?.official_long_name || region?.official_label || '';
  const zh = region?.localized_names?.['zh-CN'];
  const chinese = zh?.name || '';
  const status = zh?.status || 'pending_standardization';
  const text = language === 'zh'
    ? chinese ? `${chinese} / ${english}` : `${english} / 中文名待标准化`
    : chinese ? `${english} / ${chinese}` : english;
  return { text, english, chinese, status };
}

function formatValue(value) {
  return value ? escapeHtml(value) : '—';
}

function formatBoolean(value, language) {
  if (value === true) return translated(language, 'Yes', '是');
  if (value === false) return translated(language, 'No', '否');
  return '—';
}

function semanticTone(value, type) {
  if (type === 'asset') {
    if (value === 'available') return 'ready';
    if (value === 'missing_in_volume') return 'missing';
  }
  if (type === 'chinese') {
    if (value === 'verified') return 'ready';
    if (value === 'pending_standardization') return 'pending';
    if (value === 'machine_translated') return 'warning';
  }
  if (type === 'confidence') {
    if (value === 'high') return 'ready';
    if (value === 'medium') return 'warning';
    if (value === 'low') return 'pending';
  }
  if (type === 'authoritative') {
    if (value === true) return 'ready';
    if (value === false) return 'warning';
  }
  return 'neutral';
}

function translatedMetadataValue(language, key, value) {
  const labels = {
    asset_status: {
      available: translated(language, 'Available', '可用'),
      missing_in_volume: translated(language, 'Missing in volume', '官方 volume 中缺失'),
    },
    chinese_status: {
      verified: translated(language, 'Verified', '已核验'),
      pending_standardization: translated(language, 'Pending standardization', '待标准化'),
      machine_translated: translated(language, 'Machine translated', '机器翻译'),
    },
    confidence: {
      high: translated(language, 'High confidence', '高置信度'),
      medium: translated(language, 'Medium confidence', '中置信度'),
      low: translated(language, 'Low confidence', '低置信度'),
    },
  };
  return labels[key]?.[value] || value || '—';
}

function compactField(label, value, tone = 'neutral') {
  if (value === undefined || value === null || value === '') return '';
  return `
    <span class="info-pill is-${escapeHtml(tone)}">
      <small>${escapeHtml(label)}</small>
      <strong>${formatValue(value)}</strong>
    </span>
  `;
}

function renderInfoPills(items) {
  return items.map((item) => compactField(item.label, item.value, item.tone)).join('');
}

export function buildMetadataPresentation(viewModel, language = defaultLanguage) {
  const chineseStatus = viewModel.localized_names?.['zh-CN']?.status || 'pending_standardization';
  const sourceTitle = viewModel.source?.title || viewModel.source?.source_id || '';
  const method = viewModel.asset?.generation_method || viewModel.source?.generation_method || '';
  const license = viewModel.asset?.license_status || viewModel.source?.license_status || '';
  return {
    primary: [
      {
        key: 'entry_id',
        label: 'entry_id',
        value: viewModel.entry_id,
        tone: 'neutral',
      },
      {
        key: 'confidence',
        label: translated(language, 'Confidence', '置信度'),
        value: translatedMetadataValue(language, 'confidence', viewModel.confidence),
        tone: semanticTone(viewModel.confidence, 'confidence'),
      },
      {
        key: 'chinese_status',
        label: translated(language, 'Chinese', '中文'),
        value: translatedMetadataValue(language, 'chinese_status', chineseStatus),
        tone: semanticTone(chineseStatus, 'chinese'),
      },
      {
        key: 'asset_status',
        label: translated(language, 'Spatial asset', '空间资产'),
        value: translatedMetadataValue(language, 'asset_status', viewModel.asset?.asset_status),
        tone: semanticTone(viewModel.asset?.asset_status, 'asset'),
      },
      {
        key: 'authoritative',
        label: translated(language, 'Authoritative', '权威性'),
        value: formatBoolean(viewModel.source?.is_authoritative, language),
        tone: semanticTone(viewModel.source?.is_authoritative, 'authoritative'),
      },
    ],
    secondary: [
      {
        key: 'source',
        label: translated(language, 'Source', '来源'),
        value: sourceTitle,
      },
      {
        key: 'generation_method',
        label: translated(language, 'Method', '生成方式'),
        value: method,
      },
      {
        key: 'license_status',
        label: translated(language, 'License', '授权'),
        value: license,
      },
    ],
  };
}

function isScaffoldAsset(viewModel) {
  return Boolean(
    viewModel?.asset?.generation_method?.includes('synthetic') ||
    viewModel?.source?.is_authoritative === false ||
    viewModel?.source?.source_id === 'synthetic-export-generator',
  );
}

function setLanguage(language) {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.body.dataset.language = language;
  document.title = translated(language, 'D99 Atlas · Macaque Brain Atlas', 'D99 图谱 · 猕猴脑图谱');
  document.querySelectorAll('[data-en][data-zh]').forEach((node) => {
    node.textContent = node.dataset[language];
  });
}

function renderResults(container, regions, selectedId, onSelect, language) {
  container.innerHTML = '';
  regions.slice(0, 80).forEach((region) => {
    const button = document.createElement('button');
    button.className = region.entry_id === selectedId ? 'result is-active' : 'result';
    button.innerHTML = `
      <strong>${escapeHtml(region.official_label)}</strong>
      <span class="localized-name is-${escapeHtml(displayName(region, language).status)}">
        ${escapeHtml(displayName(region, language).text)}
        ${displayName(region, language).status === 'machine_translated' ? `<em>${translated(language, 'Auto translated', '自动翻译')}</em>` : ''}
      </span>
      <small class="result-tags">
        <span>${escapeHtml(region.group || '—')}</span>
        <span>${escapeHtml(region.entry_id)}</span>
      </small>
    `;
    button.addEventListener('click', () => onSelect(region.entry_id));
    container.append(button);
  });
}

function renderDetail(container, viewModel, language) {
  if (!viewModel) {
    container.innerHTML = `<p class="muted">${translated(language, 'Select a region.', '请选择一个区域。')}</p>`;
    return;
  }

  const scaffoldAsset = isScaffoldAsset(viewModel);
  const missingInVolume = viewModel.asset?.asset_status === 'missing_in_volume';
  const metadata = buildMetadataPresentation(viewModel, language);
  const name = displayName(viewModel, language);
  const keyFacts = [
    {
      label: translated(language, 'Official label', '官方 label'),
      value: viewModel.official_label,
    },
    {
      label: translated(language, 'Long name', '官方长名'),
      value: viewModel.official_long_name,
    },
    {
      label: translated(language, 'Display', '推荐显示'),
      value: viewModel.recommended_display_name,
    },
    {
      label: translated(language, 'Chinese', '中文'),
      value: viewModel.localized_names?.['zh-CN']?.name,
      tone: semanticTone(name.status, 'chinese'),
    },
  ];
  const taxonomy = [
    {
      label: translated(language, 'Group', '分组'),
      value: viewModel.group,
    },
    {
      label: translated(language, 'Subgroup', '亚组'),
      value: viewModel.subgroup,
    },
    {
      label: translated(language, 'Ambiguity', '歧义'),
      value: viewModel.ambiguity_note,
      tone: viewModel.ambiguity_note ? 'warning' : 'neutral',
    },
  ];
  const assetPills = [
    {
      label: translated(language, 'Source', '来源'),
      value: viewModel.source?.title,
    },
    {
      label: translated(language, 'Authoritative', '权威'),
      value: formatBoolean(viewModel.source?.is_authoritative, language),
      tone: semanticTone(viewModel.source?.is_authoritative, 'authoritative'),
    },
    {
      label: translated(language, 'Method', '生成'),
      value: viewModel.asset?.generation_method || viewModel.source?.generation_method,
      tone: scaffoldAsset ? 'warning' : 'neutral',
    },
    {
      label: translated(language, 'License', '授权'),
      value: viewModel.asset?.license_status || viewModel.source?.license_status,
    },
    {
      label: translated(language, 'Missing reason', '缺失原因'),
      value: viewModel.asset?.missing_reason,
      tone: missingInVolume ? 'missing' : 'neutral',
    },
  ];

  container.innerHTML = `
    <div class="detail-heading detail-heading--compact">
      <div>
        <p class="detail-kicker">${translated(language, 'Selected region', '当前区域')}</p>
        <h3 class="localized-name is-${escapeHtml(name.status)}">
          ${formatValue(name.text)}
          ${name.status === 'machine_translated' ? `<em>${translated(language, 'Auto translated', '自动翻译')}</em>` : ''}
        </h3>
      </div>
      <span class="status-pill ${missingInVolume || scaffoldAsset ? 'is-warning' : 'is-ready'}">
        ${missingInVolume
          ? translated(language, 'Missing in volume', '官方 volume 中缺失')
          : scaffoldAsset
          ? translated(language, 'Scaffold data', '脚手架数据')
          : translated(language, 'Atlas-backed', '图谱支撑')}
      </span>
    </div>
    <div class="metadata-rails metadata-rails--compact" aria-label="${translated(language, 'Audit metadata', '复核元数据')}">
      <div class="metadata-rail metadata-rail--primary">
        ${metadata.primary.map((item) => `
          <span class="metadata-badge is-${escapeHtml(item.tone)}">
            <small>${escapeHtml(item.label)}</small>
            <strong>${formatValue(item.value)}</strong>
          </span>
        `).join('')}
      </div>
      <div class="metadata-rail metadata-rail--secondary">
        ${metadata.secondary.map((item) => `
          <span class="metadata-tag">
            <small>${escapeHtml(item.label)}</small>
            <strong>${formatValue(item.value)}</strong>
          </span>
        `).join('')}
      </div>
    </div>
    <section class="detail-section detail-section--pills">
      <h3>${translated(language, 'Names', '名称')}</h3>
      <div class="info-pill-grid">${renderInfoPills(keyFacts)}</div>
    </section>
    <section class="detail-section detail-section--pills">
      <h3>${translated(language, 'Taxonomy', '分类')}</h3>
      <div class="info-pill-grid">${renderInfoPills(taxonomy)}</div>
    </section>
    <section class="detail-section detail-section--pills">
      <h3>${scaffoldAsset ? translated(language, 'Scaffold asset path', '脚手架资产链路') : translated(language, 'Asset provenance', '资产来源')}</h3>
      <div class="info-pill-grid">${renderInfoPills(assetPills)}</div>
    </section>
    <section class="detail-section">
      <h3>${translated(language, 'Aliases', '别名')}</h3>
      <ul class="alias-list alias-list--pills">
        ${viewModel.aliases.map((alias) => `
          <li>
            <span>${formatValue(alias.alias)}</span>
            <em>${formatValue(alias.relation_type)}</em>
          </li>
        `).join('')}
      </ul>
    </section>
    ${missingInVolume ? `
      <p class="callout">
        ${translated(
          language,
          'This nomenclature entry exists, but the current official D99 volume contains no derivable spatial voxels for it. The atlas keeps the entry searchable rather than fabricating geometry.',
          '该 nomenclature 条目真实存在，但当前官方 D99 volume 中没有可派生的空间体素；系统保留其可搜索性，而不是伪造几何资产。'
        )}
      </p>
    ` : scaffoldAsset ? `
      <p class="callout">
        ${translated(
          language,
          'This UI can already host the real atlas payload, but the currently loaded visual path is still scaffold-grade and should not be read as authoritative anatomy.',
          '当前 UI 已可承载真实 atlas payload，但此刻加载的视觉链路仍属脚手架级，不能被解读为权威解剖结果。'
        )}
      </p>
    ` : ''}
  `;
}

function renderCitationMarkers(ids = []) {
  return ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('');
}

function renderExternalLinks(paper, language) {
  const links = [];
  if (paper.source_link) links.push(`<a href="${escapeHtml(paper.source_link)}" target="_blank" rel="noreferrer">${translated(language, 'Source', '来源')}</a>`);
  if (paper.doi) links.push(`<a href="https://doi.org/${encodeURIComponent(paper.doi)}" target="_blank" rel="noreferrer">DOI</a>`);
  if (paper.pmid) links.push(`<a href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(paper.pmid)}/" target="_blank" rel="noreferrer">PubMed</a>`);
  return links.length ? links.join(' · ') : translated(language, 'No external link', '暂无外链');
}

function renderSummaryBlock(title, summary, language) {
  if (!summary) return '';
  const text = summary[language] || summary.en || '';
  if (!text.trim()) return '';
  return `
    <section class="knowledge-summary">
      <h4>${title}</h4>
      <p>${escapeHtml(text)}</p>
      <div class="citation-markers">${renderCitationMarkers(summary.citation_ids)}</div>
    </section>
  `;
}

function renderPapers(container, viewModel, language) {
  const papers = viewModel?.papers || [];
  const functional = viewModel?.functional_summary;
  const connectivity = viewModel?.connectivity_summary;
  const review = viewModel?.review || null;
  if (!papers.length && !functional && !connectivity) {
    container.innerHTML = `<p class="muted">${translated(language, 'No paper-layer content yet.', '暂无论文层内容。')}</p>`;
    return;
  }
  const reviewLabel = review?.status === 'checked_sparse'
    ? translated(language, 'Checked sparse', '复核后 sparse')
    : review?.status === 'standard'
      ? translated(language, 'Reviewed standard', '已复核 standard')
      : '';
  const reviewReasons = (review?.checked_sparse_reasons || [])
    .map((reason) => reason.replaceAll('_', ' '))
    .join(' · ');
  container.innerHTML = `
    <article class="knowledge-card">
      ${reviewLabel ? `
        <div class="review-rail">
          <span class="review-badge is-${escapeHtml(review.status)}">${escapeHtml(reviewLabel)}</span>
          ${reviewReasons ? `<span class="review-reasons">${escapeHtml(reviewReasons)}</span>` : ''}
        </div>
      ` : ''}
      ${renderSummaryBlock(translated(language, 'Function', '功能摘要'), functional, language)}
      ${renderSummaryBlock(translated(language, 'Connectivity', '连接摘要'), connectivity, language)}
      <details class="paper-list">
        <summary>${translated(language, `Key papers (${papers.length})`, `关键论文（${papers.length}）`)}</summary>
        <ol>
          ${papers.map((paper) => `
            <li id="citation-${escapeHtml(paper.citation_id)}">
              <strong>${escapeHtml(paper.title)}</strong>
              <span>${escapeHtml((paper.authors || []).join(', '))} · ${escapeHtml(paper.year)} · ${escapeHtml(paper.journal)}</span>
              <small><code>${escapeHtml(paper.citation_id)}</code> · ${renderExternalLinks(paper, language)}</small>
            </li>
          `).join('')}
        </ol>
      </details>
    </article>
  `;
}

async function loadDataset() {
  const [regions, aliases, assets, sources, papers, citations] = await Promise.all([
    loadJson('../data/web/regions.json'),
    loadJson('../data/web/aliases.json'),
    loadJson('../data/web/assets.json'),
    loadJson('../data/web/sources.json'),
    loadJson('../data/literature/papers.json'),
    loadJson('../data/literature/citations.json'),
  ]);
  const dataset = normalizeAtlasData({ regions, aliases, assets, sources, papers, citations });
  validateContract(dataset);
  return dataset;
}

async function boot() {
  const dataset = await loadDataset();
  const enrichedRegions = dataset.regions.map((region) => {
    const assets = dataset.assetsByEntryId.get(region.entry_id) || {};
    return {
      ...region,
      centroid: Object.values(assets.centroid || {}),
      asset_status: assets.asset_status,
      assets,
    };
  });
  const enrichedDataset = normalizeAtlasData({ ...dataset, regions: enrichedRegions });

  const search = document.querySelector('#search');
  const results = document.querySelector('#results');
  const detail = document.querySelector('#detail');
  const papersPanel = document.querySelector('#papers');
  const datasetStatus = document.querySelector('#dataset-status');
  const languageToggle = document.querySelector('#language');
  const eventTarget = document;
  const restored = readStateFromUrl();
  let selectedId = enrichedDataset.regionsById.has(restored.entryId) ? restored.entryId : enrichedRegions[0]?.entry_id;
  const state = { entryId: selectedId, query: restored.query, language: restored.language };

  search.value = state.query;
  languageToggle.value = state.language;
  setLanguage(state.language);

  const viewer = createViewer(document.querySelector('#viewer'), enrichedRegions, {
    selectedId,
    eventTarget,
    language: state.language,
    wholeBrainMesh: enrichedDataset.assetMetadata.whole_brain_context_mesh,
    getRegionLabel: (entryId) => {
      const region = enrichedDataset.regionsById.get(entryId);
      return region ? displayName(region, state.language) : null;
    },
  });
  const slices = createSlices(document.querySelector('#slices'), enrichedRegions, { selectedId, eventTarget });

  function filteredRegions() {
    return searchRegions(enrichedDataset, state.query);
  }

  function select(entryId, source = 'app') {
    if (!enrichedDataset.regionsById.has(entryId)) return;
    selectedId = entryId;
    state.entryId = entryId;
    const viewModel = buildRegionViewModel(enrichedDataset, entryId);
    renderResults(results, filteredRegions(), selectedId, (id) => select(id), state.language);
    renderDetail(detail, viewModel, state.language);
    renderPapers(papersPanel, viewModel, state.language);
    viewer.select(entryId, false);
    slices.select(entryId, false);
    writeStateToUrl(state);
    if (source === 'app') document.dispatchEvent(new CustomEvent('d99:select', { detail: { entry_id: entryId, source: 'app' } }));
  }

  const scaffoldAssetsInDataset = enrichedDataset.regions.some((region) => {
    const viewModel = buildRegionViewModel(enrichedDataset, region.entry_id);
    return isScaffoldAsset(viewModel);
  });
  datasetStatus.className = scaffoldAssetsInDataset ? 'dataset-status is-warning' : 'dataset-status is-ready';
  datasetStatus.textContent = scaffoldAssetsInDataset
    ? translated(state.language, 'Scaffold visual payload loaded', '当前加载的是脚手架视觉 payload')
    : translated(state.language, '365 available · 3 missing in volume', '365 可用 · 3 个在 volume 中缺失');

  search.addEventListener('input', () => {
    state.query = search.value;
    renderResults(results, filteredRegions(), selectedId, (id) => select(id), state.language);
    writeStateToUrl(state);
  });
  languageToggle.addEventListener('change', () => {
    state.language = languageToggle.value === 'zh' ? 'zh' : defaultLanguage;
    setLanguage(state.language);
    viewer.setLanguage?.(state.language);
    const viewModel = buildRegionViewModel(enrichedDataset, selectedId);
    renderResults(results, filteredRegions(), selectedId, (id) => select(id), state.language);
    renderDetail(detail, viewModel, state.language);
    renderPapers(papersPanel, viewModel, state.language);
    datasetStatus.textContent = scaffoldAssetsInDataset
      ? translated(state.language, 'Scaffold visual payload loaded', '当前加载的是脚手架视觉 payload')
      : translated(state.language, '365 available · 3 missing in volume', '365 可用 · 3 个在 volume 中缺失');
    writeStateToUrl(state);
  });
  document.addEventListener('d99:select', (event) => {
    if (event.detail?.source !== 'app') select(event.detail.entry_id, event.detail.source);
  });

  renderResults(results, filteredRegions(), selectedId, (id) => select(id), state.language);
  select(selectedId);
}

boot().catch((error) => {
  document.body.innerHTML = `<pre class="fatal">${error.stack || error.message}</pre>`;
});
