// 관리 표(.management-table)의 각 칸에 머리글 이름을 data-label로 붙여요.
// 모바일에서는 표를 카드로 바꿔 보여 주는데, 이때 칸 이름을 CSS가 이 값으로 그려요.
const ACTION_LABELS = new Set(['', '관리', '처리', '수정', '설정', '갱신']);

function labelTable(table: HTMLTableElement) {
  const heads: string[] = [];
  table.querySelectorAll('thead tr:last-child th').forEach((th) => {
    const span = Number((th as HTMLTableCellElement).colSpan) || 1;
    const text = (th.textContent || '').trim();
    for (let i = 0; i < span; i++) heads.push(text);
  });
  if (!heads.length) return;
  table.querySelectorAll('tbody tr').forEach((tr) => {
    let col = 0;
    const cells = Array.from((tr as HTMLTableRowElement).cells);
    cells.forEach((td, i) => {
      const label = heads[col] || '';
      if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
      // 마지막 ‘관리’ 칸처럼 버튼만 모인 칸은 카드 아래 버튼 줄로 보여요.
      const actions =
        i === cells.length - 1 &&
        i > 0 &&
        ACTION_LABELS.has(label) &&
        !!td.querySelector('button, a');
      if (actions !== td.hasAttribute('data-actions')) td.toggleAttribute('data-actions', actions);
      col += td.colSpan || 1;
    });
  });
}

let queued = false;
function run() {
  queued = false;
  document.querySelectorAll<HTMLTableElement>('table.management-table').forEach(labelTable);
}

export function installTableLabels() {
  if (
    typeof MutationObserver === 'undefined' ||
    (window as { __tableLabels?: boolean }).__tableLabels
  )
    return;
  (window as { __tableLabels?: boolean }).__tableLabels = true;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  run();
}
