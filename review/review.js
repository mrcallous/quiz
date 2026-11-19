'use strict';

const $ = id => document.getElementById(id);
const pageSize = 25;
const questionSets = new Map();
const pendingSets = new Map();
let records = [];
let sources = [];
let filtered = [];
let currentPage = 0;
let filterVersion = 0;
let renderVersion = 0;
let searchTimer;
let retryAction;

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const normalizedAnswer = value => [...String(value || '').toUpperCase()].sort().join('');

function showError(error, retry) {
  $('list').setAttribute('aria-busy', 'false');
  $('list').innerHTML = '';
  $('error-message').textContent = error.message || '加载失败，请检查网络后重试。';
  $('load-error').hidden = false;
  retryAction = retry;
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('加载失败，请检查网络后重试。');
  return response.json();
}

async function loadSet(slug) {
  if (questionSets.has(slug)) return questionSets.get(slug);
  if (pendingSets.has(slug)) return pendingSets.get(slug);
  const source = sources.find(item => item.slug === slug);
  const request = (async () => {
    const packet = await fetchJSON(source.url);
    if (packet.format !== 'aura-quiz' || !Array.isArray(packet.questions)) {
      throw new Error('题集格式异常，请重新加载。');
    }
    const questions = new Map(packet.questions.map(question => [String(question.id), question]));
    for (const record of records.filter(item => item.slug === slug)) {
      const question = questions.get(record.id);
      if (!question || !question.options || typeof question.answer !== 'string') {
        throw new Error('题集与复盘记录暂时不匹配，请重新加载。');
      }
    }
    questionSets.set(slug, questions);
    return questions;
  })();
  pendingSets.set(slug, request);
  try {
    return await request;
  } finally {
    pendingSets.delete(slug);
  }
}

async function hydrate(items) {
  await Promise.all([...new Set(items.map(item => item.slug))].map(loadSet));
}

function questionFor(record) {
  const question = questionSets.get(record.slug).get(record.id);
  return {
    ...record,
    ...question,
    title: record.title,
    index: record.index,
    selected: record.selected,
    correct: normalizedAnswer(record.selected) === normalizedAnswer(question.answer)
  };
}

function imagePanel(images, label) {
  if (!Array.isArray(images) || !images.length) return '';
  const figures = images.map((image, index) => {
    const source = image.data || image.url || '';
    if (!/^https?:\/\//i.test(source) && !/^data:image\//i.test(source)) return '';
    return '<figure><figcaption>' + escape(image.alt || label + ' ' + (index + 1))
      + '</figcaption><img data-src="' + escape(source) + '" loading="lazy" alt="'
      + escape(image.alt || label + ' ' + (index + 1)) + '"></figure>';
  }).join('');
  if (!figures) return '';
  return '<details class="figures-panel"><summary>' + escape(label) + '（' + images.length
    + ' 张）</summary><div class="figures">' + figures + '</div></details>';
}

function imageReviewMarkup(review) {
  if (!review) return '';
  return '<details class="image-review"><summary>图片核验 · ' + escape(review.severity)
    + '</summary><p>' + escape(review.verdict) + '</p><p><strong>图中证据：</strong>'
    + escape(review.evidence) + '</p><p><strong>核对提醒：</strong>' + escape(review.discrepancy)
    + '</p><p><strong>练习要点：</strong>' + escape(review.training_note) + '</p></details>';
}

function questionMarkup(record) {
  const row = questionFor(record);
  const statusClass = row.resolved ? 'resolved' : 'pending';
  const badges = [row.category, row.subtopic, row.pattern].filter(Boolean)
    .map(label => '<span class="badge">' + escape(label) + '</span>').join('');
  const options = Object.entries(row.options).map(([letter, value]) =>
    '<li><strong>' + escape(letter) + '.</strong> ' + escape(value)
    + imagePanel(row.optionImages?.[letter], '查看选项 ' + letter + ' 附图') + '</li>'
  ).join('');
  return '<article class="q" data-question-id="' + escape(row.id) + '"><h2>' + escape(row.title)
    + ' · ' + (row.type === 'single' ? '单选' : '多选') + '第' + escape(row.number || row.index)
    + '题 <span class="info">卷内位置 ' + escape(row.index) + ' · ID ' + escape(row.id)
    + '</span></h2><div class="badges">' + badges
    + (row.duplicate_group ? '<span class="badge">近重复组 ' + escape(row.duplicate_group) + '</span>' : '')
    + (row.review_status ? '<span class="badge ' + statusClass + '">' + escape(row.review_status) + '</span>' : '')
    + '</div>' + (row.review_note ? '<div class="review-note">' + escape(row.review_note) + '</div>' : '')
    + '<div class="stem">' + escape(row.stem) + '</div>'
    + imagePanel(row.images, '查看题图') + imageReviewMarkup(row.image_review)
    + '<ul class="options">' + options + '</ul><p class="selected">原作答：' + escape(row.selected)
    + ' · ' + (row.correct ? '与当前题库答案一致' : '与当前题库答案不一致') + '</p>'
    + '<details class="answer-panel"' + ($('answers').checked ? ' open' : '') + '><summary>查看题库答案与解释</summary>'
    + '<div class="answer"><strong>题库答案：' + escape(row.answer) + '</strong><div class="explanation">'
    + escape(row.explanation) + '</div>' + imagePanel(row.explanationImages, '查看解析附图')
    + '</div></details></article>';
}

function updateFilterSummary() {
  const labels = [];
  if ($('set').value) labels.push($('set').value);
  if ($('category').value) labels.push($('category').value);
  if ($('pattern').value) labels.push($('pattern').value);
  for (const [id, text] of [['wrong', '仅错题'], ['issues', '待复核'], ['dups', '近重复'], ['images', '图题']]) {
    if ($(id).checked) labels.push(text);
  }
  if ($('search').value.trim()) labels.push('关键词搜索');
  $('filter-summary').textContent = labels.join(' · ') || '全部题目';
}

async function apply() {
  const version = ++filterVersion;
  ++renderVersion;
  currentPage = 0;
  updateFilterSummary();
  $('load-error').hidden = true;
  let candidates = records.filter(row =>
    (!$('set').value || row.title === $('set').value)
    && (!$('category').value || row.category === $('category').value)
    && (!$('pattern').value || row.pattern === $('pattern').value)
    && (!$('wrong').checked || !row.correct)
    && (!$('issues').checked || (row.review_status && !row.resolved))
    && (!$('dups').checked || row.duplicate_group)
    && (!$('images').checked || row.hasImages)
  );
  const term = $('search').value.trim().toLowerCase();
  if (term) {
    $('list').setAttribute('aria-busy', 'true');
    $('list').innerHTML = '<div class="loading" role="status">正在搜索题目…</div>';
    try {
      await hydrate(candidates);
      if (version !== filterVersion) return;
      candidates = candidates.filter(record => {
        const row = questionFor(record);
        return [row.title, row.id, row.stem, row.subtopic, row.explanation, ...Object.values(row.options)]
          .join(' ').toLowerCase().includes(term);
      });
    } catch (error) {
      if (version === filterVersion) showError(new Error('搜索失败，请检查网络后重试。'), apply);
      return;
    }
  }
  if (version !== filterVersion) return;
  filtered = candidates;
  await render();
}

async function render() {
  const version = ++renderVersion;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  currentPage = Math.min(Math.max(0, currentPage), pages - 1);
  $('count').textContent = '当前 ' + filtered.length + ' 题 · 原答错 '
    + filtered.filter(row => !row.correct).length + ' 题 · 每页 ' + pageSize + ' 题';
  $('page').textContent = (currentPage + 1) + ' / ' + pages;
  $('prev').disabled = currentPage === 0;
  $('next').disabled = currentPage >= pages - 1;
  $('load-error').hidden = true;
  const page = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  if (!page.length) {
    $('list').innerHTML = '<div class="empty">没有匹配题目，可调整筛选条件。</div>';
    $('list').setAttribute('aria-busy', 'false');
    return;
  }
  $('list').setAttribute('aria-busy', 'true');
  $('list').innerHTML = '<div class="loading" role="status">正在加载题目…</div>';
  try {
    await hydrate(page);
    if (version !== renderVersion) return;
    $('list').innerHTML = page.map(questionMarkup).join('');
    $('list').setAttribute('aria-busy', 'false');
  } catch (error) {
    if (version === renderVersion) showError(new Error('题目加载失败，请检查网络后重试。'), render);
  }
}

function fillOptions(id, values) {
  const select = $(id);
  select.replaceChildren(select.options[0]);
  for (const value of [...new Set(values.filter(Boolean))]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }
}

async function initialize() {
  $('load-error').hidden = true;
  try {
    const annotations = await fetchJSON('./annotations.json');
    if (annotations.version !== 1 || !Array.isArray(annotations.sets)) {
      throw new Error('复盘记录格式异常。');
    }
    sources = annotations.sets;
    records = sources.flatMap(source => source.items.map(item => ({
      ...item, id: String(item.id), title: source.title, slug: source.slug
    })));
    fillOptions('set', sources.map(source => source.title));
    fillOptions('category', records.map(row => row.category));
    fillOptions('pattern', records.map(row => row.pattern));
    const wrong = records.filter(row => !row.correct).length;
    const review = records.filter(row => row.review_status && !row.resolved).length;
    const duplicateGroups = new Set(records.map(row => row.duplicate_group).filter(Boolean)).size;
    $('metric-total').textContent = records.length + ' 题 · ' + (records.length - wrong) + ' 对';
    $('metric-wrong').textContent = wrong + ' 道历史错题';
    $('metric-review').textContent = review + ' 题待复核';
    $('metric-duplicates').textContent = duplicateGroups + ' 组近重复变式';
    $('filter-controls').disabled = false;
    await apply();
  } catch (error) {
    $('count').textContent = '复盘记录加载失败';
    showError(new Error('复盘记录加载失败，请检查网络后重试。'), initialize);
  }
}

for (const id of ['set', 'category', 'pattern', 'wrong', 'issues', 'dups', 'images']) {
  $(id).addEventListener('change', () => {
    clearTimeout(searchTimer);
    apply();
  });
}
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  ++filterVersion;
  ++renderVersion;
  searchTimer = setTimeout(apply, 180);
});
$('answers').addEventListener('change', () => {
  document.querySelectorAll('details.answer-panel').forEach(panel => { panel.open = $('answers').checked; });
});
$('list').addEventListener('toggle', event => {
  const panel = event.target;
  if (!panel.matches('details.figures-panel') || !panel.open) return;
  for (const image of panel.querySelectorAll('img[data-src]')) {
    image.src = image.dataset.src;
    delete image.dataset.src;
  }
}, true);
$('retry').addEventListener('click', () => retryAction?.());
for (const [id, direction] of [['prev', -1], ['next', 1]]) {
  $(id).addEventListener('click', () => {
    currentPage += direction;
    render();
    $('count').scrollIntoView({ block: 'start', behavior: 'auto' });
  });
}
if (matchMedia('(max-width:650px)').matches) $('filters-panel').open = false;
initialize();

