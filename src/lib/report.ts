import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { GroupSummary } from '@/data/types';
import { money, prettyDate, todayISO } from './format';
import { buildXlsx, Cell } from './xlsx';
import { safeFileName, shareFile } from './files';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function reportHtml(s: GroupSummary) {
  const cur = s.group.currency;
  const name = (id: number) => s.members.find((m) => m.id === id)?.name ?? 'Unknown';
  const statRows = s.stats
    .map(
      (st) => `<tr><td>${esc(st.name)}</td><td>${money(st.totalPaid, cur)}</td><td>${money(st.totalBenefit, cur)}</td>
      <td>${money(st.paymentsMade, cur)}</td><td>${money(st.paymentsReceived, cur)}</td>
      <td class="${st.balance > 0 ? 'pos' : st.balance < 0 ? 'neg' : ''}">${money(st.balance, cur, { sign: true })}</td></tr>`
    )
    .join('');
  const settleRows = s.settlements.length
    ? s.settlements.map((x) => `<tr><td>${esc(name(x.from))}</td><td>${esc(name(x.to))}</td><td>${money(x.amount, cur)}</td></tr>`).join('')
    : '<tr><td colspan="3">Everyone is settled up 🎉</td></tr>';
  const txRows = s.transactions
    .map((t) => {
      const title = t.type === 'payment' ? `Payment: ${name(t.paidBy)} → ${name(t.splits[0]?.memberId ?? 0)}` : t.title;
      const split = t.type === 'payment' ? '' : t.splits.map((x) => `${esc(name(x.memberId))}: ${money(x.share, cur)}`).join(', ');
      return `<tr><td>${prettyDate(t.date)}</td><td>${esc(title)}</td><td>${esc(t.category)}</td><td>${esc(name(t.paidBy))}</td><td>${money(t.amount, cur)}</td><td class="small">${split}</td></tr>`;
    })
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${esc(s.group.name)} report</title>
  <style>
    body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;padding:24px}
    h1{color:#0F766E;margin:0 0 4px} h2{margin-top:28px;font-size:16px;color:#0F766E}
    table{width:100%;border-collapse:collapse;font-size:12px} th,td{border:1px solid #ddd;padding:6px;text-align:left}
    th{background:#F0FDFA} .pos{color:#15803D;font-weight:700} .neg{color:#B91C1C;font-weight:700} .small{font-size:11px;color:#444}
    .meta{color:#555;font-size:13px}
  </style></head><body>
  <h1>${esc(s.group.name)}</h1>
  <div class="meta">Total expenses: <b>${money(s.totals.totalExpenses, cur)}</b> · ${s.totals.expenseCount} expenses · ${s.totals.paymentCount} payments · Generated ${prettyDate(todayISO())}</div>
  <h2>Member summary</h2>
  <table><tr><th>Member</th><th>Paid</th><th>Share</th><th>Payments sent</th><th>Payments received</th><th>Balance</th></tr>${statRows}</table>
  <h2>Suggested settlements</h2>
  <table><tr><th>From</th><th>To</th><th>Amount</th></tr>${settleRows}</table>
  <h2>All transactions</h2>
  <table><tr><th>Date</th><th>Title</th><th>Category</th><th>Paid by</th><th>Amount</th><th>Split</th></tr>${txRows || '<tr><td colspan="6">No transactions yet</td></tr>'}</table>
  </body></html>`;
}

export async function printReport(s: GroupSummary) {
  const html = reportHtml(s);
  if (Platform.OS === 'web') {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow!.document;
    doc.open();
    doc.write(html);
    doc.close();
    setTimeout(() => {
      iframe.contentWindow!.focus();
      iframe.contentWindow!.print();
      setTimeout(() => iframe.remove(), 1000);
    }, 250);
    return;
  }
  await Print.printAsync({ html });
}

export async function sharePdf(s: GroupSummary) {
  if (Platform.OS === 'web') return printReport(s);
  const { uri } = await Print.printToFileAsync({ html: reportHtml(s) });
  await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Share report' });
}

/** Builds the Excel report on the phone and opens the share sheet. */
export async function exportExcel(s: GroupSummary) {
  const { group, members, stats, settlements, transactions, totals, categories } = s;
  const name = (id: number) => members.find((m) => m.id === id)?.name ?? 'Unknown';
  const m = (c: number) => Math.round(c) / 100;
  const rows: Cell[][] = [
    [`${group.name} — Expense Report`],
    [`Currency: ${group.currency}`],
    [`Total expenses: ${m(totals.totalExpenses).toFixed(2)}`],
    [`Generated: ${todayISO()}`],
    [],
  ];
  const bold: number[] = [rows.length];
  rows.push(['Member', 'Total Paid (expenses)', 'Payments Made', 'Payments Received', 'Share of Expenses', 'Balance', 'Status']);
  for (const st of stats) {
    rows.push([st.name, m(st.totalPaid), m(st.paymentsMade), m(st.paymentsReceived), m(st.totalBenefit), m(st.balance), st.balance > 0 ? 'Gets back' : st.balance < 0 ? 'Owes' : 'Settled']);
  }
  rows.push([]);
  bold.push(rows.length);
  rows.push(['Suggested settlements']);
  if (!settlements.length) rows.push(['Everyone is settled up']);
  for (const x of settlements) rows.push([`${name(x.from)} pays ${name(x.to)}`, m(x.amount)]);
  rows.push([]);
  bold.push(rows.length);
  rows.push(['Spending by category']);
  for (const c of categories) rows.push([c.name, m(c.amount)]);

  const txRows: Cell[][] = [['Date', 'Type', 'Title', 'Category', 'Paid By', 'Amount', 'Split', ...members.map((x) => x.name), 'Note']];
  for (const tx of [...transactions].reverse()) {
    txRows.push([
      tx.date,
      tx.type === 'payment' ? 'Payment' : 'Expense',
      tx.type === 'payment' ? `${name(tx.paidBy)} → ${name(tx.splits[0]?.memberId ?? 0)}` : tx.title,
      tx.category,
      name(tx.paidBy),
      m(tx.amount),
      tx.type === 'payment' ? '-' : tx.splitType,
      ...members.map((mem) => {
        const sp = tx.splits.find((x) => x.memberId === mem.id);
        return sp ? m(sp.share) : null;
      }),
      tx.note,
    ]);
  }
  const bytes = buildXlsx([
    { name: 'Summary', rows, bold, title: [0], widths: [28, 20, 18, 18, 18, 14, 12] },
    { name: 'Transactions', rows: txRows, bold: [0], widths: [12, 10, 30, 14, 16, 12, 10, ...members.map(() => 14), 30] },
  ]);
  await shareFile(bytes, `${safeFileName(group.name)}-report.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Export to Excel');
}
