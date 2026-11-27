/* 日程調整アプリ: 画面に依存しない純粋なロジック（node単体でテストできる） */

export const SLOTS = ["3限", "4限", "5限", "19時以降", "21時以降", "23時以降"];
export const ALL_MASK = (1 << SLOTS.length) - 1; // 0b111111

/* 保存データのビット位置（SLOTSと同じ並び順で指定する）。
   19時以降は後から追加したので bit5 を使う。こうすると、追加前に保存された
   回答の 21時以降(bit3)・23時以降(bit4) がずれない。 */
const STORE_BIT = [0, 1, 2, 5, 3, 4];

/* 画面用のマスク（bit順＝表示順）→ 保存用の値 */
export function encodeMask(mask) {
  return STORE_BIT.reduce((out, bit, i) => (mask & (1 << i) ? out | (1 << bit) : out), 0);
}
/* 保存用の値 → 画面用のマスク */
export function decodeMask(stored) {
  return STORE_BIT.reduce((out, bit, i) => (stored & (1 << bit) ? out | (1 << i) : out), 0);
}
/* {日付: 値} をまとめて変換する。0になる日は含めない */
export function mapDays(days, convert) {
  const out = {};
  for (const [date, value] of Object.entries(days || {})) {
    const v = convert(value);
    if (v) out[date] = v;
  }
  return out;
}
export const MAX_DAYS = 31;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/* あるボタンを押したときの新しい選択状態を返す。
   選択状態は画面用の6ビットのマスク（bit0=3限 … bit5=23時以降）。
   - 押したボタンが未選択 → そのボタンとそれ以降をすべて選択
   - 押したボタンが選択済み → そのボタンとそれ以降をすべて解除 */
export function toggleSlot(mask, i) {
  const fromI = ALL_MASK & ~((1 << i) - 1); // i番目以降のビット
  return mask & (1 << i) ? mask & ~fromI : mask | fromI;
}

/* "YYYY-MM-DD" ⇄ Date（タイムゾーンずれを避けるためローカル日付で扱う） */
export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function pad(n) {
  return String(n).padStart(2, "0");
}
export function formatDate(d) {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/* 開始日〜終了日（両端を含む）の日付文字列の配列。不正なら null */
export function dateRange(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const s = parseDate(start);
  const e = parseDate(end);
  if (isNaN(s) || isNaN(e) || e < s) return null;
  const out = [];
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(formatDate(d));
    if (out.length > MAX_DAYS) return null;
  }
  return out;
}

/* 表示用ラベル。weekday は 0=日 … 6=土 */
export function dayLabel(dateStr) {
  const d = parseDate(dateStr);
  return {
    text: d.getMonth() + 1 + "/" + d.getDate() + "(" + WEEK[d.getDay()] + ")",
    weekday: d.getDay(),
  };
}

/* 集計: 日付×時間帯ごとの「空いている人」と「空いていない人」の名前 */
export function tally(dates, responses) {
  return dates.map((date) =>
    SLOTS.map((_, i) => {
      const free = [];
      const busy = [];
      for (const r of responses) {
        const mask = (r.days && r.days[date]) || 0;
        (mask & (1 << i) ? free : busy).push(r.name);
      }
      return { free, busy };
    })
  );
}

/* おすすめ順: 人数が多い順 → 日付が早い順 → 時間帯が早い順。人数0は除外 */
export function ranking(dates, table, limit) {
  const list = [];
  table.forEach((row, di) =>
    row.forEach((cell, si) => {
      if (cell.free.length > 0) list.push({ date: dates[di], slot: si, n: cell.free.length });
    })
  );
  list.sort((a, b) => b.n - a.n || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.slot - b.slot);
  return list.slice(0, limit);
}
